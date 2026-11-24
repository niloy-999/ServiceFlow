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

import { DecideInventoryAdjustmentDto, SubmitInventoryAdjustmentDto } from "./dto/inventory.dto.js";
import { InventoryService } from "./inventory.service.js";

interface InventoryRequest extends AuthenticatedRequest {
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("inventory")
@UseGuards(SessionAuthGuard)
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly csrf: CsrfService,
  ) {}

  private userId(request: InventoryRequest): string {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    return request.authSession.userId;
  }

  private verifyMutation(request: InventoryRequest): string {
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

  @Post("adjustments")
  submitAdjustment(@Body() input: SubmitInventoryAdjustmentDto, @Req() request: InventoryRequest) {
    return this.inventory.submitAdjustment(this.verifyMutation(request), input);
  }

  @Get(":tenantId/branches/:branchId/adjustments")
  async listAdjustments(
    @Param("tenantId", new ParseUUIDPipe({ version: "4" })) tenantId: string,
    @Param("branchId", new ParseUUIDPipe({ version: "4" })) branchId: string,
    @Req() request: InventoryRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");

    return {
      adjustments: await this.inventory.listAdjustments(this.userId(request), tenantId, branchId),
    };
  }

  @Get(":tenantId/branches/:branchId/adjustments/:adjustmentId")
  async getAdjustment(
    @Param("tenantId", new ParseUUIDPipe({ version: "4" })) tenantId: string,
    @Param("branchId", new ParseUUIDPipe({ version: "4" })) branchId: string,
    @Param("adjustmentId", new ParseUUIDPipe({ version: "4" })) adjustmentId: string,
    @Req() request: InventoryRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");

    return this.inventory.getAdjustment(this.userId(request), tenantId, branchId, adjustmentId);
  }

  @Post("adjustments/:adjustmentId/approve")
  approveAdjustment(
    @Param("adjustmentId", new ParseUUIDPipe({ version: "4" })) adjustmentId: string,
    @Body() input: DecideInventoryAdjustmentDto,
    @Req() request: InventoryRequest,
  ) {
    return this.inventory.approveAdjustment(this.verifyMutation(request), adjustmentId, input);
  }

  @Post("adjustments/:adjustmentId/reject")
  rejectAdjustment(
    @Param("adjustmentId", new ParseUUIDPipe({ version: "4" })) adjustmentId: string,
    @Body() input: DecideInventoryAdjustmentDto,
    @Req() request: InventoryRequest,
  ) {
    return this.inventory.rejectAdjustment(this.verifyMutation(request), adjustmentId, input);
  }
}
