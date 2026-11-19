import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
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

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  private generateToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private isValidTokenFormat(token: string): boolean {
    return SESSION_SECRET_PATTERN.test(token);
  }

  async createSession(userId: string, userAgent?: string): Promise<CreatedSession> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, status: "ACTIVE" },
      select: { id: true },
    });

    if (!user) {
      throw new UnauthorizedException("An active user is required to create a session.");
    }

    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);

    await this.prisma.authSession.create({
      data: {
        userId,
        sessionHash: this.hashToken(token),
        expiresAt,
        ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
      },
    });

    return { token, expiresAt };
  }

  async validateSession(token: string): Promise<ValidatedSession | null> {
    if (!this.isValidTokenFormat(token)) {
      return null;
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        sessionHash: this.hashToken(token),
        revokedAt: null,
        expiresAt: { gt: new Date() },
        user: {
          is: { status: "ACTIVE" },
        },
      },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
      },
    });

    if (!session) {
      return null;
    }

    return {
      sessionId: session.id,
      userId: session.userId,
      expiresAt: session.expiresAt,
    };
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
      data: {
        revokedAt: new Date(),
      },
    });

    return result.count === 1;
  }

  async revokeAllSessions(userId: string): Promise<number> {
    const result = await this.prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });

    return result.count;
  }

  async rotateSession(token: string, userAgent?: string): Promise<CreatedSession | null> {
    if (!this.isValidTokenFormat(token)) {
      return null;
    }

    const now = new Date();
    const newToken = this.generateToken();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    const sessionHash = this.hashToken(token);

    return this.prisma.$transaction(async (tx) => {
      const oldSession = await tx.authSession.findFirst({
        where: {
          sessionHash,
          revokedAt: null,
          expiresAt: { gt: now },
          user: {
            is: { status: "ACTIVE" },
          },
        },
        select: {
          id: true,
          userId: true,
        },
      });

      if (!oldSession) {
        return null;
      }

      const revoked = await tx.authSession.updateMany({
        where: {
          id: oldSession.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          revokedAt: now,
        },
      });

      if (revoked.count !== 1) {
        return null;
      }

      await tx.authSession.create({
        data: {
          userId: oldSession.userId,
          sessionHash: this.hashToken(newToken),
          expiresAt,
          ...(userAgent === undefined ? {} : { userAgent: userAgent.slice(0, 512) }),
        },
      });

      return { token: newToken, expiresAt };
    });
  }
}
