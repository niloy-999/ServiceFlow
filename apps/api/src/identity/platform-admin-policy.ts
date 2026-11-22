import type { Prisma } from "../generated/prisma/client.js";

/**
 * Checks whether the user currently holds an active platform-administrator grant.
 * Call only inside the user's global identity context.
 */
export async function hasActivePlatformAdministrator(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const grant = await tx.platformAdministrator.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      revokedAt: null,
    },
    select: { id: true },
  });

  return grant !== null;
}
