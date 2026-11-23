import {
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { GlobalIdentityContextService } from "../database/global-identity-context.service.js";
import { hasActivePlatformAdministrator } from "./platform-admin-policy.js";
import { EmailDeliveryService } from "./email-delivery.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService, type CreatedSession } from "./session.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RegisterDto } from "./dto/register.dto.js";
import { AuditService } from "../audit/audit.service.js";

const EMAIL_VERIFICATION_LIFETIME_MS = 30 * 60 * 1000;
const PASSWORD_RESET_LIFETIME_MS = 30 * 60 * 1000;

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$xfQtUT6PK90ME219my5GPw$X2eX51EXnNJGThumtAEOcn1n9n0qHZMh0bdn0eyX3/c";

const MFA_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;

interface LockedLoginUser {
  id: string;
  status: string;
  password_hash: string;
  email_verified_at: Date | null;
}

export type LoginResult =
  | { kind: "SESSION"; session: CreatedSession }
  | { kind: "MFA_REQUIRED"; challengeToken: string; expiresAt: Date };

const REGISTRATION_RESPONSE = {
  message:
    "If registration is possible, verification instructions will be sent to the provided email address.",
};
const PASSWORD_RESET_REQUEST_RESPONSE = {
  message:
    "If the account is eligible, password reset instructions will be sent to the provided email address.",
};
const PASSWORD_RESET_CONFIRM_RESPONSE = {
  message:
    "If the password reset link is valid, the password has been reset. Sign in with your new password.",
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly sessionService: SessionService,
    private readonly identityContext: GlobalIdentityContextService,
    private readonly auditService: AuditService,
  ) {}

  async register(input: RegisterDto): Promise<typeof REGISTRATION_RESPONSE> {
    const webAppUrl = process.env.WEB_APP_URL;

    if (!webAppUrl) {
      throw new InternalServerErrorException("The web application URL is not configured.");
    }

    const email = input.email.trim().toLowerCase();
    const passwordHash = await this.passwordService.hashPassword(input.password);
    const verificationToken = randomBytes(32).toString("base64url");
    const verificationUrl = new URL("/verify-email", webAppUrl);

    verificationUrl.searchParams.set("token", verificationToken);

    const tokenHash = createHash("sha256").update(verificationToken).digest("hex");
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_LIFETIME_MS);

    try {
      await this.prisma.$transaction(async (transaction) => {
        const createdUser = await transaction.user.create({
          data: {
            emailNormalized: email,
            passwordHash,
            ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          },
          select: { id: true },
        });

        await transaction.emailVerificationToken.create({
          data: {
            userId: createdUser.id,
            tokenHash,
            expiresAt,
          },
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        const driverAdapterError = error.meta?.driverAdapterError;
        const adapterCause =
          typeof driverAdapterError === "object" &&
          driverAdapterError !== null &&
          "cause" in driverAdapterError
            ? (driverAdapterError as { cause?: unknown }).cause
            : undefined;

        const causeRecord =
          typeof adapterCause === "object" && adapterCause !== null
            ? (adapterCause as Record<string, unknown>)
            : undefined;

        const constraint =
          typeof causeRecord?.constraint === "object" && causeRecord.constraint !== null
            ? (causeRecord.constraint as Record<string, unknown>)
            : undefined;

        const isEmailUniqueConflict =
          causeRecord?.originalCode === "23505" &&
          constraint?.index === "users_email_normalized_key";

        if (isEmailUniqueConflict) {
          return REGISTRATION_RESPONSE;
        }
      }

      throw error;
    }
    try {
      await this.emailDeliveryService.sendVerificationEmail(email, verificationUrl.toString());
    } catch {
      throw new InternalServerErrorException(
        "Registration could not be completed. Please try again.",
      );
    }

    return REGISTRATION_RESPONSE;
  }

  async resendVerification(emailInput: string): Promise<typeof REGISTRATION_RESPONSE> {
    const webAppUrl = process.env.WEB_APP_URL;

    if (!webAppUrl) {
      throw new InternalServerErrorException("The web application URL is not configured.");
    }

    const email = emailInput.trim().toLowerCase();
    const verificationToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(verificationToken).digest("hex");

    const recipient = await this.prisma.$transaction(async (transaction) => {
      const users = await transaction.$queryRaw<
        { id: string; email_normalized: string; email_verified_at: Date | null }[]
      >`
        SELECT id, email_normalized, email_verified_at
        FROM users
        WHERE email_normalized = ${email}
        FOR UPDATE
      `;

      const user = users[0];

      if (!user || user.email_verified_at !== null) {
        return null;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + EMAIL_VERIFICATION_LIFETIME_MS);

      await transaction.emailVerificationToken.updateMany({
        where: {
          userId: user.id,
          consumedAt: null,
        },
        data: { consumedAt: now },
      });

      await transaction.emailVerificationToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      return user.email_normalized;
    });

    if (recipient === null) {
      return REGISTRATION_RESPONSE;
    }

    const verificationUrl = new URL("/verify-email", webAppUrl);
    verificationUrl.searchParams.set("token", verificationToken);

    try {
      await this.emailDeliveryService.sendVerificationEmail(recipient, verificationUrl.toString());
    } catch {
      throw new InternalServerErrorException(
        "Verification instructions could not be sent. Please try again.",
      );
    }

    return REGISTRATION_RESPONSE;
  }

  async verifyEmail(token: string): Promise<{ message: string }> {
    const genericResponse = {
      message: "If the verification link is valid, the email address has been verified.",
    };

    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return genericResponse;
    }

    const tokenHash = createHash("sha256").update(token).digest("hex");

    await this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.emailVerificationToken.findFirst({
        where: {
          tokenHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          userId: true,
        },
      });

      if (!candidate) {
        return;
      }

      await transaction.$queryRaw`
        SELECT id
        FROM users
        WHERE id = ${candidate.userId}::uuid
        FOR UPDATE
      `;

      const now = new Date();

      const verificationToken = await transaction.emailVerificationToken.findFirst({
        where: {
          id: candidate.id,
          tokenHash,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        select: {
          id: true,
          userId: true,
        },
      });

      if (!verificationToken) {
        return;
      }

      const result = await transaction.emailVerificationToken.updateMany({
        where: {
          id: verificationToken.id,
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });

      if (result.count !== 1) {
        return;
      }

      await transaction.user.updateMany({
        where: {
          id: verificationToken.userId,
          emailVerifiedAt: null,
        },
        data: { emailVerifiedAt: now },
      });
    });

    return genericResponse;
  }

  async requestPasswordReset(emailInput: string): Promise<typeof PASSWORD_RESET_REQUEST_RESPONSE> {
    const webAppUrl = process.env.WEB_APP_URL;
    if (!webAppUrl) {
      throw new InternalServerErrorException("The web application URL is not configured.");
    }

    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: email },
      select: { id: true },
    });
    if (!user) return PASSWORD_RESET_REQUEST_RESPONSE;

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const recipient = await this.identityContext.withGlobalIdentityContext(
      { userId: user.id },
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; email_normalized: string; status: string; email_verified_at: Date | null }[]
        >`
          SELECT id, email_normalized, status, email_verified_at
          FROM users WHERE id = ${user.id}::uuid FOR UPDATE
        `;
        const locked = rows[0];
        if (!locked || locked.status !== "ACTIVE" || locked.email_verified_at === null) return null;

        const now = new Date();
        await tx.passwordResetToken.updateMany({
          where: { userId: user.id, consumedAt: null },
          data: { consumedAt: now },
        });
        await tx.passwordResetToken.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt: new Date(now.getTime() + PASSWORD_RESET_LIFETIME_MS),
          },
        });
        await this.auditService.record(tx, {
          actorUserId: user.id,
          tenantId: null,
          action: "auth.password_reset.requested",
          targetType: "USER",
          targetId: user.id,
          outcome: "SUCCESS",
        });
        return locked.email_normalized;
      },
    );

    if (recipient === null) return PASSWORD_RESET_REQUEST_RESPONSE;
    const resetUrl = new URL("/reset-password", webAppUrl);
    resetUrl.searchParams.set("token", token);
    try {
      await this.emailDeliveryService.sendPasswordResetEmail(recipient, resetUrl.toString());
    } catch {
      this.logger.warn({ event: "auth.password_reset.delivery_failed" });
    }
    return PASSWORD_RESET_REQUEST_RESPONSE;
  }

  async confirmPasswordReset(
    token: string,
    newPassword: string,
  ): Promise<typeof PASSWORD_RESET_CONFIRM_RESPONSE> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return PASSWORD_RESET_CONFIRM_RESPONSE;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const candidate = await this.prisma.passwordResetToken.findFirst({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: new Date() } },
      select: { userId: true },
    });
    if (!candidate) return PASSWORD_RESET_CONFIRM_RESPONSE;

    const passwordHash = await this.passwordService.hashPassword(newPassword);
    await this.identityContext.withGlobalIdentityContext(
      { userId: candidate.userId },
      async (tx) => {
        const users = await tx.$queryRaw<
          { id: string; status: string; email_verified_at: Date | null }[]
        >`SELECT id, status, email_verified_at FROM users WHERE id = ${candidate.userId}::uuid FOR UPDATE`;
        const user = users[0];
        const now = new Date();
        if (!user || user.status !== "ACTIVE" || user.email_verified_at === null) return;
        const reset = await tx.passwordResetToken.findFirst({
          where: { tokenHash, userId: user.id, consumedAt: null, expiresAt: { gt: now } },
          select: { id: true },
        });
        if (!reset) return;
        const consumed = await tx.passwordResetToken.updateMany({
          where: { id: reset.id, consumedAt: null, expiresAt: { gt: now } },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) return;

        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, version: { increment: 1 } },
        });
        await tx.authSession.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: now },
        });
        await tx.passwordResetToken.updateMany({
          where: { userId: user.id, consumedAt: null },
          data: { consumedAt: now },
        });
        await this.auditService.record(tx, {
          actorUserId: user.id,
          tenantId: null,
          action: "auth.password_reset.completed",
          targetType: "USER",
          targetId: user.id,
          outcome: "SUCCESS",
        });
      },
    );
    return PASSWORD_RESET_CONFIRM_RESPONSE;
  }

  async login(input: LoginDto, userAgent?: string): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();

    const user = await this.prisma.user.findUnique({
      where: { emailNormalized: email },
      select: {
        id: true,
        passwordHash: true,
        status: true,
        emailVerifiedAt: true,
      },
    });

    const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const passwordMatches = await this.passwordService.verifyPassword(input.password, passwordHash);

    if (!user || !passwordMatches || user.status !== "ACTIVE" || user.emailVerifiedAt === null) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    return this.identityContext.withGlobalIdentityContext({ userId: user.id }, async (tx) => {
      const lockedUsers = await tx.$queryRaw<LockedLoginUser[]>`
          SELECT id, status, password_hash, email_verified_at
          FROM users
          WHERE id = ${user.id}::uuid
          FOR UPDATE
        `;

      const lockedUser = lockedUsers[0];

      if (
        !lockedUser ||
        lockedUser.status !== "ACTIVE" ||
        lockedUser.email_verified_at === null ||
        lockedUser.password_hash !== passwordHash
      ) {
        throw new UnauthorizedException("Invalid email or password.");
      }

      const isPlatformAdministrator = await hasActivePlatformAdministrator(tx, user.id);

      const mfa = await tx.userMfa.findUnique({
        where: { userId: user.id },
        select: { status: true, enabledAt: true },
      });

      const now = new Date();

      if (
        isPlatformAdministrator &&
        (mfa?.status !== "ENABLED" || !mfa.enabledAt || mfa.enabledAt > now)
      ) {
        throw new UnauthorizedException("Invalid email or password.");
      }

      if (mfa?.status === "ENABLED") {
        const challengeToken = randomBytes(32).toString("base64url");
        const tokenHash = createHash("sha256").update(challengeToken).digest("hex");
        const now = new Date();
        const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_LIFETIME_MS);

        await tx.mfaChallenge.create({
          data: {
            userId: user.id,
            tokenHash,
            expiresAt,
          },
        });

        return {
          kind: "MFA_REQUIRED",
          challengeToken,
          expiresAt,
        };
      }

      const session = await this.sessionService.createPasswordVerifiedSession(
        tx,
        user.id,
        userAgent,
      );

      return { kind: "SESSION", session };
    });
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, status: "ACTIVE" },
      select: {
        id: true,
        emailNormalized: true,
        displayName: true,
        emailVerifiedAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException("Authentication is required.");
    }

    return {
      id: user.id,
      email: user.emailNormalized,
      displayName: user.displayName,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }
}
