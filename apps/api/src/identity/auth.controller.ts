import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { AuthService } from "./auth.service.js";
import { MembershipService } from "./membership.service.js";
import { MfaChallengeService } from "./mfa-challenge.service.js";
import { MfaEnrollmentService } from "./mfa-enrollment.service.js";
import { assertFrontendOrigin } from "./request-origin.js";
import { AuthenticatedRequest, SessionAuthGuard } from "./session-auth.guard.js";
import { clearSessionCookie, createSessionCookie, readSessionCookie } from "./session-cookie.js";
import { CsrfService } from "./csrf.service.js";
import { SessionService } from "./session.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RegisterDto } from "./dto/register.dto.js";
import { ResendVerificationDto } from "./dto/resend-verification.dto.js";
import { VerifyEmailDto } from "./dto/verify-email.dto.js";
import { VerifyMfaDto } from "./dto/verify-mfa.dto.js";
import { StartMfaEnrollmentDto } from "./dto/start-mfa-enrollment.dto.js";
import { ConfirmMfaEnrollmentDto } from "./dto/confirm-mfa-enrollment.dto.js";
import { RegenerateMfaRecoveryCodesDto } from "./dto/regenerate-mfa-recovery-codes.dto.js";
import { DisableMfaDto } from "./dto/disable-mfa.dto.js";
import { RequestPasswordResetDto } from "./dto/request-password-reset.dto.js";
import { ConfirmPasswordResetDto } from "./dto/confirm-password-reset.dto.js";

