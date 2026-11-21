import { ForbiddenException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

interface CreatedBusinessRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  currency: string;
  timezone: string;
}

function createBusinessSlug(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "business";

  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

  return `${base}-${suffix}`;
}

@Injectable()
export class BusinessRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async register(userId: string, businessName: string) {
    const name = businessName.trim();
    const businessId = randomUUID();
    const membershipId = randomUUID();
    const slug = createBusinessSlug(name);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${userId}, true)
      `;

      const eligibleUsers = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM users
        WHERE id = ${userId}::uuid
          AND status = 'ACTIVE'
          AND email_verified_at IS NOT NULL
        FOR UPDATE
      `;

      if (eligibleUsers.length === 0) {
        throw new ForbiddenException(
          "An active account with a verified email is required to register a business.",
        );
      }

      const businesses = await tx.$queryRaw<CreatedBusinessRow[]>`
        INSERT INTO businesses (
          id,
          name,
          slug,
          status,
          updated_at
        )
        VALUES (
          ${businessId}::uuid,
          ${name},
          ${slug},
          'PENDING',
          CURRENT_TIMESTAMP
        )
        RETURNING
          id,
          name,
          slug,
          status,
          default_currency AS currency,
          default_timezone AS timezone
      `;

      await tx.$queryRaw`
        SELECT set_config('app.tenant_id', ${businessId}, true)
      `;

      await tx.$executeRaw`
        INSERT INTO tenant_memberships (
          id,
          tenant_id,
          user_id,
          status,
          updated_at
        )
        VALUES (
          ${membershipId}::uuid,
          ${businessId}::uuid,
          ${userId}::uuid,
          'PENDING',
          CURRENT_TIMESTAMP
        )
      `;

      const business = businesses[0];

      if (!business) {
        throw new Error("Business registration did not return the created business.");
      }

      await this.auditService.record(tx, {
        actorUserId: userId,
        tenantId: businessId,
        action: "business.registration.submitted",
        targetType: "business",
        targetId: businessId,
        outcome: "SUCCESS",
      });

      return {
        membershipId,
        membershipStatus: "PENDING",
        business: {
          id: business.id,
          name: business.name,
          slug: business.slug,
          status: business.status,
          currency: business.currency,
          timezone: business.timezone,
        },
      };
    });
  }

  async listRegistrations(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${userId}, true)
      `;

      const rows = await tx.$queryRaw<
        {
          membership_id: string;
          membership_status: string;
          business_id: string;
          business_name: string;
          business_slug: string;
          business_status: string;
          currency: string;
          timezone: string;
        }[]
      >`
        SELECT
          tm.id AS membership_id,
          tm.status AS membership_status,
          b.id AS business_id,
          b.name AS business_name,
          b.slug AS business_slug,
          b.status AS business_status,
          b.default_currency AS currency,
          b.default_timezone AS timezone
        FROM tenant_memberships AS tm
        INNER JOIN businesses AS b
          ON b.id = tm.tenant_id
        WHERE tm.user_id = ${userId}::uuid
        ORDER BY tm.created_at DESC, tm.id ASC
      `;

      return rows.map((row) => ({
        membershipId: row.membership_id,
        membershipStatus: row.membership_status,
        business: {
          id: row.business_id,
          name: row.business_name,
          slug: row.business_slug,
          status: row.business_status,
          currency: row.currency,
          timezone: row.timezone,
        },
      }));
    });
  }
}
