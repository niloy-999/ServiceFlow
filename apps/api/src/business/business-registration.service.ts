import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { PrismaService } from "../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { GlobalIdentityContextService } from "../database/global-identity-context.service.js";
import { hasActivePlatformAdministrator } from "../identity/platform-admin-policy.js";

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
    private readonly identityContext: GlobalIdentityContextService,
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

  async activatePendingBusiness(
    platformAdminUserId: string,
    businessId: string,
    mfaVerifiedAt: Date | null,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(businessId)
    ) {
      throw new BadRequestException("A valid business ID is required.");
    }
    if (!mfaVerifiedAt)
      throw new UnauthorizedException("A recently MFA-verified session is required.");

    return this.identityContext.withGlobalIdentityContext(
      { userId: platformAdminUserId },
      async (tx) => {
        if (!(await hasActivePlatformAdministrator(tx, platformAdminUserId))) {
          throw new ForbiddenException("Platform administrator access is required.");
        }

        const businesses = await tx.$queryRaw<
          {
            id: string;
            name: string;
            status: string;
          }[]
        >`
          SELECT id, name, status
          FROM businesses
          WHERE id = ${businessId}::uuid
          FOR UPDATE
        `;
        const business = businesses[0];
        if (!business) throw new ConflictException("The business is unavailable for activation.");
        if (business.status !== "PENDING") {
          throw new ConflictException("Only pending businesses can be activated.");
        }

        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${businessId}, true)`;
        const applicants = await tx.$queryRaw<{ id: string; user_id: string }[]>`
          SELECT tm.id, tm.user_id
          FROM tenant_memberships AS tm
          INNER JOIN users AS u ON u.id = tm.user_id
          WHERE tm.tenant_id = ${businessId}::uuid
            AND tm.status = 'PENDING'
            AND tm.left_at IS NULL
            AND u.status = 'ACTIVE'
            AND u.email_verified_at IS NOT NULL
          ORDER BY tm.created_at, tm.id
          LIMIT 2
          FOR UPDATE OF tm
        `;
        if (applicants.length !== 1 || !applicants[0]) {
          throw new ConflictException("Exactly one eligible initial business owner is required.");
        }
        const owner = applicants[0];
        await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
        const mfaEligibility = await tx.$queryRaw<{ enabled: boolean }[]>`
          SELECT public.is_user_mfa_enabled_for_activation(${owner.user_id}::uuid) AS enabled
        `;
        if (!mfaEligibility[0]?.enabled) {
          throw new ConflictException("The initial owner must enroll in MFA before activation.");
        }
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${businessId}, true)`;

        const branchId = randomUUID();
        await tx.$executeRaw`
          INSERT INTO branches (id, tenant_id, code, name, status, updated_at)
          VALUES (${branchId}::uuid, ${businessId}::uuid, 'MAIN', ${business.name}, 'ACTIVE', CURRENT_TIMESTAMP)
        `;

        const roles: { code: string; name: string; id: string }[] = [
          { code: "OWNER", name: "Owner", id: randomUUID() },
          { code: "ADMIN", name: "Administrator", id: randomUUID() },
          { code: "BRANCH_MANAGER", name: "Branch manager", id: randomUUID() },
          { code: "INVENTORY_MANAGER", name: "Inventory manager", id: randomUUID() },
        ];
        for (const role of roles) {
          await tx.$executeRaw`
            INSERT INTO roles (id, tenant_id, name, is_system, status, template_code, updated_at)
            VALUES (${role.id}::uuid, ${businessId}::uuid, ${role.name}, true, 'ACTIVE', ${role.code}, CURRENT_TIMESTAMP)
          `;
        }

        const permissionRows = await tx.$queryRaw<{ code: string }[]>`SELECT code FROM permissions`;
        const allPermissions = permissionRows.map((row) => row.code);
        const templatePermissions: Record<string, string[]> = {
          OWNER: allPermissions.filter((code) => code !== "platform.tenant.activate"),
          ADMIN: allPermissions.filter((code) => code !== "platform.tenant.activate"),
          BRANCH_MANAGER: [
            "catalogue.read",
            "inventory.read",
            "inventory.adjust",
            "inventory.transfer.request",
            "inventory.transfer.dispatch",
            "inventory.transfer.receive",
          ],
          INVENTORY_MANAGER: [
            "catalogue.read",
            "inventory.read",
            "inventory.adjust",
            "inventory.receive",
            "supplier.read",
            "supplier.manage",
            "purchasing.read",
            "purchasing.manage",
            "inventory.transfer.request",
            "inventory.transfer.dispatch",
            "inventory.transfer.receive",
          ],
        };
        for (const role of roles) {
          for (const code of templatePermissions[role.code] ?? []) {
            await tx.$executeRaw`
              INSERT INTO role_permissions (tenant_id, role_id, permission_code)
              VALUES (${businessId}::uuid, ${role.id}::uuid, ${code})
            `;
          }
        }

        const now = new Date();
        await tx.$executeRaw`
          UPDATE tenant_memberships
          SET status = 'ACTIVE', joined_at = ${now}, updated_at = ${now}, version = version + 1
          WHERE tenant_id = ${businessId}::uuid AND id = ${owner.id}::uuid AND status = 'PENDING'
        `;
        await tx.$executeRaw`
          INSERT INTO membership_roles (tenant_id, membership_id, role_id)
          VALUES (${businessId}::uuid, ${owner.id}::uuid, ${roles[0]!.id}::uuid)
        `;
        await tx.$executeRaw`
          INSERT INTO membership_branch_scopes (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
          VALUES (${randomUUID()}::uuid, ${businessId}::uuid, ${owner.id}::uuid, 'BUSINESS', NULL, true, true)
        `;
        await tx.$executeRaw`
          UPDATE businesses SET status = 'ACTIVE', updated_at = ${now}, version = version + 1
          WHERE id = ${businessId}::uuid AND status = 'PENDING'
        `;
        await this.auditService.record(tx, {
          actorUserId: platformAdminUserId,
          tenantId: businessId,
          action: "business.activated",
          targetType: "business",
          targetId: businessId,
          outcome: "SUCCESS",
        });
        return { businessId, status: "ACTIVE", branchId, ownerMembershipId: owner.id };
      },
    );
  }
}
