import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { CsrfService } from "../identity/csrf.service.js";
import { AuthenticatedRequest, SessionAuthGuard } from "../identity/session-auth.guard.js";
import { assertFrontendOrigin } from "../identity/request-origin.js";
import { readSessionCookie } from "../identity/session-cookie.js";
import { RegisterBusinessDto } from "./dto/register-business.dto.js";
import { BusinessRegistrationService } from "./business-registration.service.js";

interface BusinessRequest extends AuthenticatedRequest {
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("businesses/registrations")
@UseGuards(SessionAuthGuard)
export class BusinessRegistrationController {
  constructor(
    private readonly businessRegistrationService: BusinessRegistrationService,
    private readonly csrfService: CsrfService,
  ) {}

  @Post()
  async register(@Body() input: RegisterBusinessDto, @Req() request: BusinessRequest) {
    assertFrontendOrigin(request.headers.origin);

    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const sessionToken = readSessionCookie(request.headers.cookie);

    if (!sessionToken) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const suppliedToken = request.headers["x-csrf-token"];

    if (
      typeof suppliedToken !== "string" ||
      !this.csrfService.verifyToken(sessionToken, suppliedToken)
    ) {
      throw new ForbiddenException("A valid CSRF token is required.");
    }

    return this.businessRegistrationService.register(request.authSession.userId, input.name);
  }

  @Get()
  async listRegistrations(
    @Req() request: BusinessRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    response.setHeader("Cache-Control", "no-store");

    return {
      registrations: await this.businessRegistrationService.listRegistrations(
        request.authSession.userId,
      ),
    };
  }
}
