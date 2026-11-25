import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Delete,
  Query,
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
  CreatePurchaseOrderDto,
  CreatePurchaseOrderLineDto,
  DeletePurchaseOrderLineDto,
  PurchaseOrderCancellationDecisionDto,
  PurchaseOrderLifecycleDto,
  PurchaseOrderLifecycleReasonDto,
  PurchaseOrderLineListDto,
  PurchaseOrderListQueryDto,
  UpdatePurchaseOrderLineDto,
} from "./dto/purchase-order.dto.js";
import { PurchaseOrderService } from "./purchase-order.service.js";

interface PurchaseOrderRequest extends AuthenticatedRequest {
  headers: AuthenticatedRequest["headers"] & {
    origin?: string;
    "x-csrf-token"?: string | string[];
  };
}

interface ResponseHeaders {
  setHeader(name: string, value: string): void;
}

@Controller("purchase-orders")
@UseGuards(SessionAuthGuard)
export class PurchaseOrderController {
  constructor(
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly csrf: CsrfService,
  ) {}

  private userId(request: PurchaseOrderRequest): string {
    if (!request.authSession) {
      throw new UnauthorizedException("Authentication is required.");
    }

    return request.authSession.userId;
  }

  private verifyMutation(request: PurchaseOrderRequest): string {
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
    @Query() query: PurchaseOrderListQueryDto,
    @Req() request: PurchaseOrderRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");

    return this.purchaseOrders.list(this.userId(request), { tenantId, ...query });
  }

  @Get(":tenantId/:branchId/:purchaseOrderId/lines")
  async listLines(
    @Param("tenantId", new ParseUUIDPipe()) tenantId: string,
    @Param("branchId", new ParseUUIDPipe()) branchId: string,
    @Param("purchaseOrderId", new ParseUUIDPipe()) purchaseOrderId: string,
    @Req() request: PurchaseOrderRequest,
    @Res({ passthrough: true }) response: ResponseHeaders,
  ) {
    response.setHeader("Cache-Control", "no-store");
    const input: PurchaseOrderLineListDto = {
      tenantId,
      branchId,
      purchaseOrderId,
    };
    return this.purchaseOrders.listLines(this.userId(request), input);
  }

  @Post("lines")
  createLine(@Body() input: CreatePurchaseOrderLineDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.createLine(this.verifyMutation(request), input);
  }

  @Patch("lines")
  updateLine(@Body() input: UpdatePurchaseOrderLineDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.updateLine(this.verifyMutation(request), input);
  }

  @Delete("lines")
  deleteLine(@Body() input: DeletePurchaseOrderLineDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.deleteLine(this.verifyMutation(request), input);
  }

  @Post("submit")
  submit(@Body() input: PurchaseOrderLifecycleDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.submit(this.verifyMutation(request), input);
  }

  @Post("approve")
  approve(@Body() input: PurchaseOrderLifecycleDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.approve(this.verifyMutation(request), input);
  }

  @Post("withdraw")
  withdraw(@Body() input: PurchaseOrderLifecycleReasonDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.withdraw(this.verifyMutation(request), input);
  }

  @Post("cancel-draft")
  cancelDraft(
    @Body() input: PurchaseOrderLifecycleReasonDto,
    @Req() request: PurchaseOrderRequest,
  ) {
    return this.purchaseOrders.cancelDraft(this.verifyMutation(request), input);
  }

  @Post("request-cancellation")
  requestCancellation(
    @Body() input: PurchaseOrderLifecycleReasonDto,
    @Req() request: PurchaseOrderRequest,
  ) {
    return this.purchaseOrders.requestCancellation(this.verifyMutation(request), input);
  }

  @Post("decide-cancellation")
  decideCancellation(
    @Body() input: PurchaseOrderCancellationDecisionDto,
    @Req() request: PurchaseOrderRequest,
  ) {
    return this.purchaseOrders.decideCancellation(this.verifyMutation(request), input);
  }

  @Post()
  create(@Body() input: CreatePurchaseOrderDto, @Req() request: PurchaseOrderRequest) {
    return this.purchaseOrders.create(this.verifyMutation(request), input);
  }
}
