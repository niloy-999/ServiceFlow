import { Injectable, UnauthorizedException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { GlobalIdentityContextService } from "../database/global-identity-context.service.js";
import { hasActivePlatformAdministrator } from "./platform-admin-policy.js";
import { MfaCryptoService } from "./mfa-crypto.service.js";
import { PasswordService } from "./password.service.js";

const ENROLLMENT_LIFETIME_MS = 10 * 60 * 1000;
const MFA_ISSUER = "ServiceFlow";

interface LockedEnrollmentUser {
  id: string;
  email_normalized: string;
  password_hash: string;
  status: string;
  email_verified_at: Date | null;
}

interface ActivationResult {
  enabled_at: Date;
}

@Injectable()
export class MfaEnrollmentService {
  constructor(
    private readonly identityContext: GlobalIdentityContextService,
    private readonly passwordService: PasswordService,
    private readonly mfaCrypto: MfaCryptoService,
    private readonly auditService: AuditService,
  ) {}

  async startEnrollment(
    userId: string,
    password: string,
  ): Promise<{ provisioningUri: string; expiresAt: Date }> {
    const secret = this.mfaCrypto.generateTotpSecret();
    const encryptedSecret = Uint8Array.from(this.mfaCrypto.encryptSecret(secret));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_LIFETIME_MS);

    const result = await this.identityContext.withGlobalIdentityContext({ userId }, async (tx) => {
      const users = await tx.$queryRaw<LockedEnrollmentUser[]>`
          SELECT id, email_normalized, password_hash, status, email_verified_at
          FROM users
          WHERE id = ${userId}::uuid
          FOR UPDATE
        `;
      const user = users[0];

      if (
        !user ||
        user.status !== "ACTIVE" ||
        user.email_verified_at === null ||
        !(await this.passwordService.verifyPassword(password, user.password_hash))
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.enrollment_failed",
          targetType: "MFA_ENROLLMENT",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const existing = await tx.mfaEnrollment.findUnique({
        where: { userId },
        select: { id: true },
      });

      if (existing) {
        await tx.mfaEnrollment.update({
          where: { userId },
          data: {
            encryptedSecret,
            expiresAt,
            updatedAt: now,
          },
        });
      } else {
        await tx.mfaEnrollment.create({
          data: {
            id: randomUUID(),
            userId,
            encryptedSecret,
            expiresAt,
            updatedAt: now,
          },
        });
      }

      const enrollment = await tx.mfaEnrollment.findUniqueOrThrow({
        where: { userId },
        select: { id: true },
      });

      await this.auditService.record(tx, {
        actorUserId: userId,
        tenantId: null,
        action: "auth.mfa.enrollment_started",
        targetType: "MFA_ENROLLMENT",
        targetId: enrollment.id,
        outcome: "SUCCESS",
      });

      return {
        kind: "STARTED" as const,
        email: user.email_normalized,
      };
    });

    if (result.kind !== "STARTED") {
      throw new UnauthorizedException("Password verification failed.");
    }

    return {
      provisioningUri: this.mfaCrypto.createTotpProvisioningUri(secret, result.email, MFA_ISSUER),
      expiresAt,
    };
  }

  async confirmEnrollment(
    userId: string,
    password: string,
    pendingCode: string,
    currentCode?: string,
  ): Promise<{ enabledAt: Date; replaced: boolean }> {
    const result = await this.identityContext.withGlobalIdentityContext({ userId }, async (tx) => {
      const users = await tx.$queryRaw<LockedEnrollmentUser[]>`
          SELECT id, email_normalized, password_hash, status, email_verified_at
          FROM users
          WHERE id = ${userId}::uuid
          FOR UPDATE
        `;
      const user = users[0];

      if (
        !user ||
        user.status !== "ACTIVE" ||
        user.email_verified_at === null ||
        !(await this.passwordService.verifyPassword(password, user.password_hash))
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.enrollment_confirmation_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const now = new Date();
      const enrollment = await tx.mfaEnrollment.findUnique({
        where: { userId },
        select: {
          id: true,
          encryptedSecret: true,
          expiresAt: true,
        },
      });

      if (!enrollment || enrollment.expiresAt <= now) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.enrollment_confirmation_failed",
          targetType: "MFA_ENROLLMENT",
          targetId: enrollment?.id ?? userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const activeMfa = await tx.userMfa.findUnique({
        where: { userId },
        select: {
          status: true,
          encryptedSecret: true,
          lastAcceptedTimeStep: true,
        },
      });

      const replacing = activeMfa?.status === "ENABLED";
      let currentStep: number | null = null;

      // Verify the existing factor first, but do not consume its step yet.
      if (replacing) {
        if (!currentCode) {
          await this.auditService.record(tx, {
            actorUserId: userId,
            tenantId: null,
            action: "auth.mfa.enrollment_confirmation_failed",
            targetType: "USER_MFA",
            targetId: userId,
            outcome: "FAILURE",
          });
          return { kind: "INVALID" as const };
        }

        const activeSecret = this.mfaCrypto.decryptSecret(Buffer.from(activeMfa.encryptedSecret));

        currentStep = this.mfaCrypto.verifyTotpCode(activeSecret, currentCode, now.getTime());

        if (
          currentStep === null ||
          (activeMfa.lastAcceptedTimeStep !== null &&
            BigInt(currentStep) <= activeMfa.lastAcceptedTimeStep)
        ) {
          await this.auditService.record(tx, {
            actorUserId: userId,
            tenantId: null,
            action: "auth.mfa.enrollment_confirmation_failed",
            targetType: "USER_MFA",
            targetId: userId,
            outcome: "FAILURE",
          });
          return { kind: "INVALID" as const };
        }
      }

      // Verify the pending authenticator before changing any replay state.
      const pendingSecret = this.mfaCrypto.decryptSecret(Buffer.from(enrollment.encryptedSecret));
      const pendingStep = this.mfaCrypto.verifyTotpCode(pendingSecret, pendingCode, now.getTime());

      if (pendingStep === null) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.enrollment_confirmation_failed",
          targetType: "MFA_ENROLLMENT",
          targetId: enrollment.id,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      // Consume the existing factor's accepted step only after both
      // factors have been verified. The conditional update is replay-safe.
      if (replacing && currentStep !== null) {
        const updated = await tx.$queryRaw<{ user_id: string }[]>`
            UPDATE user_mfa
            SET
              last_accepted_time_step = ${BigInt(currentStep)},
              updated_at = ${now}
            WHERE user_id = ${userId}::uuid
              AND status = 'ENABLED'
              AND (
                last_accepted_time_step IS NULL
                OR last_accepted_time_step < ${BigInt(currentStep)}
              )
            RETURNING user_id
          `;

        if (updated.length !== 1) {
          await this.auditService.record(tx, {
            actorUserId: userId,
            tenantId: null,
            action: "auth.mfa.enrollment_confirmation_failed",
            targetType: "USER_MFA",
            targetId: userId,
            outcome: "FAILURE",
          });
          return { kind: "INVALID" as const };
        }
      }

      const activation = await tx.$queryRaw<ActivationResult[]>`
          SELECT public.activate_mfa_enrollment(
            ${userId}::uuid,
            ${enrollment.id}::uuid,
            ${BigInt(pendingStep)}
          ) AS enabled_at
        `;

      const activationResult = activation[0];
      if (activation.length !== 1 || !activationResult) {
        throw new Error("MFA activation returned an unexpected result.");
      }

      const enabledAt = activationResult.enabled_at;

      await this.auditService.record(tx, {
        actorUserId: userId,
        tenantId: null,
        action: replacing ? "auth.mfa.authenticator_replaced" : "auth.mfa.enabled",
        targetType: "USER_MFA",
        targetId: userId,
        outcome: "SUCCESS",
      });

      return {
        kind: "CONFIRMED" as const,
        enabledAt,
        replaced: replacing,
      };
    });

    if (result.kind !== "CONFIRMED") {
      throw new UnauthorizedException("MFA enrollment confirmation failed.");
    }

    return {
      enabledAt: result.enabledAt,
      replaced: result.replaced,
    };
  }

  async regenerateRecoveryCodes(
    userId: string,
    password: string,
    currentCode: string,
  ): Promise<{ recoveryCodes: string[]; regeneratedAt: Date }> {
    const recoveryCodes = Array.from({ length: 10 }, () => this.mfaCrypto.generateRecoveryCode());
    const recoveryCodeHashes = recoveryCodes.map((code) => this.mfaCrypto.hashRecoveryCode(code));

    const result = await this.identityContext.withGlobalIdentityContext({ userId }, async (tx) => {
      const users = await tx.$queryRaw<LockedEnrollmentUser[]>`
          SELECT id, email_normalized, password_hash, status, email_verified_at
          FROM users
          WHERE id = ${userId}::uuid
          FOR UPDATE
        `;

      const user = users[0];

      if (
        !user ||
        user.status !== "ACTIVE" ||
        user.email_verified_at === null ||
        !(await this.passwordService.verifyPassword(password, user.password_hash))
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.recovery_codes_regeneration_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });

        return { kind: "INVALID" as const };
      }

      const now = new Date();

      const activeMfa = await tx.userMfa.findUnique({
        where: { userId },
        select: {
          status: true,
          encryptedSecret: true,
          lastAcceptedTimeStep: true,
        },
      });

      if (!activeMfa || activeMfa.status !== "ENABLED") {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.recovery_codes_regeneration_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });

        return { kind: "INVALID" as const };
      }

      const activeSecret = this.mfaCrypto.decryptSecret(Buffer.from(activeMfa.encryptedSecret));

      const currentStep = this.mfaCrypto.verifyTotpCode(activeSecret, currentCode, now.getTime());

      if (
        currentStep === null ||
        (activeMfa.lastAcceptedTimeStep !== null &&
          BigInt(currentStep) <= activeMfa.lastAcceptedTimeStep)
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.recovery_codes_regeneration_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });

        return { kind: "INVALID" as const };
      }

      // Consume the accepted TOTP step before replacing the recovery batch.
      const updated = await tx.$queryRaw<{ user_id: string }[]>`
          UPDATE user_mfa
          SET
            last_accepted_time_step = ${BigInt(currentStep)},
            updated_at = ${now}
          WHERE user_id = ${userId}::uuid
            AND status = 'ENABLED'
            AND (
              last_accepted_time_step IS NULL
              OR last_accepted_time_step < ${BigInt(currentStep)}
            )
          RETURNING user_id
        `;

      if (updated.length !== 1) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.recovery_codes_regeneration_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });

        return { kind: "INVALID" as const };
      }

      // Existing codes are invalidated atomically with the new batch.
      await tx.mfaRecoveryCode.updateMany({
        where: {
          userId,
          consumedAt: null,
        },
        data: {
          consumedAt: now,
        },
      });

      const inserted = await tx.mfaRecoveryCode.createMany({
        data: recoveryCodeHashes.map((codeHash) => ({
          id: randomUUID(),
          userId,
          codeHash,
        })),
      });

      if (inserted.count !== recoveryCodeHashes.length) {
        throw new Error("Recovery-code batch insertion was incomplete.");
      }

      await this.auditService.record(tx, {
        actorUserId: userId,
        tenantId: null,
        action: "auth.mfa.recovery_codes_regenerated",
        targetType: "USER_MFA",
        targetId: userId,
        outcome: "SUCCESS",
      });

      return {
        kind: "REGENERATED" as const,
        regeneratedAt: now,
      };
    });

    if (result.kind !== "REGENERATED") {
      throw new UnauthorizedException("Recovery-code regeneration failed.");
    }

    return {
      recoveryCodes,
      regeneratedAt: result.regeneratedAt,
    };
  }

  async disableMfa(
    userId: string,
    password: string,
    currentCode: string,
  ): Promise<{ disabledAt: Date; revokedSessions: number }> {
    const result = await this.identityContext.withGlobalIdentityContext({ userId }, async (tx) => {
      const users = await tx.$queryRaw<LockedEnrollmentUser[]>`
          SELECT id, email_normalized, password_hash, status, email_verified_at
          FROM users
          WHERE id = ${userId}::uuid
          FOR UPDATE
        `;
      const user = users[0];

      if (
        !user ||
        user.status !== "ACTIVE" ||
        user.email_verified_at === null ||
        !(await this.passwordService.verifyPassword(password, user.password_hash))
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.disable_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const isPlatformAdministrator = await hasActivePlatformAdministrator(tx, userId);

      if (isPlatformAdministrator) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.disable_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const activeMfa = await tx.userMfa.findUnique({
        where: { userId },
        select: {
          status: true,
          encryptedSecret: true,
          lastAcceptedTimeStep: true,
        },
      });

      if (!activeMfa || activeMfa.status !== "ENABLED") {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.disable_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const now = new Date();
      const activeSecret = this.mfaCrypto.decryptSecret(Buffer.from(activeMfa.encryptedSecret));
      const currentStep = this.mfaCrypto.verifyTotpCode(activeSecret, currentCode, now.getTime());

      if (
        currentStep === null ||
        (activeMfa.lastAcceptedTimeStep !== null &&
          BigInt(currentStep) <= activeMfa.lastAcceptedTimeStep)
      ) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.disable_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const updated = await tx.$queryRaw<{ user_id: string }[]>`
          UPDATE user_mfa
          SET
            last_accepted_time_step = ${BigInt(currentStep)},
            updated_at = ${now}
          WHERE user_id = ${userId}::uuid
            AND status = 'ENABLED'
            AND (
              last_accepted_time_step IS NULL
              OR last_accepted_time_step < ${BigInt(currentStep)}
            )
          RETURNING user_id
        `;

      if (updated.length !== 1) {
        await this.auditService.record(tx, {
          actorUserId: userId,
          tenantId: null,
          action: "auth.mfa.disable_failed",
          targetType: "USER_MFA",
          targetId: userId,
          outcome: "FAILURE",
        });
        return { kind: "INVALID" as const };
      }

      const disabled = await tx.$queryRaw<{ disabled_at: Date; revoked_sessions: number }[]>`
          SELECT *
          FROM public.disable_user_mfa(${userId}::uuid)
        `;

      const disabledResult = disabled[0];
      if (disabled.length !== 1 || !disabledResult) {
        throw new Error("MFA disable returned an unexpected result.");
      }

      await this.auditService.record(tx, {
        actorUserId: userId,
        tenantId: null,
        action: "auth.mfa.disabled",
        targetType: "USER_MFA",
        targetId: userId,
        outcome: "SUCCESS",
      });

      return {
        kind: "DISABLED" as const,
        disabledAt: disabledResult.disabled_at,
        revokedSessions: disabledResult.revoked_sessions,
      };
    });

    if (result.kind !== "DISABLED") {
      throw new UnauthorizedException("MFA disable failed.");
    }

    return {
      disabledAt: result.disabledAt,
      revokedSessions: result.revokedSessions,
    };
  }
}
