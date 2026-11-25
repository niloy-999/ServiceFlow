import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import type { AuthenticatedRequest } from "../identity/session-auth.guard.js";
import { SessionAuthGuard } from "../identity/session-auth.guard.js";
import { CsrfService } from "../identity/csrf.service.js";
import { assertFrontendOrigin } from "../identity/request-origin.js";
import { readSessionCookie } from "../identity/session-cookie.js";
import {
  CreateSupplierDto,
  SupplierTenantDto,
  SupplierVersionDto,
  UpdateSupplierDto,
} from "./dto/supplier.dto.js";
import { SupplierService } from "./supplier.service.js";

interface SupplierRequest extends AuthenticatedRequest {
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("suppliers")
@UseGuards(SessionAuthGuard)
export class SupplierController {
  constructor(
    private readonly suppliers: SupplierService,
    private readonly csrf: CsrfService,
  ) {}

  private userId(request: SupplierRequest): string {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }
    return request.authSession.userId;
  }

  private verifyMutation(request: SupplierRequest): string {
    assertFrontendOrigin(request.headers.origin);
    const sessionToken = readSessionCookie(request.headers.cookie);
    const suppliedToken = request.headers["x-csrf-token"];

    if (
      !sessionToken ||
      typeof suppliedToken !== "string" ||
      !this.csrf.verifyToken(sessionToken, suppliedToken)
    ) {
      throw new ForbiddenException("A valid CSRF token is required.");
    }

    return this.userId(request);
  }

  @Get(":tenantId")
  async list(
    @Param("tenantId", new ParseUUIDPipe()) tenantId: string,
    @Req() request: SupplierRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    return {
      suppliers: await this.suppliers.list(this.userId(request), tenantId),
    };
  }

  @Post()
  create(@Body() input: CreateSupplierDto, @Req() request: SupplierRequest) {
    return this.suppliers.create(this.verifyMutation(request), input);
  }

  @Post(":supplierId/update")
  update(
    @Param("supplierId", new ParseUUIDPipe()) supplierId: string,
    @Body() input: UpdateSupplierDto,
    @Req() request: SupplierRequest,
  ) {
    return this.suppliers.update(this.verifyMutation(request), supplierId, input);
  }

  @Post(":supplierId/archive")
  archive(
    @Param("supplierId", new ParseUUIDPipe()) supplierId: string,
    @Body() input: SupplierVersionDto,
    @Req() request: SupplierRequest,
  ) {
    return this.suppliers.archive(
      this.verifyMutation(request),
      supplierId,
      input.tenantId,
      input.version,
    );
  }
}
