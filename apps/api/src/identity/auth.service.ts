import { Injectable, InternalServerErrorException, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { EmailDeliveryService } from "./email-delivery.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService, type CreatedSession } from "./session.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RegisterDto } from "./dto/register.dto.js";

const EMAIL_VERIFICATION_LIFETIME_MS = 30 * 60 * 1000;

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$xfQtUT6PK90ME219my5GPw$X2eX51EXnNJGThumtAEOcn1n9n0qHZMh0bdn0eyX3/c";

const REGISTRATION_RESPONSE = {
  message:
    "If registration is possible, verification instructions will be sent to the provided email address.",
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly emailDeliveryService: EmailDeliveryService,
    private readonly sessionService: SessionService,
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

  async login(input: LoginDto, userAgent?: string): Promise<CreatedSession> {
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

    return this.sessionService.createSession(user.id, userAgent);
  }
}
