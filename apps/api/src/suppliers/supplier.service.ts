import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthorizationService } from "../authorization/authorization.service.js";
import type { CreateSupplierDto, UpdateSupplierDto } from "./dto/supplier.dto.js";

type SupplierTransaction = Prisma.TransactionClient;

type SupplierRow = {
  id: string;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  status: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
};

type SupplierMutableRow = {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
};

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  return value.trim() || null;
}

function dbConflict(error: unknown): never {
  const constraint = "suppliers_tenant_id_name_normalized_key";

  if (typeof error !== "object" || error === null || !("code" in error)) {
    throw error;
  }

  const databaseError = error as {
    code?: string;
    message?: string;
    meta?: {
      target?: unknown;
      constraint?: unknown;
      code?: unknown;
      message?: unknown;
      driverAdapterError?: {
        cause?: {
          constraint?: {
            index?: unknown;
          };
        };
      };
    };
  };
  const meta = databaseError.meta;
  const target = meta?.target;
  const targetColumns = Array.isArray(target) ? target.map(String) : [];
  const targetName = typeof target === "string" ? target : "";
  const constraintName = meta?.constraint === constraint || targetName.includes(constraint);

  const matchingColumns =
    (targetColumns.includes("tenant_id") && targetColumns.includes("name_normalized")) ||
    (targetColumns.includes("tenantId") && targetColumns.includes("nameNormalized"));

  const adapterConstraint = meta?.driverAdapterError?.cause?.constraint?.index;

  const isSupplierNameConflict =
    (databaseError.code === "P2002" && (constraintName || matchingColumns)) ||
    (databaseError.code === "P2010" &&
      (adapterConstraint === constraint ||
        (String(meta?.code ?? "") === "23505" &&
          [meta?.message, databaseError.message].some(
            (message) => typeof message === "string" && message.includes(constraint),
          ))));

  if (isSupplierNameConflict) {
    throw new ConflictException("A supplier with this name already exists.");
  }

  throw error;
}

