import { Injectable } from "@nestjs/common";
import { createHmac } from "node:crypto";
import { PrismaService } from "../database/prisma.service.js";

interface RateLimitBucketResult {
  hit_count: number;
  retry_after_seconds: number;
}

interface ConsumeRateLimitInput {
  operation: string;
  dimension: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
}

@Injectable()
export class RateLimitService {
  private readonly secret: Buffer;

  constructor(private readonly prisma: PrismaService) {
    const configuredSecret = process.env.RATE_LIMIT_HMAC_SECRET;

    if (!configuredSecret || !/^[0-9a-f]{64}$/.test(configuredSecret)) {
      throw new Error("RATE_LIMIT_HMAC_SECRET must be a 256-bit lowercase hexadecimal value.");
    }

    this.secret = Buffer.from(configuredSecret, "hex");
  }

  async consume(input: ConsumeRateLimitInput): Promise<{
    allowed: boolean;
    retryAfterSeconds: number;
  }> {
    const { operation, dimension, identifier, limit, windowSeconds } = input;

    if (
      !operation ||
      !dimension ||
      !identifier ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds < 1
    ) {
      throw new RangeError("Invalid rate-limit configuration or identifier.");
    }

    const keyHash = createHmac("sha256", this.secret)
      .update(`v1\0${operation}\0${dimension}\0${windowSeconds}\0${identifier}`)
      .digest("hex");

    const rows = await this.prisma.$queryRaw<RateLimitBucketResult[]>`
      WITH bucket AS (
        SELECT to_timestamp(
          floor(extract(epoch FROM clock_timestamp()) / ${windowSeconds})
          * ${windowSeconds}
        ) AS window_start
      ),
      updated AS (
        INSERT INTO "rate_limit_buckets" (
          "key_hash",
          "window_start",
          "hit_count",
          "expires_at"
        )
        SELECT
          ${keyHash}::char(64),
          window_start,
          1,
          window_start + make_interval(secs => ${windowSeconds})
        FROM bucket
        ON CONFLICT ("key_hash", "window_start")
        DO UPDATE SET
          "hit_count" = LEAST(
            "rate_limit_buckets"."hit_count" + 1,
            ${limit + 1}
          )
        RETURNING "hit_count", "expires_at"
      )
      SELECT
        "hit_count",
        GREATEST(
          1,
          CEIL(EXTRACT(EPOCH FROM ("expires_at" - clock_timestamp())))
        )::INTEGER AS "retry_after_seconds"
      FROM updated
    `;

    const result = rows[0];

    if (!result) {
      throw new Error("Rate-limit counter update returned no result.");
    }

    return {
      allowed: result.hit_count <= limit,
      retryAfterSeconds: result.retry_after_seconds,
    };
  }
}
