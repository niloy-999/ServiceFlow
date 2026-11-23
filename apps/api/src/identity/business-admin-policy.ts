import type { Prisma } from "../generated/prisma/client.js";

/** Call only in the authenticated user's global identity transaction. */
export async function hasActiveBusinessAdministratorRole(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const memberships = await tx.$queryRaw<{ tenant_id: string }[]>`
    SELECT tm.tenant_id
    FROM tenant_memberships AS tm
    INNER JOIN businesses AS b ON b.id = tm.tenant_id
    WHERE tm.user_id = ${userId}::uuid
      AND tm.status = 'ACTIVE'
      AND tm.left_at IS NULL
      AND b.status = 'ACTIVE'
  `;

  let isAdministrator = false;
  try {
    for (const membership of memberships) {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${membership.tenant_id}, true)`;
      const roles = await tx.$queryRaw<{ role_id: string }[]>`
      SELECT mr.role_id
      FROM membership_roles AS mr
      INNER JOIN roles AS r
        ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
      WHERE mr.tenant_id = ${membership.tenant_id}::uuid
        AND mr.membership_id IN (
          SELECT id FROM tenant_memberships
          WHERE tenant_id = ${membership.tenant_id}::uuid
            AND user_id = ${userId}::uuid
            AND status = 'ACTIVE' AND left_at IS NULL
        )
        AND r.status = 'ACTIVE'
        AND r.template_code IN ('OWNER', 'ADMIN')
      LIMIT 1
      `;

      if (roles.length > 0) {
        isAdministrator = true;
        break;
      }
    }
  } finally {
    await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
  }

  return isAdministrator;
}
