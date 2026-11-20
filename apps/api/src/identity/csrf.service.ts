import { Injectable, InternalServerErrorException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

const CSRF_SECRET_PATTERN = /^[a-fA-F0-9]{64}$/;
const CSRF_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

@Injectable()
export class CsrfService {
  private readonly secret: Buffer;

  constructor() {
    const configuredSecret = process.env.CSRF_HMAC_SECRET;

    if (!configuredSecret || !CSRF_SECRET_PATTERN.test(configuredSecret)) {
      throw new InternalServerErrorException(
        "CSRF_HMAC_SECRET must be a 64-character hexadecimal value.",
      );
    }

    this.secret = Buffer.from(configuredSecret, "hex");
  }

  generateToken(sessionToken: string): string {
    return createHmac("sha256", this.secret)
      .update("serviceflow:csrf:v1\0")
      .update(sessionToken)
      .digest("hex");
  }

  verifyToken(sessionToken: string, suppliedToken: string): boolean {
    if (!CSRF_TOKEN_PATTERN.test(suppliedToken)) {
      return false;
    }

    const expected = Buffer.from(this.generateToken(sessionToken), "hex");
    const supplied = Buffer.from(suppliedToken, "hex");

    return timingSafeEqual(expected, supplied);
  }
}
