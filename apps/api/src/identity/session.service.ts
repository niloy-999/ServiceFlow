import { Injectable, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "../generated/prisma/client.js";
import { hasActivePlatformAdministrator } from "./platform-admin-policy.js";
import { createHash, randomBytes } from "node:crypto";
import { GlobalIdentityContextService } from "../database/global-identity-context.service.js";
import { PrismaService } from "../database/prisma.service.js";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

interface LockedUser {
  id: string;
  status: string;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identityContext: GlobalIdentityContextService,
  ) {}

  private generateToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private isValidTokenFormat(token: string): boolean {
    return SESSION_SECRET_PATTERN.test(token);
  }

  private async lockActiveUser(
    tx: Parameters<Parameters<PrismaService["$transaction"]>[0]>[0],
    userId: string,
  ): Promise<boolean> {
    const users = await tx.$queryRaw<LockedUser[]>`
      SELECT id, status
      FROM users
      WHERE id = ${userId}::uuid
      FOR UPDATE
    `;

    return users.length === 1 && users[0]?.status === "ACTIVE";
  }

  async createSession(userId: string, userAgent?: string): Promise<CreatedSession> {
    return this.identityContext.withGlobalIdentityContext({ userId }, async (tx) => {
      if (!(await this.lockActiveUser(tx, userId))) {
        throw new UnauthorizedException("An active user is required to create a session.");
      }

      const isPlatformAdministrator =
        await hasActivePlatformAdministrator(tx, userId);
      const mfa = await tx.userMfa.findUnique({
        where: { userId },
        select: { status: true },
      });

      if (mfa?.status === "ENABLED" || isPlatformAdministrator) {
        throw new UnauthorizedException("MFA verification is required.");
      }

      const token = this.generateToken();
      const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

      await tx.authSession.create({
        data: {
          userId,
          sessionHash: this.hashToken(token),
          expiresAt,
          ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
        },
      });

      return { token, expiresAt };
    });
  }

  /**
   * Creates a password-authenticated session inside the caller's transaction.
   * The caller must have already verified the password under the user lock.
   */
  async createPasswordVerifiedSession(
    tx: Prisma.TransactionClient,
    userId: string,
    userAgent?: string,
  ): Promise<CreatedSession> {
    if (!(await this.lockActiveUser(tx, userId))) {
      throw new UnauthorizedException("An active user is required to create a session.");
    }

    const isPlatformAdministrator =
      await hasActivePlatformAdministrator(tx, userId);
    const mfa = await tx.userMfa.findUnique({
      where: { userId },
      select: { status: true },
    });

    if (mfa?.status === "ENABLED" || isPlatformAdministrator) {
      throw new UnauthorizedException("MFA verification is required.");
    }

    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

    await tx.authSession.create({
      data: {
        userId,
        sessionHash: this.hashToken(token),
        expiresAt,
        ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
      },
    });

    return { token, expiresAt };
  }

  /**
   * Creates a session inside the caller's transaction after MFA verification.
   * Only the MFA challenge verification service should call this method.
   */
  async createMfaVerifiedSession(
    tx: Prisma.TransactionClient,
    userId: string,
    userAgent?: string,
  ): Promise<CreatedSession> {
    if (!(await this.lockActiveUser(tx, userId))) {
      throw new UnauthorizedException("An active user is required to create a session.");
    }

    const mfa = await tx.userMfa.findUnique({
      where: { userId },
      select: { status: true, enabledAt: true },
    });

    const now = new Date();

    if (mfa?.status !== "ENABLED" || !mfa.enabledAt || now < mfa.enabledAt) {
      throw new UnauthorizedException("MFA verification is required.");
    }

    const token = this.generateToken();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

    await tx.authSession.create({
      data: {
        userId,
        sessionHash: this.hashToken(token),
        expiresAt,
        mfaVerifiedAt: now,
        ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
      },
    });

    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<ValidatedSession | null> {
    if (!this.isValidTokenFormat(token)) {
      return null;
    }

    const sessionHash = this.hashToken(token);
    const candidate = await this.prisma.authSession.findFirst({
      where: {
        sessionHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: { is: { status: "ACTIVE" } },
      },
      select: { id: true, userId: true },
    });

    if (!candidate) {
      return null;
    }

    return this.identityContext.withGlobalIdentityContext(
      { userId: candidate.userId },
      async (tx) => {
        if (!(await this.lockActiveUser(tx, candidate.userId))) {
          return null;
        }

        const session = await tx.authSession.findFirst({
          where: {
            id: candidate.id,
            sessionHash,
            userId: candidate.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: {
            id: true,
            userId: true,
            expiresAt: true,
            mfaVerifiedAt: true,
          },
        });

        if (!session) {
          return null;
        }

        const isPlatformAdministrator =
          await hasActivePlatformAdministrator(tx, candidate.userId);
        const mfa = await tx.userMfa.findUnique({
          where: { userId: candidate.userId },
          select: { status: true, enabledAt: true },
        });

        if (
          (mfa?.status === "ENABLED" || isPlatformAdministrator) &&
          (mfa?.status !== "ENABLED" ||
            !mfa.enabledAt ||
            !session.mfaVerifiedAt ||
            session.mfaVerifiedAt < mfa.enabledAt)
        ) {
          return null;
        }

        return {
          sessionId: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
        };
      },
    );
  }

  async revokeSession(token: string): Promise<boolean> {
    if (!this.isValidTokenFormat(token)) {
      return false;
    }

    const result = await this.prisma.authSession.updateMany({
      where: {
        sessionHash: this.hashToken(token),
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return result.count === 1;
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    return result.count;
  }

  async rotateSession(token: string, userAgent?: string): Promise<CreatedSession | null> {
    if (!this.isValidTokenFormat(token)) {
      return null;
    }

    const now = new Date();
    const sessionHash = this.hashToken(token);
    const candidate = await this.prisma.authSession.findFirst({
      where: {
        sessionHash,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { is: { status: "ACTIVE" } },
      },
      select: { id: true, userId: true },
    });

    if (!candidate) {
      return null;
    }

    return this.identityContext.withGlobalIdentityContext(
      { userId: candidate.userId },
      async (tx) => {
        if (!(await this.lockActiveUser(tx, candidate.userId))) {
          return null;
        }

        const oldSession = await tx.authSession.findFirst({
          where: {
            id: candidate.id,
            sessionHash,
            userId: candidate.userId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: {
            id: true,
            userId: true,
            mfaVerifiedAt: true,
          },
        });

        if (!oldSession) {
          return null;
        }

        const isPlatformAdministrator =
          await hasActivePlatformAdministrator(tx, candidate.userId);
        const mfa = await tx.userMfa.findUnique({
          where: { userId: candidate.userId },
          select: { status: true, enabledAt: true },
        });

        if (
          (mfa?.status === "ENABLED" || isPlatformAdministrator) &&
          (mfa?.status !== "ENABLED" ||
            !mfa.enabledAt ||
            !oldSession.mfaVerifiedAt ||
            oldSession.mfaVerifiedAt < mfa.enabledAt)
        ) {
          return null;
        }

        const newToken = this.generateToken();
        const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);

        const revoked = await tx.authSession.updateMany({
          where: {
            id: oldSession.id,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { revokedAt: now },
        });

        if (revoked.count !== 1) {
          return null;
        }

        await tx.authSession.create({
          data: {
            userId: oldSession.userId,
            sessionHash: this.hashToken(newToken),
            expiresAt,
            mfaVerifiedAt: oldSession.mfaVerifiedAt,
            ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
          },
        });

        return { token: newToken, expiresAt };
      },
    );
  }
}
