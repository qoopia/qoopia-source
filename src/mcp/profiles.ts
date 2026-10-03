/**
 * QSA-F / ADR-016: risk classes and per-agent tool profiles. A leaf module so
 * tools.ts and compat.ts can share it without importing each other.
 */
import { z } from "zod";
import { logger } from "../utils/logger.ts";

/** F-255: every MCP metadata argument, bounded as serialized JSON like the 100k text cap bounds text.
 * A fresh schema per field: a shared instance would publish as a JSON-schema $ref. */
const METADATA_MAX_BYTES = 16_384;
export const boundedMetadata = () => z.record(z.unknown()).refine(
  (m) => Buffer.byteLength(JSON.stringify(m)) <= METADATA_MAX_BYTES,
  `metadata exceeds ${METADATA_MAX_BYTES} bytes as JSON`,
);
/** Note tags: at most 50 of at most 100 chars, as extraction_review's edited_tags. */
export const boundedTags = () => z.array(z.string().max(100)).max(50);

// QSA-F / ADR-016: tool-level risk classification.
//   read              — no DB writes, no external side effects
//   write-low         — additive writes recoverable via activity log
//   write-destructive — hard or impossible to recover (note_delete)
//   admin             — identity / permission changes (agent_*)
export type RiskClass =
  | "read"
  | "write-low"
  | "write-destructive"
  | "admin";

// QSA-F / ADR-016: per-agent MCP profile. The DB CHECK constraint in
// migration 010 is the source of truth; runtime treats anything else
// as 'read-only' (fail-closed).
export type AgentToolProfile = "read-only" | "no-destructive" | "full";

const KNOWN_AGENT_PROFILES: ReadonlySet<AgentToolProfile> = new Set([
  "read-only",
  "no-destructive",
  "full",
]);

/**
 * Coerce an arbitrary string from the DB (or undefined / null) into a
 * known AgentToolProfile. Unknown / missing values fail-closed to
 * 'read-only' with a single WARN line per request, matching the
 * documented behavior in ADR-016 "Fail-closed on null / unknown
 * profile". Exported so tests can exercise the fallback.
 */
export function normalizeAgentProfile(
  raw: unknown,
  agentName: string,
): AgentToolProfile {
  if (
    typeof raw === "string" &&
    KNOWN_AGENT_PROFILES.has(raw as AgentToolProfile)
  ) {
    return raw as AgentToolProfile;
  }
  logger.warn(
    `agent=${agentName} tool_profile=${JSON.stringify(raw)} unknown — degraded to read-only (fail-closed)`,
  );
  return "read-only";
}

/**
 * Decide whether a tool of the given risk class is exposed under the
 * agent's profile. Stricter wins: a `read-only` agent only sees `read`
 * tools regardless of the server-level `ToolProfile` argument.
 */
export function isToolAllowedForProfile(
  risk: RiskClass,
  profile: AgentToolProfile,
): boolean {
  switch (profile) {
    case "read-only":
      return risk === "read";
    case "no-destructive":
      return risk === "read" || risk === "write-low";
    case "full":
      return true;
  }
}
