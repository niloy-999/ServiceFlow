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
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { AuthService } from "./auth.service.js";
import { assertFrontendOrigin } from "./request-origin.js";
import { AuthenticatedRequest, SessionAuthGuard } from "./session-auth.guard.js";
import { clearSessionCookie, createSessionCookie, readSessionCookie } from "./session-cookie.js";
import { CsrfService } from "./csrf.service.js";
import { SessionService } from "./session.service.js";
import { LoginDto } from "./dto/login.dto.js";
import { RegisterDto } from "./dto/register.dto.js";
import { ResendVerificationDto } from "./dto/resend-verification.dto.js";
import { VerifyEmailDto } from "./dto/verify-email.dto.js";

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

    const userAgent = request.headers["user-agent"];
    const session = await this.authService.login(
      input,
      typeof userAgent === "string" ? userAgent : undefined,
    );

    response.setHeader("Set-Cookie", createSessionCookie(session.token, session.expiresAt));

    return {
      csrfToken: this.csrfService.generateToken(session.token),
      expiresAt: session.expiresAt,
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
