import { BadRequestException, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditEventInput {
  actorUserId: string;
  tenantId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  outcome: "SUCCESS" | "FAILURE";
}

@Injectable()
export class AuditService {
  async record(tx: Prisma.TransactionClient, event: AuditEventInput): Promise<string> {
    if (
      !UUID_PATTERN.test(event.actorUserId) ||
      (event.tenantId !== null && !UUID_PATTERN.test(event.tenantId))
    ) {
      throw new BadRequestException("Valid audit actor and tenant IDs are required.");
    }

    if (
      !event.action.trim() ||
      event.action.length > 120 ||
      !event.targetType.trim() ||
      event.targetType.length > 80 ||
      !event.targetId.trim() ||
      event.targetId.length > 160
    ) {
      throw new BadRequestException("Audit event fields are invalid.");
    }

    if (event.outcome !== "SUCCESS" && event.outcome !== "FAILURE") {
      throw new BadRequestException("Audit event outcome is invalid.");
    }

    const id = randomUUID();

    await tx.$executeRaw`
      INSERT INTO audit_events (
        id,
        actor_type,
        actor_user_id,
        tenant_id,
        action,
        target_type,
        target_id,
        outcome
      )
      VALUES (
        ${id}::uuid,
        'USER',
        ${event.actorUserId}::uuid,
        ${event.tenantId}::uuid,
        ${event.action},
        ${event.targetType},
        ${event.targetId},
        ${event.outcome}
      )
    `;

    return id;
  }

  async recordMfaVerificationFailure(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    challengeId: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(actorUserId) || !UUID_PATTERN.test(challengeId)) {
      throw new BadRequestException("Valid audit actor and challenge IDs are required.");
    }

    await this.record(tx, {
      actorUserId,
      tenantId: null,
      action: "auth.mfa.challenge_verification_failed",
      targetType: "MFA_CHALLENGE",
      targetId: challengeId,
      outcome: "FAILURE",
    });
  }

}