interface ClientRequest extends AuthenticatedRequest {
  socket: {
    remoteAddress?: string;
  };
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "user-agent"?: string | string[];
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimitService: RateLimitService,
    private readonly csrfService: CsrfService,
    private readonly sessionService: SessionService,
    private readonly membershipService: MembershipService,
    private readonly mfaChallengeService: MfaChallengeService,
    private readonly mfaEnrollmentService: MfaEnrollmentService,
  ) {}

  private async enforceLimit(
    operation: string,
    dimension: string,
    identifier: string,
    limit: number,
    windowSeconds: number,
    response: ResponseHeaders,
  ): Promise<void> {
    const result = await this.rateLimitService.consume({
      operation,
      dimension,
      identifier,
      limit,
      windowSeconds,
    });

    if (!result.allowed) {
      response.setHeader("Retry-After", String(result.retryAfterSeconds));
      throw new HttpException(
        "Too many requests. Please try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private getClientIp(request: ClientRequest): string {
    const clientIp = request.socket.remoteAddress;

    if (!clientIp) {
      throw new InternalServerErrorException("Unable to determine the client connection.");
    }

    return clientIp;
  }

  private getSessionToken(request: ClientRequest): string {
    const token = readSessionCookie(request.headers.cookie);

    if (!token) {
      throw new UnauthorizedException("Authentication is required.");
    }

    return token;
  }

  private verifyCsrf(request: ClientRequest, sessionToken: string): void {
    const suppliedToken = request.headers["x-csrf-token"];

    if (
      typeof suppliedToken !== "string" ||
      !this.csrfService.verifyToken(sessionToken, suppliedToken)
    ) {
      throw new ForbiddenException("A valid CSRF token is required.");
    }
  }

  @Post("register")
  async register(
    @Body() input: RegisterDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    const clientIp = this.getClientIp(request);
    await this.enforceLimit("register", "ip", clientIp, 10, 15 * 60, response);
    await this.enforceLimit(
      "register",
      "email",
      input.email.trim().toLowerCase(),
      5,
      60 * 60,
      response,
    );
    return this.authService.register(input);
  }

  @Post("verify-email")
  async verifyEmail(
    @Body() input: VerifyEmailDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    const clientIp = this.getClientIp(request);
    await this.enforceLimit("verify-email", "ip", clientIp, 30, 15 * 60, response);
    await this.enforceLimit("verify-email", "token", input.token, 5, 15 * 60, response);
    return this.authService.verifyEmail(input.token);
  }

  @Post("resend-verification")
  async resendVerification(
    @Body() input: ResendVerificationDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    const clientIp = this.getClientIp(request);
    await this.enforceLimit("resend-verification", "ip", clientIp, 10, 60 * 60, response);
    await this.enforceLimit(
      "resend-verification",
      "email",
      input.email.trim().toLowerCase(),
      3,
      60 * 60,
      response,
    );
    return this.authService.resendVerification(input.email);
  }

  @Post("password-reset/request")
  @HttpCode(HttpStatus.OK)
  async requestPasswordReset(
    @Body() input: RequestPasswordResetDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);
    response.setHeader("Cache-Control", "no-store");
    const ip = this.getClientIp(request);
    await this.enforceLimit("password-reset-request", "ip", ip, 10, 60 * 60, response);
    await this.enforceLimit(
      "password-reset-request",
      "email",
      input.email.trim().toLowerCase(),
      3,
      60 * 60,
      response,
    );
    return this.authService.requestPasswordReset(input.email);
  }

  @Post("password-reset/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(
    @Body() input: ConfirmPasswordResetDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);
    response.setHeader("Cache-Control", "no-store");
    const ip = this.getClientIp(request);
    await this.enforceLimit("password-reset-confirm", "ip", ip, 20, 15 * 60, response);
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    await this.enforceLimit("password-reset-confirm", "token", tokenHash, 5, 15 * 60, response);
    return this.authService.confirmPasswordReset(input.token, input.newPassword);
  }

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() input: LoginDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);

    const clientIp = this.getClientIp(request);
    await this.enforceLimit("login", "ip", clientIp, 20, 15 * 60, response);
    await this.enforceLimit(
      "login",
      "email",
      input.email.trim().toLowerCase(),
      5,
      15 * 60,
      response,
    );

    response.setHeader("Cache-Control", "no-store");

    const userAgent = request.headers["user-agent"];
    const result = await this.authService.login(
      input,
      typeof userAgent === "string" ? userAgent : undefined,
    );

    if (result.kind === "MFA_REQUIRED") {
      return {
        mfaRequired: true,
        challengeToken: result.challengeToken,
        expiresAt: result.expiresAt,
      };
    }

    const session = result.session;
    response.setHeader("Set-Cookie", createSessionCookie(session.token, session.expiresAt));

    return {
      mfaRequired: false,
      csrfToken: this.csrfService.generateToken(session.token),
      expiresAt: session.expiresAt,
    };
  }

  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body() input: VerifyMfaDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);
    response.setHeader("Cache-Control", "no-store");

    const clientIp = this.getClientIp(request);
    await this.enforceLimit("mfa-verify", "ip", clientIp, 20, 15 * 60, response);

    const challengeHash = createHash("sha256").update(input.challengeToken).digest("hex");

    await this.enforceLimit("mfa-verify", "challenge", challengeHash, 5, 15 * 60, response);

    const userAgent = request.headers["user-agent"];
    const session = await this.mfaChallengeService.verify(
      input.challengeToken,
      input.code,
      typeof userAgent === "string" ? userAgent : undefined,
    );

    response.setHeader("Set-Cookie", createSessionCookie(session.token, session.expiresAt));

    return {
      csrfToken: this.csrfService.generateToken(session.token),
      expiresAt: session.expiresAt,
    };
  }

  @Post("mfa/enrollment")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async startMfaEnrollment(
    @Body() input: StartMfaEnrollmentDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);

    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);
    response.setHeader("Cache-Control", "no-store");

    const userId = request.authSession.userId;
    const clientIp = this.getClientIp(request);

    await this.enforceLimit("mfa-enrollment-start", "ip", clientIp, 10, 15 * 60, response);

    await this.enforceLimit("mfa-enrollment-start", "user", userId, 5, 15 * 60, response);

    return this.mfaEnrollmentService.startEnrollment(userId, input.password);
  }

  @Post("mfa/enrollment/confirm")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async confirmMfaEnrollment(
    @Body() input: ConfirmMfaEnrollmentDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);

    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);
    response.setHeader("Cache-Control", "no-store");

    const userId = request.authSession.userId;
    const clientIp = this.getClientIp(request);

    await this.enforceLimit("mfa-enrollment-confirm", "ip", clientIp, 10, 15 * 60, response);

    await this.enforceLimit("mfa-enrollment-confirm", "user", userId, 5, 15 * 60, response);

    return this.mfaEnrollmentService.confirmEnrollment(
      userId,
      input.password,
      input.pendingCode,
      input.currentCode,
    );
  }

  @Post("mfa/recovery-codes/regenerate")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async regenerateMfaRecoveryCodes(
    @Body() input: RegenerateMfaRecoveryCodesDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);
    response.setHeader("Cache-Control", "no-store");

    const userId = request.authSession.userId;
    const clientIp = this.getClientIp(request);

    await this.enforceLimit("mfa-recovery-regenerate", "ip", clientIp, 10, 15 * 60, response);

    await this.enforceLimit("mfa-recovery-regenerate", "user", userId, 5, 15 * 60, response);

    return this.mfaEnrollmentService.regenerateRecoveryCodes(
      userId,
      input.password,
      input.currentCode,
    );
  }

  @Post("mfa/disable")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async disableMfa(
    @Body() input: DisableMfaDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);
    response.setHeader("Cache-Control", "no-store");

    const userId = request.authSession.userId;
    const clientIp = this.getClientIp(request);

    await this.enforceLimit("mfa-disable", "ip", clientIp, 10, 15 * 60, response);

    await this.enforceLimit("mfa-disable", "user", userId, 5, 15 * 60, response);

    const result = await this.mfaEnrollmentService.disableMfa(
      userId,
      input.password,
      input.currentCode,
    );

    response.setHeader("Set-Cookie", clearSessionCookie());

    return {
      message: "MFA disabled. Sign in again.",
      ...result,
    };
  }

  @Get("me")
  @UseGuards(SessionAuthGuard)
  async getCurrentUser(
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    response.setHeader("Cache-Control", "no-store");
    return this.authService.getCurrentUser(request.authSession.userId);
  }

  @Get("memberships")
  @UseGuards(SessionAuthGuard)
  async getMemberships(
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    response.setHeader("Cache-Control", "no-store");

    return {
      memberships: await this.membershipService.listActiveMemberships(request.authSession.userId),
    };
  }

  @Get("csrf")
  @UseGuards(SessionAuthGuard)
  getCsrfToken(
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    const sessionToken = this.getSessionToken(request);
    response.setHeader("Cache-Control", "no-store");
    return {
      csrfToken: this.csrfService.generateToken(sessionToken),
    };
  }

  @Post("logout")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async logout(
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);

    await this.sessionService.revokeSession(sessionToken);
    response.setHeader("Set-Cookie", clearSessionCookie());

    return { message: "Logged out." };
  }

  @Post("logout-all")
  @HttpCode(HttpStatus.OK)
  @UseGuards(SessionAuthGuard)
  async logoutAll(
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    assertFrontendOrigin(request.headers.origin);

    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = this.getSessionToken(request);
    this.verifyCsrf(request, sessionToken);

    await this.sessionService.revokeAllSessions(request.authSession.userId);
    response.setHeader("Set-Cookie", clearSessionCookie());

    return { message: "All sessions have been logged out." };
  }
}
