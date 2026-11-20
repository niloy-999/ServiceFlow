import { Injectable } from "@nestjs/common";

import { PrismaService } from "../database/prisma.service.js";

interface MembershipDiscoveryRow {
  membership_id: string;
  membership_status: string;
  business_id: string;
  business_name: string;
  business_slug: string;
  currency: string;
  timezone: string;
}

@Injectable()
export class MembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveMemberships(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${userId}, true)
      `;

      const rows = await tx.$queryRaw<MembershipDiscoveryRow[]>`
        SELECT
          tm.id AS membership_id,
          tm.status AS membership_status,
          b.id AS business_id,
          b.name AS business_name,
          b.slug AS business_slug,
          b.default_currency AS currency,
          b.default_timezone AS timezone
        FROM tenant_memberships AS tm
        INNER JOIN users AS u
          ON u.id = tm.user_id
        INNER JOIN businesses AS b
          ON b.id = tm.tenant_id
        WHERE tm.user_id = ${userId}::uuid
          AND tm.status = 'ACTIVE'
          AND tm.left_at IS NULL
          AND u.status = 'ACTIVE'
          AND b.status = 'ACTIVE'
        ORDER BY b.name ASC, tm.id ASC
      `;

      return rows.map((row) => ({
        membershipId: row.membership_id,
        membershipStatus: row.membership_status,
        business: {
          id: row.business_id,
          name: row.business_name,
          slug: row.business_slug,
          currency: row.currency,
          timezone: row.timezone,
        },
      }));
    });
  }
}
