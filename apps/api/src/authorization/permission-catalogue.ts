export const PERMISSION_CODES = [
  "catalogue.read",
  "catalogue.manage",
  "inventory.read",
  "inventory.adjust",
  "inventory.adjust.approve",
  "inventory.override_negative",
  "inventory.receive",
  "supplier.read",
  "supplier.manage",
  "purchasing.read",
  "purchasing.manage",
  "purchasing.approve",
  "purchasing.return.dispatch",
  "inventory.transfer.request",
  "inventory.transfer.approve",
  "inventory.transfer.direct",
  "inventory.transfer.dispatch",
  "inventory.transfer.receive",
  "inventory.transfer.discrepancy.resolve",
  "platform.tenant.activate",
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];
export const PERMISSION_CODE_SET: ReadonlySet<string> = new Set(PERMISSION_CODES);
