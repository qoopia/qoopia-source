import { env } from "./env.ts";
import { QoopiaError } from "./errors.ts";
import type { RiskClass } from "../mcp/tools.ts";
import { assertStorageWriteAllowed } from "./storage-degradation.ts";

export function isReadOnlyInstance(): boolean {
  return env.SERVER_ROLE === "legacy-readonly";
}

export function assertInstanceWriteAllowed(
  risk: RiskClass,
  toolName: string,
): void {
  if (risk === "read") return;
  assertStorageWriteAllowed(toolName);
  if (!isReadOnlyInstance()) return;
  throw new QoopiaError(
    "READ_ONLY_INSTANCE",
    `Qoopia instance '${env.INSTANCE_ID}' role='${env.SERVER_ROLE}' rejects write tool '${toolName}'`,
  );
}
