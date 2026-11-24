import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthorizationService } from "../authorization/authorization.service.js";
import type {
  DecideInventoryAdjustmentDto,
  InventorySerialChangeDto,
  SubmitInventoryAdjustmentDto,
} from "./dto/inventory.dto.js";

type InventoryTransaction = Prisma.TransactionClient;
type SerialChange = { action: "ADD" | "REMOVE"; serial: string };
type OperationType = "ADJUSTMENT_SUBMIT" | "ADJUSTMENT_APPROVE" | "ADJUSTMENT_REJECT";

interface AdjustmentRecord {
  id: string;
  tenantId: string;
  branchId: string;
  productId: string;
  variantId: string;
  requestedBy: string;
  quantityDelta: number;
  reason: string;
  serialChanges: SerialChange[];
  status: "PENDING" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

interface ProductInventoryRecord {
  trackSerials: boolean;
}

interface BalanceRecord {
  physicalQuantity: number;
  reservedQuantity: number;
  inTransitQuantity: number;
}

export interface AdjustmentReadRecord {
  id: string;
  tenantId: string;
  branchId: string;
  productId: string;
  variantId: string;
  requestedBy: string;
  quantityDelta: number;
  reason: string;
  serialChanges: Prisma.JsonValue;
  status: "PENDING" | "APPROVED" | "REJECTED";
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  physicalQuantity: number | null;
  reservedQuantity: number | null;
  inTransitQuantity: number | null;
}

const NORMALIZE_SERIAL = (value: string): string => value.normalize("NFKC").trim().toUpperCase();

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function dbConflict(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "P2002" ||
      ((error as { code?: string }).code === "P2010" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.includes("Code: `23505`")))
  ) {
    throw new ConflictException("An inventory identifier or serial number already exists.");
  }
  throw error;
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async run<T>(
    userId: string,
    tenantId: string,
    permission: "inventory.read" | "inventory.adjust" | "inventory.adjust.approve",
    operation: "VIEW" | "OPERATE",
    branchId: string,
    callback: (tx: InventoryTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.authorization.withPermission({
        userId,
        tenantId,
        permission,
        branchId,
        operation,
        callback,
      });
    } catch (error) {
      dbConflict(error);
    }
  }

  private async lockIdempotencyKey(
    tx: InventoryTransaction,
    tenantId: string,
    key: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${tenantId}:${key}`}, 0)
      )
    `;
  }

  private async replayOperation(
    tx: InventoryTransaction,
    input: {
      tenantId: string;
      idempotencyKey: string;
      hash: string;
      actorUserId: string;
      operationType: OperationType;
    },
  ): Promise<Record<string, unknown> | null> {
    const rows = await tx.$queryRaw<
      {
        requestHash: string;
        actorUserId: string;
        operationType: OperationType;
        result: Record<string, unknown> | null;
        completedAt: Date | null;
      }[]
    >`
      SELECT
        request_hash AS "requestHash",
        actor_user_id AS "actorUserId",
        operation_type AS "operationType",
        result,
        completed_at AS "completedAt"
      FROM inventory_operations
      WHERE tenant_id = ${input.tenantId}::uuid
        AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;

    const existing = rows[0];
    if (!existing) return null;

    if (
      existing.requestHash.trim() !== input.hash ||
      existing.actorUserId !== input.actorUserId ||
      existing.operationType !== input.operationType ||
      !existing.completedAt ||
      !existing.result
    ) {
      throw new ConflictException(
        "This idempotency key has already been used for a different inventory operation.",
      );
    }

    return existing.result;
  }

  private async createOperation(
    tx: InventoryTransaction,
    input: {
      tenantId: string;
      actorUserId: string;
      operationType: OperationType;
      idempotencyKey: string;
      hash: string;
      targetId: string;
    },
  ): Promise<string> {
    const id = randomUUID();

    await tx.$executeRaw`
      INSERT INTO inventory_operations (
        id,
        tenant_id,
        operation_type,
        idempotency_key,
        request_hash,
        actor_user_id,
        target_id
      )
      VALUES (
        ${id}::uuid,
        ${input.tenantId}::uuid,
        ${input.operationType}::"InventoryOperationType",
        ${input.idempotencyKey},
        ${input.hash},
        ${input.actorUserId}::uuid,
        ${input.targetId}::uuid
      )
    `;

    return id;
  }

  private async completeOperation(
    tx: InventoryTransaction,
    operationId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    const updated = await tx.$executeRaw`
      UPDATE inventory_operations
      SET result = ${JSON.stringify(result)}::jsonb,
          completed_at = CURRENT_TIMESTAMP
      WHERE id = ${operationId}::uuid
        AND result IS NULL
        AND completed_at IS NULL
    `;

    if (updated !== 1) {
      throw new ConflictException("The inventory operation could not be completed exactly once.");
    }
  }

  private canonicalizeSerialChanges(
    changes: InventorySerialChangeDto[] | undefined,
  ): SerialChange[] {
    const normalized = (changes ?? []).map((change) => ({
      action: change.action,
      serial: NORMALIZE_SERIAL(change.serial),
    }));

    if (
      normalized.some(
        (change) =>
          (change.action !== "ADD" && change.action !== "REMOVE") ||
          !change.serial ||
          change.serial.length > 160,
      )
    ) {
      throw new BadRequestException(
        "Every serial change must contain a valid action and serial number.",
      );
    }

    const unique = new Set(normalized.map((change) => change.serial));
    if (unique.size !== normalized.length) {
      throw new BadRequestException("An adjustment cannot contain duplicate serial numbers.");
    }

    return normalized;
  }

  private normalizeSerialChanges(
    normalized: SerialChange[],
    quantityDelta: number,
    trackSerials: boolean,
  ): SerialChange[] {
    if (!trackSerials) {
      if (normalized.length > 0) {
        throw new BadRequestException(
          "Serial numbers cannot be supplied for a product without serial tracking.",
        );
      }
      return [];
    }

    const expectedAction = quantityDelta > 0 ? "ADD" : "REMOVE";
    if (
      normalized.length !== Math.abs(quantityDelta) ||
      normalized.some((change) => change.action !== expectedAction)
    ) {
      throw new BadRequestException(
        `A serial-tracked adjustment requires exactly ${Math.abs(quantityDelta)} ${expectedAction} serial number(s).`,
      );
    }

    return normalized;
  }

  private async validateProductVariant(
    tx: InventoryTransaction,
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<ProductInventoryRecord> {
    const rows = await tx.$queryRaw<
      (ProductInventoryRecord & { productStatus: string; variantStatus: string })[]
    >`
      SELECT
        p.track_serials AS "trackSerials",
        p.status AS "productStatus",
        v.status AS "variantStatus"
      FROM products AS p
      INNER JOIN product_variants AS v
        ON v.tenant_id = p.tenant_id
        AND v.product_id = p.id
      WHERE p.tenant_id = ${tenantId}::uuid
        AND p.id = ${productId}::uuid
        AND v.id = ${variantId}::uuid
      LIMIT 1
    `;

    const product = rows[0];
    if (!product || product.productStatus !== "ACTIVE" || product.variantStatus !== "ACTIVE") {
      throw new BadRequestException(
        "The selected product and variant must both be active and belong together.",
      );
    }

    return { trackSerials: product.trackSerials };
  }

  async submitAdjustment(userId: string, input: SubmitInventoryAdjustmentDto) {
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException("An adjustment reason is required.");

    return this.run(
      userId,
      input.tenantId,
      "inventory.adjust",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const canonicalSerialChanges = this.canonicalizeSerialChanges(input.serialChanges);

        const canonical = {
          tenantId: input.tenantId,
          branchId: input.branchId,
          productId: input.productId,
          variantId: input.variantId,
          quantityDelta: input.quantityDelta,
          reason,
          serialChanges: canonicalSerialChanges,
        };
        const hash = requestHash(canonical);

        await this.lockIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
        const replay = await this.replayOperation(tx, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          hash,
          actorUserId: userId,
          operationType: "ADJUSTMENT_SUBMIT",
        });
        if (replay) return replay;

        const product = await this.validateProductVariant(
          tx,
          input.tenantId,
          input.productId,
          input.variantId,
        );
        const serialChanges = this.normalizeSerialChanges(
          canonicalSerialChanges,
          input.quantityDelta,
          product.trackSerials,
        );

        const adjustmentId = randomUUID();
        const operationId = await this.createOperation(tx, {
          tenantId: input.tenantId,
          actorUserId: userId,
          operationType: "ADJUSTMENT_SUBMIT",
          idempotencyKey: input.idempotencyKey,
          hash,
          targetId: adjustmentId,
        });

        await tx.$executeRaw`
          INSERT INTO inventory_adjustments (
            id,
            tenant_id,
            branch_id,
            product_id,
            variant_id,
            requested_by,
            submission_operation_id,
            quantity_delta,
            reason,
            serial_changes,
            updated_at
          )
          VALUES (
            ${adjustmentId}::uuid,
            ${input.tenantId}::uuid,
            ${input.branchId}::uuid,
            ${input.productId}::uuid,
            ${input.variantId}::uuid,
            ${userId}::uuid,
            ${operationId}::uuid,
            ${input.quantityDelta},
            ${reason},
            ${JSON.stringify(serialChanges)}::jsonb,
            CURRENT_TIMESTAMP
          )
        `;

        const result = {
          id: adjustmentId,
          tenantId: input.tenantId,
          branchId: input.branchId,
          productId: input.productId,
          variantId: input.variantId,
          quantityDelta: input.quantityDelta,
          reason,
          serialChanges,
          status: "PENDING",
          requestedBy: userId,
        };

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "inventory.adjustment.submitted",
          targetType: "inventory_adjustment",
          targetId: adjustmentId,
          outcome: "SUCCESS",
        });

        await this.completeOperation(tx, operationId, result);
        return result;
      },
    );
  }

  async approveAdjustment(
    userId: string,
    adjustmentId: string,
    input: DecideInventoryAdjustmentDto,
  ) {
    return this.run(
      userId,
      input.tenantId,
      "inventory.adjust.approve",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const decisionReason = input.decisionReason?.trim() || null;
        const negativeStockReason = input.negativeStockReason?.trim() || null;
        const hash = requestHash({
          tenantId: input.tenantId,
          branchId: input.branchId,
          adjustmentId,
          decisionReason,
          negativeStockReason,
        });

        await this.lockIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
        const replay = await this.replayOperation(tx, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          hash,
          actorUserId: userId,
          operationType: "ADJUSTMENT_APPROVE",
        });
        if (replay) return replay;

        const adjustments = await tx.$queryRaw<AdjustmentRecord[]>`
          SELECT
            id,
            tenant_id AS "tenantId",
            branch_id AS "branchId",
            product_id AS "productId",
            variant_id AS "variantId",
            requested_by AS "requestedBy",
            quantity_delta AS "quantityDelta",
            reason,
            serial_changes AS "serialChanges",
            status,
            decided_by AS "decidedBy",
            decision_reason AS "decisionReason",
            decided_at AS "decidedAt",
            created_at AS "createdAt"
          FROM inventory_adjustments
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${adjustmentId}::uuid
          FOR UPDATE
        `;
        const adjustment = adjustments[0];
        if (!adjustment) {
          throw new NotFoundException("The inventory adjustment is unavailable.");
        }
        if (adjustment.status !== "PENDING") {
          throw new ConflictException("This adjustment has already been decided.");
        }
        if (adjustment.requestedBy === userId) {
          throw new ConflictException(
            "The requester cannot approve their own inventory adjustment.",
          );
        }

        const product = await this.validateProductVariant(
          tx,
          input.tenantId,
          adjustment.productId,
          adjustment.variantId,
        );
        const serialChanges = this.normalizeSerialChanges(
          adjustment.serialChanges,
          adjustment.quantityDelta,
          product.trackSerials,
        );

        // Ensure a zero projection exists before the ledger's BEFORE INSERT check.
        await tx.$executeRaw`
          INSERT INTO inventory_balances (
            id, tenant_id, branch_id, product_id, variant_id,
            physical_quantity, reserved_quantity, in_transit_quantity,
            updated_at
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${input.tenantId}::uuid,
            ${input.branchId}::uuid,
            ${adjustment.productId}::uuid,
            ${adjustment.variantId}::uuid,
            0, 0, 0, CURRENT_TIMESTAMP
          )
          ON CONFLICT (tenant_id, branch_id, variant_id) DO NOTHING
        `;

        const balances = await tx.$queryRaw<BalanceRecord[]>`
          SELECT
            physical_quantity AS "physicalQuantity",
            reserved_quantity AS "reservedQuantity",
            in_transit_quantity AS "inTransitQuantity"
          FROM inventory_balances
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND variant_id = ${adjustment.variantId}::uuid
          FOR UPDATE
        `;
        const balance = balances[0];
        if (!balance) {
          throw new ConflictException("The inventory balance could not be locked.");
        }

        const physicalAfter = balance.physicalQuantity + adjustment.quantityDelta;
        const availableAfter = physicalAfter - balance.reservedQuantity;
        if (physicalAfter < 0) {
          throw new ConflictException("This adjustment would make physical stock negative.");
        }

        if (availableAfter < 0) {
          if (!negativeStockReason) {
            throw new BadRequestException(
              "A reason is required when an adjustment makes available stock negative.",
            );
          }
          await this.authorization.assertPermissionInTransaction(tx, {
            userId,
            tenantId: input.tenantId,
            branchId: input.branchId,
            permission: "inventory.override_negative",
            operation: "OPERATE",
          });
        }

        const operationId = await this.createOperation(tx, {
          tenantId: input.tenantId,
          actorUserId: userId,
          operationType: "ADJUSTMENT_APPROVE",
          idempotencyKey: input.idempotencyKey,
          hash,
          targetId: adjustmentId,
        });

        const updated = await tx.$executeRaw`
          UPDATE inventory_adjustments
          SET status = 'APPROVED',
              decided_by = ${userId}::uuid,
              decision_reason = ${decisionReason},
              decided_at = CURRENT_TIMESTAMP,
              decision_operation_id = ${operationId}::uuid,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${adjustmentId}::uuid
            AND status = 'PENDING'
        `;

        if (updated !== 1) {
          throw new ConflictException(
            "The inventory adjustment could not be decided exactly once.",
          );
        }

        // The ledger trigger validates balance_after against the old projection.
        await tx.$executeRaw`
          INSERT INTO inventory_ledger_entries (
            id, tenant_id, branch_id, product_id, variant_id,
            adjustment_id, operation_id, quantity_delta, balance_after, actor_user_id
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${input.tenantId}::uuid,
            ${input.branchId}::uuid,
            ${adjustment.productId}::uuid,
            ${adjustment.variantId}::uuid,
            ${adjustmentId}::uuid,
            ${operationId}::uuid,
            ${adjustment.quantityDelta},
            ${physicalAfter},
            ${userId}::uuid
          )
        `;

        for (const change of serialChanges) {
          if (change.action === "ADD") {
            await tx.$executeRaw`
              INSERT INTO inventory_serial_units (
                id, tenant_id, branch_id, product_id, variant_id,
                serial_normalized, status, added_by_adjustment_id,
                updated_at
              )
              VALUES (
                ${randomUUID()}::uuid,
                ${input.tenantId}::uuid,
                ${input.branchId}::uuid,
                ${adjustment.productId}::uuid,
                ${adjustment.variantId}::uuid,
                ${change.serial},
                'IN_STOCK',
                ${adjustmentId}::uuid,
                CURRENT_TIMESTAMP
              )
            `;
          } else {
            const removed = await tx.$queryRaw<{ id: string }[]>`
              UPDATE inventory_serial_units
              SET status = 'REMOVED',
                  removed_by_adjustment_id = ${adjustmentId}::uuid,
                  updated_at = CURRENT_TIMESTAMP
              WHERE tenant_id = ${input.tenantId}::uuid
                AND branch_id = ${input.branchId}::uuid
                AND variant_id = ${adjustment.variantId}::uuid
                AND serial_normalized = ${change.serial}
                AND status = 'IN_STOCK'
              RETURNING id
            `;
            if (removed.length !== 1) {
              throw new ConflictException(
                `Serial number ${change.serial} is not currently in stock at this branch.`,
              );
            }
          }
        }

        const updatedBalance = await tx.$executeRaw`
          UPDATE inventory_balances
          SET physical_quantity = ${physicalAfter},
              version = version + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND variant_id = ${adjustment.variantId}::uuid
        `;

        if (updatedBalance !== 1) {
          throw new ConflictException("The inventory balance could not be updated exactly once.");
        }

        if (availableAfter < 0) {
          await this.audit.record(tx, {
            actorUserId: userId,
            tenantId: input.tenantId,
            action: "inventory.negative_stock.override",
            targetType: "inventory_adjustment",
            targetId: adjustmentId,
            outcome: "SUCCESS",
            metadata: {
              reason: negativeStockReason,
              quantityDelta: adjustment.quantityDelta,
              physicalQuantityAfter: physicalAfter,
              reservedQuantity: balance.reservedQuantity,
              availableQuantityAfter: availableAfter,
            },
          });
        }

        const result = {
          id: adjustmentId,
          status: "APPROVED",
          decidedBy: userId,
          quantityDelta: adjustment.quantityDelta,
          physicalQuantity: physicalAfter,
          reservedQuantity: balance.reservedQuantity,
          availableQuantity: availableAfter,
          inTransitQuantity: balance.inTransitQuantity,
          decisionReason,
          negativeStockOverride: availableAfter < 0,
        };

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "inventory.adjustment.approved",
          targetType: "inventory_adjustment",
          targetId: adjustmentId,
          outcome: "SUCCESS",
        });

        await this.completeOperation(tx, operationId, result);
        return result;
      },
    );
  }

  async rejectAdjustment(
    userId: string,
    adjustmentId: string,
    input: DecideInventoryAdjustmentDto,
  ) {
    const decisionReason = input.decisionReason?.trim() || "";
    if (!decisionReason) {
      throw new BadRequestException("A reason is required to reject an adjustment.");
    }

    return this.run(
      userId,
      input.tenantId,
      "inventory.adjust.approve",
      "OPERATE",
      input.branchId,
      async (tx) => {
        const hash = requestHash({
          tenantId: input.tenantId,
          branchId: input.branchId,
          adjustmentId,
          decisionReason,
        });

        await this.lockIdempotencyKey(tx, input.tenantId, input.idempotencyKey);
        const replay = await this.replayOperation(tx, {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
          hash,
          actorUserId: userId,
          operationType: "ADJUSTMENT_REJECT",
        });
        if (replay) return replay;

        const adjustments = await tx.$queryRaw<
          { id: string; requestedBy: string; status: string }[]
        >`
          SELECT
            id,
            requested_by AS "requestedBy",
            status
          FROM inventory_adjustments
          WHERE tenant_id = ${input.tenantId}::uuid
            AND branch_id = ${input.branchId}::uuid
            AND id = ${adjustmentId}::uuid
          FOR UPDATE
        `;
        const adjustment = adjustments[0];
        if (!adjustment) {
          throw new NotFoundException("The inventory adjustment is unavailable.");
        }
        if (adjustment.status !== "PENDING") {
          throw new ConflictException("This adjustment has already been decided.");
        }
        if (adjustment.requestedBy === userId) {
          throw new ConflictException(
            "The requester cannot reject their own inventory adjustment.",
          );
        }

        const operationId = await this.createOperation(tx, {
          tenantId: input.tenantId,
          actorUserId: userId,
          operationType: "ADJUSTMENT_REJECT",
          idempotencyKey: input.idempotencyKey,
          hash,
          targetId: adjustmentId,
        });

        const updated = await tx.$executeRaw`
          UPDATE inventory_adjustments
          SET status = 'REJECTED',
              decided_by = ${userId}::uuid,
              decision_reason = ${decisionReason},
              decided_at = CURRENT_TIMESTAMP,
              decision_operation_id = ${operationId}::uuid,
              updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${adjustmentId}::uuid
            AND status = 'PENDING'
        `;

        if (updated !== 1) {
          throw new ConflictException(
            "The inventory adjustment could not be decided exactly once.",
          );
        }

        const result = {
          id: adjustmentId,
          status: "REJECTED",
          decidedBy: userId,
          decisionReason,
        };

        await this.audit.record(tx, {
          actorUserId: userId,
          tenantId: input.tenantId,
          action: "inventory.adjustment.rejected",
          targetType: "inventory_adjustment",
          targetId: adjustmentId,
          outcome: "SUCCESS",
        });

        await this.completeOperation(tx, operationId, result);
        return result;
      },
    );
  }

  async listAdjustments(userId: string, tenantId: string, branchId: string) {
    return this.run(userId, tenantId, "inventory.read", "VIEW", branchId, (tx) =>
      this.readAdjustments(tx, tenantId, branchId),
    );
  }

  async getAdjustment(userId: string, tenantId: string, branchId: string, adjustmentId: string) {
    return this.run(userId, tenantId, "inventory.read", "VIEW", branchId, async (tx) => {
      const rows = await this.readAdjustments(tx, tenantId, branchId, adjustmentId);
      if (!rows[0]) {
        throw new NotFoundException("The inventory adjustment is unavailable.");
      }
      return rows[0];
    });
  }

  private readAdjustments(
    tx: InventoryTransaction,
    tenantId: string,
    branchId: string,
    adjustmentId?: string,
  ) {
    return tx.$queryRaw<AdjustmentReadRecord[]>`
      SELECT
        a.id,
        a.tenant_id AS "tenantId",
        a.branch_id AS "branchId",
        a.product_id AS "productId",
        a.variant_id AS "variantId",
        a.requested_by AS "requestedBy",
        a.quantity_delta AS "quantityDelta",
        a.reason,
        a.serial_changes AS "serialChanges",
        a.status,
        a.decided_by AS "decidedBy",
        a.decision_reason AS "decisionReason",
        a.decided_at AS "decidedAt",
        a.created_at AS "createdAt",
        a.updated_at AS "updatedAt",
        b.physical_quantity AS "physicalQuantity",
        b.reserved_quantity AS "reservedQuantity",
        b.in_transit_quantity AS "inTransitQuantity"
      FROM inventory_adjustments AS a
      LEFT JOIN inventory_balances AS b
        ON b.tenant_id = a.tenant_id
        AND b.branch_id = a.branch_id
        AND b.variant_id = a.variant_id
      WHERE a.tenant_id = ${tenantId}::uuid
        AND a.branch_id = ${branchId}::uuid
        AND (${adjustmentId ?? null}::uuid IS NULL OR a.id = ${adjustmentId ?? null}::uuid)
      ORDER BY a.created_at DESC, a.id
    `;
  }
}
