import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";

import { TenantContextService } from "../database/tenant-context.service.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PERMISSION_CODE_SET, type PermissionCode } from "./permission-catalogue.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PermissionCheck = {
  userId: string;
  tenantId: string;
  permission: PermissionCode;
  branchId?: string;
  operation?: "VIEW" | "OPERATE";
};

@Injectable()
export class AuthorizationService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async assertPermissionInTransaction(
    tx: Prisma.TransactionClient,
    input: PermissionCheck,
  ): Promise<void> {
    if (!PERMISSION_CODE_SET.has(input.permission)) {
      throw new ForbiddenException("The requested capability is not registered.");
    }

    if (
      !UUID_PATTERN.test(input.userId) ||
      !UUID_PATTERN.test(input.tenantId) ||
      (input.branchId !== undefined && !UUID_PATTERN.test(input.branchId))
    ) {
      throw new BadRequestException("Valid user, tenant, and branch IDs are required.");
    }

    // Bind the requested authorization identity to the active transaction context.
    const context = await tx.$queryRaw<{ userId: string | null; tenantId: string | null }[]>`
      SELECT
        NULLIF(current_setting('app.user_id', true), '') AS "userId",
        NULLIF(current_setting('app.tenant_id', true), '') AS "tenantId"
    `;

    if (
      context[0]?.userId?.toLowerCase() !== input.userId.toLowerCase() ||
      context[0]?.tenantId?.toLowerCase() !== input.tenantId.toLowerCase()
    ) {
      throw new ForbiddenException(
        "The authorization identity does not match the active tenant context.",
      );
    }

    const membership = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM tenant_memberships
      WHERE tenant_id = ${input.tenantId}::uuid
        AND user_id = ${input.userId}::uuid
        AND status = 'ACTIVE'
        AND left_at IS NULL
      LIMIT 1
    `;

    const current = membership[0];

    if (!current) {
      throw new ForbiddenException("An active business membership is required.");
    }

    const granted = await tx.$queryRaw<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM membership_roles AS mr
        INNER JOIN roles AS r
          ON r.tenant_id = mr.tenant_id
          AND r.id = mr.role_id
          AND r.status = 'ACTIVE'
        INNER JOIN role_permissions AS rp
          ON rp.tenant_id = r.tenant_id
          AND rp.role_id = r.id
        WHERE mr.tenant_id = ${input.tenantId}::uuid
          AND mr.membership_id = ${current.id}::uuid
          AND rp.permission_code = ${input.permission}
      ) AS allowed
    `;

    if (!granted[0]?.allowed) {
      throw new ForbiddenException("The required business permission is missing.");
    }

    if (input.branchId) {
      const branch = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM branches
        WHERE tenant_id = ${input.tenantId}::uuid
          AND id = ${input.branchId}::uuid
          AND status = 'ACTIVE'
      `;

      if (branch.length !== 1) {
        throw new ForbiddenException("The branch is unavailable in this business.");
      }
    }

    // Branch scope is evaluated below using a parameterized query.
    // Kept separate from the permission query so every check uses the same transaction.
    const scoped = input.branchId
      ? await tx.$queryRaw<{ allowed: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM membership_branch_scopes
            WHERE tenant_id = ${input.tenantId}::uuid
              AND membership_id = ${current.id}::uuid
              AND (
                scope_type = 'BUSINESS'
                OR (
                  scope_type = 'BRANCH'
                  AND branch_id = ${input.branchId}::uuid
                )
              )
              AND CASE
                WHEN ${input.operation ?? "VIEW"} = 'OPERATE' THEN can_operate
                ELSE can_view
              END
          ) AS allowed
        `
      : await tx.$queryRaw<{ allowed: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM membership_branch_scopes
            WHERE tenant_id = ${input.tenantId}::uuid
              AND membership_id = ${current.id}::uuid
              AND scope_type = 'BUSINESS'
              AND CASE
                WHEN ${input.operation ?? "VIEW"} = 'OPERATE' THEN can_operate
                ELSE can_view
              END
          ) AS allowed
        `;

    if (!scoped[0]?.allowed) {
      throw new ForbiddenException(
        input.branchId
          ? "The required branch scope is missing."
          : "Business-wide visibility or operation scope is required.",
      );
    }
  }

  async withPermission<T>(
    input: PermissionCheck & {
      callback: (tx: Prisma.TransactionClient) => Promise<T>;
    },
  ): Promise<T> {
    return this.tenantContext.withAuthorizedTenantContext(
      input.userId,
      input.tenantId,
      async (tx) => {
        await this.assertPermissionInTransaction(tx, input);
        return input.callback(tx);
      },
    );
  }
}
