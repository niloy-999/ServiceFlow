import {
  Body,
  Controller,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { RateLimitService } from "../rate-limit/rate-limit.service.js";
import { AuthService } from "./auth.service.js";
import { RegisterDto } from "./dto/register.dto.js";
import { ResendVerificationDto } from "./dto/resend-verification.dto.js";
import { VerifyEmailDto } from "./dto/verify-email.dto.js";

interface ClientRequest {
  socket: {
    remoteAddress?: string;
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

  @Post("register")
  async register(
    @Body() input: RegisterDto,
    @Req() request: ClientRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    const clientIp = this.getClientIp(request);

    await this.enforceLimit("register", "ip", clientIp, 10, 15 * 60, response);
    await this.enforceLimit("register", "email", input.email.toLowerCase(), 5, 60 * 60, response);

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
      input.email.toLowerCase(),
      3,
      60 * 60,
      response,
    );

    return this.authService.resendVerification(input.email);
  }
}
