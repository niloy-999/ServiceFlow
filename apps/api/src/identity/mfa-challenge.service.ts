import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { GlobalIdentityContextService } from "../database/global-identity-context.service.js";
import { MfaCryptoService } from "./mfa-crypto.service.js";
import { SessionService, type CreatedSession } from "./session.service.js";

interface LockedUser {
  id: string;
  status: string;
}

const INVALID_MFA_RESPONSE = "The MFA challenge or verification code is invalid.";

@Injectable()
export class MfaChallengeService {
  constructor(
    private readonly identityContext: GlobalIdentityContextService,
    private readonly mfaCrypto: MfaCryptoService,
    private readonly sessionService: SessionService,
    private readonly auditService: AuditService,
  ) {}

  async verify(
    challengeToken: string,
    code: string,
    userAgent?: string,
  ): Promise<CreatedSession> {
    if (
      typeof challengeToken !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(challengeToken) ||
      typeof code !== "string" ||
      !/^(?:\d{6}|[A-F0-9]{8}(?:-[A-F0-9]{8}){3})$/.test(code)
    ) {
      throw new UnauthorizedException(INVALID_MFA_RESPONSE);
    }

    const tokenHash = createHash("sha256").update(challengeToken).digest("hex");

    const result = await this.identityContext.withGlobalIdentityContext(
      { challengeTokenHash: tokenHash },
      async (tx) => {
        const now = new Date();

        // The challenge-hash RLS policy permits this initial lookup.
        const candidate = await tx.mfaChallenge.findFirst({
          where: {
            tokenHash,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true, userId: true },
        });

        if (!candidate) {
          throw new UnauthorizedException(INVALID_MFA_RESPONSE);
        }

        // Establish RLS identity before accessing the user row.
        await this.identityContext.setUserContext(tx, candidate.userId);

        // Serialize all MFA verification attempts for this account.
        const lockedUsers = await tx.$queryRaw<LockedUser[]>`
          SELECT id, status
          FROM users
          WHERE id = ${candidate.userId}::uuid
          FOR UPDATE
        `;

        if (lockedUsers[0]?.status !== "ACTIVE") {
          throw new UnauthorizedException(INVALID_MFA_RESPONSE);
        }

        // Re-read after acquiring the user lock to reject consumed or expired challenges.
        const challenge = await tx.mfaChallenge.findFirst({
          where: {
            id: candidate.id,
            userId: candidate.userId,
            tokenHash,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });

        if (!challenge) {
          throw new UnauthorizedException(INVALID_MFA_RESPONSE);
        }

        const mfa = await tx.userMfa.findUnique({
          where: { userId: candidate.userId },
          select: {
            status: true,
            encryptedSecret: true,
            enabledAt: true,
          },
        });

        if (
          !mfa ||
          mfa.status !== "ENABLED" ||
          !mfa.enabledAt ||
          mfa.enabledAt > now
        ) {
          throw new UnauthorizedException(INVALID_MFA_RESPONSE);
        }

        let factorAccepted = false;

        if (/^\d{6}$/.test(code)) {
          const secret = this.mfaCrypto.decryptSecret(Buffer.from(mfa.encryptedSecret));
          const matchedStep = this.mfaCrypto.verifyTotpCode(
            secret,
            code,
            now.getTime(),
          );

          if (matchedStep !== null) {
            const updatedRows = await tx.$queryRaw<Array<{ user_id: string }>>`
              UPDATE "user_mfa"
              SET
                "last_accepted_time_step" = ${BigInt(matchedStep)},
                "updated_at" = ${now}
              WHERE
                "user_id" = ${candidate.userId}::uuid
                AND "status" = 'ENABLED'
                AND "enabled_at" IS NOT NULL
                AND "enabled_at" <= ${now}
                AND (
                  "last_accepted_time_step" IS NULL
                  OR "last_accepted_time_step" < ${BigInt(matchedStep)}
                )
              RETURNING "user_id"
            `;

            factorAccepted = updatedRows.length === 1;
          }
        } else {
          let recoveryHash: string;

          try {
            recoveryHash = this.mfaCrypto.hashRecoveryCode(code);
          } catch {
            throw new UnauthorizedException(INVALID_MFA_RESPONSE);
          }

          const recoveryCode = await tx.mfaRecoveryCode.findFirst({
            where: {
              userId: candidate.userId,
              codeHash: recoveryHash,
              consumedAt: null,
            },
            select: { id: true },
          });

          if (recoveryCode) {
            const consumed = await tx.mfaRecoveryCode.updateMany({
              where: {
                id: recoveryCode.id,
                userId: candidate.userId,
                consumedAt: null,
              },
              data: { consumedAt: now },
            });

            factorAccepted = consumed.count === 1;
          }
        }

        if (!factorAccepted) {
          await this.auditService.recordMfaVerificationFailure(
            tx,
            candidate.userId,
            challenge.id,
          );
          return { kind: "INVALID" as const };
        }

        const consumedAt = new Date();

        const consumedChallenge = await tx.mfaChallenge.updateMany({
          where: {
            id: challenge.id,
            userId: candidate.userId,
            tokenHash,
            consumedAt: null,
            expiresAt: { gt: consumedAt },
          },
          data: { consumedAt },
        });

        if (consumedChallenge.count !== 1) {
          throw new UnauthorizedException(INVALID_MFA_RESPONSE);
        }

        await this.auditService.record(tx, {
          actorUserId: candidate.userId,
          tenantId: null,
          action: "auth.mfa.challenge_verified",
          targetType: "MFA_CHALLENGE",
          targetId: challenge.id,
          outcome: "SUCCESS",
        });

        return {
          kind: "SESSION" as const,
          session: await this.sessionService.createMfaVerifiedSession(
            tx,
            candidate.userId,
            userAgent,
          ),
        };
      },
    );

    if (result.kind === "INVALID") {
      throw new UnauthorizedException(INVALID_MFA_RESPONSE);
    }

    return result.session;
  }
}
