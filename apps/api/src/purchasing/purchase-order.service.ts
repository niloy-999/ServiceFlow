import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthorizationService } from "../authorization/authorization.service.js";
import type {
  CreatePurchaseOrderDto,
  CreatePurchaseOrderLineDto,
  DeletePurchaseOrderLineDto,
  PurchaseOrderCancellationDecisionDto,
  PurchaseOrderLifecycleDto,
  PurchaseOrderLifecycleReasonDto,
  PurchaseOrderLineListDto,
  PurchaseOrderListDto,
  UpdatePurchaseOrderLineDto,
} from "./dto/purchase-order.dto.js";

type PurchaseOrderTransaction = Prisma.TransactionClient;
type PurchaseOrderPermission = "purchasing.read" | "purchasing.manage" | "purchasing.approve";

type PurchaseOrderRow = {
  id: string;
  branchId: string;
  supplierId: string;
  orderNumber: string;
  currency: string;
  status: string;
  notes: string | null;
  createdByUserId: string;
  submittedByUserId: string | null;
  submittedAt: Date | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  cancelledByUserId: string | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  withdrawnByUserId: string | null;
  withdrawnAt: Date | null;
  withdrawalReason: string | null;
  version: string;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class PurchaseOrderService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private run<T>(
    userId: string,
    tenantId: string,
    permission: PurchaseOrderPermission,
    operation: "VIEW" | "OPERATE",
    branchId: string | undefined,
    callback: (tx: PurchaseOrderTransaction) => Promise<T>,
  ): Promise<T> {
    return this.authorization.withPermission({
      userId,
      tenantId,
      permission,
      operation,
      ...(branchId ? { branchId } : {}),
      callback,
    });
  }

  private async lockDraftOrder(
    tx: PurchaseOrderTransaction,
    input: {
      tenantId: string;
      branchId: string;
      purchaseOrderId: string;
      version: number;
    },
  ) {
    const rows = await tx.$queryRaw<{ status: string; version: string }[]>`
      SELECT status::text AS status, version::text AS version
      FROM purchase_orders
      WHERE tenant_id = ${input.tenantId}::uuid
        AND branch_id = ${input.branchId}::uuid
        AND id = ${input.purchaseOrderId}::uuid
      FOR UPDATE
    `;

    const order = rows[0];

    if (!order) {
      throw new NotFoundException("The purchase order is unavailable.");
    }

    if (order.status !== "DRAFT") {
      throw new ConflictException("Only draft purchase orders can be edited.");
    }

    if (BigInt(order.version) !== BigInt(input.version)) {
      throw new ConflictException("The purchase order has changed. Reload it before editing.");
    }
  }

  private async incrementDraftOrderVersion(
    tx: PurchaseOrderTransaction,
    input: {
      tenantId: string;
      branchId: string;
      purchaseOrderId: string;
      version: number;
    },
  ) {
    const updated = await tx.$executeRaw`
      UPDATE purchase_orders
      SET version = version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ${input.tenantId}::uuid
        AND branch_id = ${input.branchId}::uuid
        AND id = ${input.purchaseOrderId}::uuid
        AND status = 'DRAFT'
        AND version = ${BigInt(input.version)}
    `;

    if (updated !== 1) {
      throw new ConflictException("The purchase order version could not be advanced.");
    }
  }

  private validateUnitCost(unitCostMinor: string) {
    if (BigInt(unitCostMinor) > 9223372036854775807n) {
      throw new BadRequestException("Unit cost exceeds the supported database range.");
    }
  }

  private async lockLifecycleOrder(tx: PurchaseOrderTransaction, input: PurchaseOrderLifecycleDto) {
    const rows = await tx.$queryRaw<{ status: string; version: string; createdByUserId: string }[]>`
      SELECT
        status::text AS status,
        version::text AS version,
        created_by_user_id AS "createdByUserId"
      FROM purchase_orders
      WHERE tenant_id = ${input.tenantId}::uuid
        AND branch_id = ${input.branchId}::uuid
        AND id = ${input.purchaseOrderId}::uuid
      FOR UPDATE
    `;

    const order = rows[0];
    if (!order) {
      throw new NotFoundException("The purchase order is unavailable.");
    }
    if (BigInt(order.version) !== BigInt(input.version)) {
      throw new ConflictException("The purchase order has changed. Reload it before continuing.");
    }
    return order;
  }

  async submit(userId: string, input: PurchaseOrderLifecycleDto) {
    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "DRAFT") {
          throw new ConflictException("Only draft purchase orders can be submitted.");
        }

        const lineCounts = await tx.$queryRaw<{ count: bigint }[]>`
          SELECT count(*)::bigint AS count
          FROM purchase_order_lines
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
        `;
        if (!lineCounts[0] || lineCounts[0].count === 0n) {
          throw new ConflictException(
            "A purchase order requires at least one line before submission.",
          );
        }

        const rows = await tx.$queryRaw<{ status: string; version: string }[]>`
          UPDATE purchase_orders
          SET status = 'PENDING_APPROVAL',
              submitted_by_user_id = ${userId}::uuid,
              submitted_at = CURRENT_TIMESTAMP,
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${input.purchaseOrderId}::uuid
            AND status = 'DRAFT'
            AND version = ${BigInt(input.version)}
          RETURNING status::text AS status, version::text AS version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new ConflictException("The purchase order could not be submitted.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.submitted",
          targetType: "purchase_order",
          targetId: input.purchaseOrderId,
          outcome: "SUCCESS",
          metadata: { previousVersion: input.version, newVersion: updated.version },
        });
        return { id: input.purchaseOrderId, ...updated };
      },
    );
  }

  async approve(userId: string, input: PurchaseOrderLifecycleDto) {
    return this.run(
      userId,
      input.tenantId,
      "purchasing.approve",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "PENDING_APPROVAL") {
          throw new ConflictException("Only pending purchase orders can be approved.");
        }
        const rows = await tx.$queryRaw<{ status: string; version: string }[]>`
          UPDATE purchase_orders
          SET status = 'APPROVED',
              approved_by_user_id = ${userId}::uuid,
              approved_at = CURRENT_TIMESTAMP,
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${input.purchaseOrderId}::uuid
            AND status = 'PENDING_APPROVAL'
            AND version = ${BigInt(input.version)}
          RETURNING status::text AS status, version::text AS version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new ConflictException("Only a pending purchase order can be approved.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.approved",
          targetType: "purchase_order",
          targetId: input.purchaseOrderId,
          outcome: "SUCCESS",
          metadata: { previousVersion: input.version, newVersion: updated.version },
        });
        return { id: input.purchaseOrderId, ...updated };
      },
    );
  }

  async withdraw(userId: string, input: PurchaseOrderLifecycleReasonDto) {
    const reason = input.reason.trim();
    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "PENDING_APPROVAL") {
          throw new ConflictException("Only pending purchase orders can be withdrawn.");
        }
        if (order.createdByUserId !== userId) {
          throw new ForbiddenException("Only the original purchase order creator can withdraw it.");
        }

        const rows = await tx.$queryRaw<{ status: string; version: string }[]>`
          UPDATE purchase_orders
          SET status = 'WITHDRAWN',
              withdrawn_by_user_id = ${userId}::uuid,
              withdrawn_at = CURRENT_TIMESTAMP,
              withdrawal_reason = ${reason},
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${input.purchaseOrderId}::uuid
            AND status = 'PENDING_APPROVAL'
            AND version = ${BigInt(input.version)}
          RETURNING status::text AS status, version::text AS version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new ConflictException("Only a pending purchase order can be withdrawn.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.withdrawn",
          targetType: "purchase_order",
          targetId: input.purchaseOrderId,
          outcome: "SUCCESS",
          metadata: { reason, previousVersion: input.version, newVersion: updated.version },
        });
        return { id: input.purchaseOrderId, ...updated };
      },
    );
  }

  async cancelDraft(userId: string, input: PurchaseOrderLifecycleReasonDto) {
    const reason = input.reason.trim();
    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "DRAFT") {
          throw new ConflictException("Only draft purchase orders can be cancelled directly.");
        }
        if (order.createdByUserId !== userId) {
          throw new ForbiddenException(
            "Only the original purchase order creator can cancel a draft.",
          );
        }

        const rows = await tx.$queryRaw<{ status: string; version: string }[]>`
          UPDATE purchase_orders
          SET status = 'CANCELLED',
              cancelled_by_user_id = ${userId}::uuid,
              cancelled_at = CURRENT_TIMESTAMP,
              cancellation_reason = ${reason},
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${input.purchaseOrderId}::uuid
            AND status = 'DRAFT'
            AND version = ${BigInt(input.version)}
          RETURNING status::text AS status, version::text AS version
        `;
        const updated = rows[0];
        if (!updated) {
          throw new ConflictException("Only a draft purchase order can be cancelled directly.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.draft_cancelled",
          targetType: "purchase_order",
          targetId: input.purchaseOrderId,
          outcome: "SUCCESS",
          metadata: { reason, previousVersion: input.version, newVersion: updated.version },
        });
        return { id: input.purchaseOrderId, ...updated };
      },
    );
  }

  async requestCancellation(userId: string, input: PurchaseOrderLifecycleReasonDto) {
    const reason = input.reason.trim();
    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "APPROVED") {
          throw new ConflictException(
            "Only approved purchase orders can have cancellation requested.",
          );
        }
        if (order.createdByUserId !== userId) {
          throw new ForbiddenException(
            "Only the original purchase order creator can request cancellation.",
          );
        }

        const pending = await tx.$queryRaw<{ id: string }[]>`
          SELECT id
          FROM purchase_order_cancellation_requests
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND status = 'PENDING'
          LIMIT 1
          FOR UPDATE
        `;
        if (pending[0]) {
          throw new ConflictException(
            "A cancellation request is already pending for this purchase order.",
          );
        }

        const requestId = randomUUID();
        const created = await tx.$queryRaw<{ id: string; status: string; version: string }[]>`
          INSERT INTO purchase_order_cancellation_requests (
            id,
            tenant_id,
            purchase_order_id,
            requested_by_user_id,
            request_reason,
            status,
            updated_at
          )
          VALUES (
            ${requestId}::uuid,
            ${input.tenantId}::uuid,
            ${input.purchaseOrderId}::uuid,
            ${userId}::uuid,
            ${reason},
            'PENDING',
            CURRENT_TIMESTAMP
          )
          RETURNING id, status::text AS status, version::text AS version
        `;
        const request = created[0];
        if (!request) {
          throw new ConflictException("The cancellation request could not be created.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.cancellation_requested",
          targetType: "purchase_order_cancellation_request",
          targetId: requestId,
          outcome: "SUCCESS",
          metadata: { purchaseOrderId: input.purchaseOrderId, reason },
        });
        return { ...request, purchaseOrderId: input.purchaseOrderId };
      },
    );
  }

  async decideCancellation(userId: string, input: PurchaseOrderCancellationDecisionDto) {
    const reason = input.reason?.trim() || null;
    if (input.decision === "REJECTED" && !reason) {
      throw new BadRequestException("A reason is required to reject a cancellation request.");
    }

    return this.run(
      userId,
      input.tenantId,
      "purchasing.approve",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const order = await this.lockLifecycleOrder(tx, input);
        if (order.status !== "APPROVED") {
          throw new ConflictException(
            "The purchase order is no longer awaiting cancellation review.",
          );
        }

        const requests = await tx.$queryRaw<
          { id: string; status: string; version: string; requestedByUserId: string }[]
        >`
          SELECT
            id,
            status::text AS status,
            version::text AS version,
            requested_by_user_id AS "requestedByUserId"
          FROM purchase_order_cancellation_requests
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND id = ${input.cancellationRequestId}::uuid
          FOR UPDATE
        `;
        const request = requests[0];
        if (!request) {
          throw new NotFoundException("The cancellation request is unavailable.");
        }
        if (request.status !== "PENDING") {
          throw new ConflictException("This cancellation request has already been decided.");
        }
        if (BigInt(request.version) !== BigInt(input.requestVersion)) {
          throw new ConflictException(
            "The cancellation request has changed. Reload it before deciding.",
          );
        }
        if (request.requestedByUserId === userId) {
          throw new ForbiddenException(
            "The cancellation requester cannot review their own request.",
          );
        }

        const updatedRequests = await tx.$queryRaw<
          { id: string; status: string; version: string; decidedAt: Date }[]
        >`
          UPDATE purchase_order_cancellation_requests
          SET status = ${input.decision}::"PurchaseOrderCancellationStatus",
              decided_by_user_id = ${userId}::uuid,
              decided_at = CURRENT_TIMESTAMP,
              decision_reason = ${reason},
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND id = ${input.cancellationRequestId}::uuid
            AND status = 'PENDING'
            AND version = ${BigInt(input.requestVersion)}
          RETURNING
            id,
            status::text AS status,
            version::text AS version,
            decided_at AS "decidedAt"
        `;
        const updatedRequest = updatedRequests[0];
        if (!updatedRequest) {
          throw new ConflictException("The cancellation request could not be decided.");
        }

        const orders = await tx.$queryRaw<{ status: string; version: string }[]>`
          SELECT status::text AS status, version::text AS version
          FROM purchase_orders
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${input.purchaseOrderId}::uuid
        `;
        const updatedOrder = orders[0];
        if (!updatedOrder) {
          throw new NotFoundException("The purchase order is unavailable.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action:
            input.decision === "APPROVED"
              ? "purchasing.purchase_order.cancellation_approved"
              : "purchasing.purchase_order.cancellation_rejected",
          targetType: "purchase_order_cancellation_request",
          targetId: input.cancellationRequestId,
          outcome: "SUCCESS",
          metadata: {
            purchaseOrderId: input.purchaseOrderId,
            decision: input.decision,
            reason,
            purchaseOrderStatus: updatedOrder.status,
            purchaseOrderVersion: updatedOrder.version,
          },
        });

        return {
          ...updatedRequest,
          purchaseOrderId: input.purchaseOrderId,
          purchaseOrderStatus: updatedOrder.status,
          purchaseOrderVersion: updatedOrder.version,
        };
      },
    );
  }

  async list(userId: string, input: PurchaseOrderListDto) {
    return this.run(
      userId,
      input.tenantId,
      "purchasing.read",
      "VIEW",
      input.branchId,
      async (tx) => {
        const purchaseOrders = await tx.$queryRaw<PurchaseOrderRow[]>`
          SELECT
            id,
            branch_id AS "branchId",
            supplier_id AS "supplierId",
            order_number AS "orderNumber",
            currency,
            status::text AS status,
            notes,
            created_by_user_id AS "createdByUserId",
            submitted_by_user_id AS "submittedByUserId",
            submitted_at AS "submittedAt",
            approved_by_user_id AS "approvedByUserId",
            approved_at AS "approvedAt",
            cancelled_by_user_id AS "cancelledByUserId",
            cancelled_at AS "cancelledAt",
            cancellation_reason AS "cancellationReason",
            withdrawn_by_user_id AS "withdrawnByUserId",
            withdrawn_at AS "withdrawnAt",
            withdrawal_reason AS "withdrawalReason",
            version::text AS version,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM purchase_orders
          WHERE tenant_id = ${input.tenantId}::uuid
            AND (${input.branchId ?? null}::uuid IS NULL
              OR branch_id = ${input.branchId ?? null}::uuid)
            AND (${input.status ?? null}::text IS NULL
              OR status::text = ${input.status ?? null}::text)
          ORDER BY created_at DESC, id DESC
        `;

        return { purchaseOrders };
      },
    );
  }

  async listLines(userId: string, input: PurchaseOrderLineListDto) {
    return this.run(
      userId,
      input.tenantId,
      "purchasing.read",
      "VIEW",
      input.branchId,
      async (tx) => {
        const lines = await tx.$queryRaw<
          {
            id: string;
            productId: string;
            variantId: string;
            productCodeSnapshot: string;
            productNameSnapshot: string;
            variantCodeSnapshot: string;
            skuSnapshot: string;
            variantNameSnapshot: string;
            orderedQuantity: number;
            unitCostMinor: string;
            createdAt: Date;
            updatedAt: Date;
          }[]
        >`
          SELECT
            id,
            product_id AS "productId",
            variant_id AS "variantId",
            product_code_snapshot AS "productCodeSnapshot",
            product_name_snapshot AS "productNameSnapshot",
            variant_code_snapshot AS "variantCodeSnapshot",
            sku_snapshot AS "skuSnapshot",
            variant_name_snapshot AS "variantNameSnapshot",
            ordered_quantity AS "orderedQuantity",
            unit_cost_minor::text AS "unitCostMinor",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM purchase_order_lines
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND EXISTS (
              SELECT 1
              FROM purchase_orders po
              WHERE po.tenant_id = ${input.tenantId}::uuid
                AND po.id = ${input.purchaseOrderId}::uuid
                AND po.branch_id = ${input.branchId}::uuid
            )
          ORDER BY created_at, id
        `;

        return { lines };
      },
    );
  }

  async createLine(userId: string, input: CreatePurchaseOrderLineDto) {
    this.validateUnitCost(input.unitCostMinor);

    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        await this.lockDraftOrder(tx, input);

        const id = randomUUID();
        const rows = await tx.$queryRaw<
          {
            id: string;
            productCodeSnapshot: string;
            productNameSnapshot: string;
            variantCodeSnapshot: string;
            skuSnapshot: string;
            variantNameSnapshot: string;
            orderedQuantity: number;
            unitCostMinor: string;
          }[]
        >`
          INSERT INTO purchase_order_lines (
            id,
            tenant_id,
            purchase_order_id,
            product_id,
            variant_id,
            product_code_snapshot,
            product_name_snapshot,
            variant_code_snapshot,
            sku_snapshot,
            variant_name_snapshot,
            ordered_quantity,
            unit_cost_minor,
            updated_at
          )
          VALUES (
            ${id}::uuid,
            ${input.tenantId}::uuid,
            ${input.purchaseOrderId}::uuid,
            ${input.productId}::uuid,
            ${input.variantId}::uuid,
            '',
            '',
            '',
            '',
            '',
            ${input.orderedQuantity},
            ${BigInt(input.unitCostMinor)},
            CURRENT_TIMESTAMP
          )
          RETURNING
            id,
            product_code_snapshot AS "productCodeSnapshot",
            product_name_snapshot AS "productNameSnapshot",
            variant_code_snapshot AS "variantCodeSnapshot",
            sku_snapshot AS "skuSnapshot",
            variant_name_snapshot AS "variantNameSnapshot",
            ordered_quantity AS "orderedQuantity",
            unit_cost_minor::text AS "unitCostMinor"
        `;

        const created = rows[0];
        if (!created) {
          throw new ConflictException("The purchase order line could not be created.");
        }

        await this.incrementDraftOrderVersion(tx, input);

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.line_created",
          targetType: "purchase_order_line",
          targetId: id,
          outcome: "SUCCESS",
          metadata: {
            purchaseOrderId: input.purchaseOrderId,
            productId: input.productId,
            variantId: input.variantId,
            orderedQuantity: input.orderedQuantity,
            unitCostMinor: input.unitCostMinor,
            newOrderVersion: input.version + 1,
          },
        });

        return created;
      },
    );
  }

  async updateLine(userId: string, input: UpdatePurchaseOrderLineDto) {
    this.validateUnitCost(input.unitCostMinor);

    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        await this.lockDraftOrder(tx, input);

        const rows = await tx.$queryRaw<
          {
            id: string;
            orderedQuantity: number;
            unitCostMinor: string;
          }[]
        >`
          UPDATE purchase_order_lines
          SET ordered_quantity = ${input.orderedQuantity},
              unit_cost_minor = ${BigInt(input.unitCostMinor)},
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND id = ${input.lineId}::uuid
          RETURNING
            id,
            ordered_quantity AS "orderedQuantity",
            unit_cost_minor::text AS "unitCostMinor"
        `;

        const updated = rows[0];
        if (!updated) {
          throw new NotFoundException("The purchase order line is unavailable.");
        }

        await this.incrementDraftOrderVersion(tx, input);

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.line_updated",
          targetType: "purchase_order_line",
          targetId: input.lineId,
          outcome: "SUCCESS",
          metadata: {
            purchaseOrderId: input.purchaseOrderId,
            orderedQuantity: input.orderedQuantity,
            unitCostMinor: input.unitCostMinor,
            newOrderVersion: input.version + 1,
          },
        });

        return updated;
      },
    );
  }

  async deleteLine(userId: string, input: DeletePurchaseOrderLineDto) {
    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        await this.lockDraftOrder(tx, input);

        const deleted = await tx.$executeRaw`
          DELETE FROM purchase_order_lines
          WHERE tenant_id = ${input.tenantId}::uuid
            AND purchase_order_id = ${input.purchaseOrderId}::uuid
            AND id = ${input.lineId}::uuid
        `;

        if (deleted !== 1) {
          throw new NotFoundException("The purchase order line is unavailable.");
        }

        await this.incrementDraftOrderVersion(tx, input);

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.line_deleted",
          targetType: "purchase_order_line",
          targetId: input.lineId,
          outcome: "SUCCESS",
          metadata: {
            purchaseOrderId: input.purchaseOrderId,
            newOrderVersion: input.version + 1,
          },
        });

        return { id: input.lineId, deleted: true };
      },
    );
  }

  async create(userId: string, input: CreatePurchaseOrderDto) {
    const id = randomUUID();
    const notes = input.notes?.trim() || null;

    return this.run(
      userId,
      input.tenantId,
      "purchasing.manage",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const businesses = await tx.$queryRaw<{ currency: string }[]>`
          SELECT btrim(default_currency) AS currency
          FROM businesses
          WHERE id = ${input.tenantId}::uuid
        `;

        if (!businesses[0]) {
          throw new Error("The business currency could not be resolved.");
        }

        const currency = input.currency ?? businesses[0].currency;

        const counters = await tx.$queryRaw<{ allocatedNumber: string }[]>`
          INSERT INTO purchase_order_counters (
            tenant_id,
            next_number,
            updated_at
          )
          VALUES (
            ${input.tenantId}::uuid,
            2,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (tenant_id)
          DO UPDATE SET
            next_number = purchase_order_counters.next_number + 1,
            updated_at = CURRENT_TIMESTAMP
          RETURNING (next_number - 1)::text AS "allocatedNumber"
        `;

        if (!counters[0]) {
          throw new Error("A purchase order number could not be allocated.");
        }

        const orderNumber = `PO-${counters[0].allocatedNumber.padStart(6, "0")}`;

        const rows = await tx.$queryRaw<
          {
            id: string;
            orderNumber: string;
            currency: string;
            status: string;
            version: string;
            createdAt: Date;
          }[]
        >`
          INSERT INTO purchase_orders (
            id,
            tenant_id,
            branch_id,
            supplier_id,
            order_number,
            currency,
            notes,
            created_by_user_id,
            updated_at
          )
          VALUES (
            ${id}::uuid,
            ${input.tenantId}::uuid,
            ${input.branchId}::uuid,
            ${input.supplierId}::uuid,
            ${orderNumber},
            ${currency},
            ${notes},
            ${userId}::uuid,
            CURRENT_TIMESTAMP
          )
          RETURNING
            id,
            order_number AS "orderNumber",
            currency,
            status::text AS status,
            version::text AS version,
            created_at AS "createdAt"
        `;

        const created = rows[0];

        if (!created) {
          throw new Error("The purchase order could not be created.");
        }

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "purchasing.purchase_order.created",
          targetType: "purchase_order",
          targetId: id,
          outcome: "SUCCESS",
          metadata: {
            orderNumber: created.orderNumber,
            branchId: input.branchId,
            supplierId: input.supplierId,
            currency: created.currency,
          },
        });

        return {
          ...created,
          branchId: input.branchId,
          supplierId: input.supplierId,
          notes,
        };
      },
    );
  }
}
