import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

import { readSessionCookie } from "./session-cookie.js";
import { SessionService, ValidatedSession } from "./session.service.js";

export interface AuthenticatedRequest {
  headers: {
    cookie?: string;
    [key: string]: string | string[] | undefined;
  };
  authSession?: ValidatedSession;
}

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readSessionCookie(request.headers.cookie);

    if (!token) {
      throw new UnauthorizedException("Authentication is required.");
    }

    const session = await this.sessionService.validateSession(token);

    if (!session) {
      throw new UnauthorizedException("Authentication is required.");
    }

    request.authSession = session;

    return true;
  }
}
