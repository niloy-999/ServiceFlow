import { BadRequestException, Injectable } from "@nestjs/common";

import { Prisma } from "../generated/prisma/client.js";

import { PrismaService } from "./prisma.service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface GlobalIdentityContextOptions {
  userId?: string;
  challengeTokenHash?: string;
}

@Injectable()
export class GlobalIdentityContextService {
  constructor(private readonly prisma: PrismaService) {}

  async withGlobalIdentityContext<T>(
    options: GlobalIdentityContextOptions,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const userId = options.userId ?? "";
    const challengeTokenHash = options.challengeTokenHash ?? "";

    if (userId && !UUID_PATTERN.test(userId)) {
      throw new BadRequestException("A valid user ID is required.");
    }

    if (challengeTokenHash && !SHA256_PATTERN.test(challengeTokenHash)) {
      throw new BadRequestException("A valid MFA challenge hash is required.");
    }

    if (!userId && !challengeTokenHash) {
      throw new BadRequestException("A user ID or MFA challenge hash is required.");
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${userId}, true)
      `;

      await tx.$queryRaw`
        SELECT set_config('app.tenant_id', '', true)
      `;

      await tx.$queryRaw`
        SELECT set_config(
          'app.mfa_challenge_hash',
          ${challengeTokenHash},
          true
        )
      `;

      return callback(tx);
    });
  }

  async setUserContext(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    if (!UUID_PATTERN.test(userId)) {
      throw new BadRequestException("A valid user ID is required.");
    }

    await tx.$queryRaw`
      SELECT set_config('app.user_id', ${userId}, true)
    `;
  }
}