@Injectable()
export class SupplierService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async run<T>(
    userId: string,
    tenantId: string,
    permission: "supplier.read" | "supplier.manage",
    operation: "VIEW" | "OPERATE",
    callback: (tx: SupplierTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.authorization.withPermission({
        userId,
        tenantId,
        permission,
        operation,
        callback,
      });
    } catch (error) {
      dbConflict(error);
    }
  }

  async list(userId: string, tenantId: string) {
    return this.run(
      userId,
      tenantId,
      "supplier.read",
      "VIEW",
      async (tx) =>
        tx.$queryRaw<SupplierRow[]>`
          SELECT
            id,
            name,
            contact_name AS "contactName",
            email,
            phone,
            address,
            notes,
            status,
            version::text AS version,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM suppliers
          WHERE tenant_id = ${tenantId}::uuid
          ORDER BY name, id
        `,
    );
  }

  async create(userId: string, input: CreateSupplierDto) {
    const id = randomUUID();
    const name = input.name.trim();

    return this.run(userId, input.tenantId, "supplier.manage", "OPERATE", async (tx) => {
      await tx.$executeRaw`
          INSERT INTO suppliers (
            id,
            tenant_id,
            name,
            name_normalized,
            contact_name,
            email,
            phone,
            address,
            notes,
            status,
            updated_at
          )
          VALUES (
            ${id}::uuid,
            ${input.tenantId}::uuid,
            ${name},
            upper(btrim(normalize(${name}, NFKC))),
            ${optionalText(input.contactName)},
            ${optionalText(input.email)?.toLowerCase() ?? null},
            ${optionalText(input.phone)},
            ${optionalText(input.address)},
            ${optionalText(input.notes)},
            'ACTIVE',
            CURRENT_TIMESTAMP
          )
        `;

      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "supplier.created",
        targetType: "supplier",
        targetId: id,
        outcome: "SUCCESS",
      });

      return {
        id,
        name,
        contactName: optionalText(input.contactName),
        email: optionalText(input.email)?.toLowerCase() ?? null,
        phone: optionalText(input.phone),
        address: optionalText(input.address),
        notes: optionalText(input.notes),
        status: "ACTIVE",
        version: "1",
      };
    });
  }

  async update(userId: string, supplierId: string, input: UpdateSupplierDto) {
    return this.run(userId, input.tenantId, "supplier.manage", "OPERATE", async (tx) => {
      const current = await tx.$queryRaw<SupplierRow[]>`
          SELECT
            id,
            name,
            contact_name AS "contactName",
            email,
            phone,
            address,
            notes,
            status,
            version::text AS version,
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM suppliers
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${supplierId}::uuid
          FOR UPDATE
        `;

      if (!current[0] || current[0].status !== "ACTIVE") {
        throw new NotFoundException("The supplier is unavailable.");
      }

      if (BigInt(current[0].version) !== BigInt(input.version)) {
        throw new ConflictException(
          "The supplier was changed by another request. Reload it before updating.",
        );
      }

      const previous = current[0];
      const next: SupplierMutableRow = {
        name: input.name === undefined ? previous.name : input.name.trim(),
        contactName:
          input.contactName === undefined ? previous.contactName : optionalText(input.contactName),
        email:
          input.email === undefined
            ? previous.email
            : (optionalText(input.email)?.toLowerCase() ?? null),
        phone: input.phone === undefined ? previous.phone : optionalText(input.phone),
        address: input.address === undefined ? previous.address : optionalText(input.address),
        notes: input.notes === undefined ? previous.notes : optionalText(input.notes),
      };

      const updated = await tx.$queryRaw<{ id: string; version: string }[]>`
          UPDATE suppliers
          SET
            name = ${next.name},
            name_normalized = upper(btrim(normalize(${next.name}, NFKC))),
            contact_name = ${next.contactName},
            email = ${next.email},
            phone = ${next.phone},
            address = ${next.address},
            notes = ${next.notes},
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${supplierId}::uuid
            AND status = 'ACTIVE'
            AND version = ${BigInt(input.version)}
          RETURNING id, version::text AS version
        `;

      if (!updated[0]) {
        throw new ConflictException(
          "The supplier changed during this update. Reload it and try again.",
        );
      }

      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "supplier.updated",
        targetType: "supplier",
        targetId: supplierId,
        outcome: "SUCCESS",
        metadata: {
          previousVersion: previous.version,
          version: updated[0].version,
        },
      });

      return {
        id: supplierId,
        ...next,
        status: "ACTIVE",
        version: updated[0].version,
      };
    });
  }

  async archive(userId: string, supplierId: string, tenantId: string, version: number) {
    return this.run(userId, tenantId, "supplier.manage", "OPERATE", async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; version: string }[]>`
          UPDATE suppliers
          SET
            status = 'ARCHIVED',
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${tenantId}::uuid
            AND id = ${supplierId}::uuid
            AND status = 'ACTIVE'
            AND version = ${BigInt(version)}
          RETURNING id, version::text AS version
        `;

      if (!rows[0]) {
        const existing = await tx.$queryRaw<{ status: string; version: string }[]>`
            SELECT status, version::text AS version
            FROM suppliers
            WHERE tenant_id = ${tenantId}::uuid
              AND id = ${supplierId}::uuid
          `;

        if (!existing[0] || existing[0].status !== "ACTIVE") {
          throw new NotFoundException("The supplier is unavailable.");
        }

        throw new ConflictException(
          "The supplier was changed by another request. Reload it before archiving.",
        );
      }

      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId,
        action: "supplier.archived",
        targetType: "supplier",
        targetId: supplierId,
        outcome: "SUCCESS",
        metadata: {
          version: rows[0].version,
        },
      });

      return {
        id: supplierId,
        status: "ARCHIVED",
        version: rows[0].version,
      };
    });
  }
}
