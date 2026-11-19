import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";

import { Prisma } from "../generated/prisma/client.js";

import { PrismaService } from "./prisma.service.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantContextService {
  constructor(private readonly prisma: PrismaService) {}

  async withAuthorizedTenantContext<T>(
    userId: string,
    tenantId: string,
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(tenantId)) {
      throw new BadRequestException("Valid user and tenant IDs are required.");
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${userId}, true)
      `;

      const memberships = await tx.$queryRaw<{ membership_id: string }[]>`
        SELECT tm.id AS membership_id
        FROM tenant_memberships AS tm
        INNER JOIN users AS u
          ON u.id = tm.user_id
        INNER JOIN businesses AS b
          ON b.id = tm.tenant_id
        WHERE tm.user_id = ${userId}::uuid
          AND tm.tenant_id = ${tenantId}::uuid
          AND tm.status = 'ACTIVE'
          AND tm.left_at IS NULL
          AND u.status = 'ACTIVE'
          AND b.status = 'ACTIVE'
        LIMIT 1
      `;

      if (memberships.length === 0) {
        throw new ForbiddenException("You do not have an active membership in this business.");
      }

      await tx.$queryRaw`
        SELECT set_config('app.tenant_id', ${tenantId}, true)
      `;

      return callback(tx);
    });
  }
}
