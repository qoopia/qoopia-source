export type QoopiaErrorCode =
  | "MODEL_NOT_CONNECTED" | "MODEL_BUSY" | "MODEL_UNAVAILABLE" | "MODEL_TIMEOUT" | "MODEL_QUOTA" | "MODEL_INVALID_RESPONSE"
  | "UNAUTHENTICATED"
  | "DEVICE_REVOKED" | "DEVICE_LIMIT_REACHED" | "SIGN_IN_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "STALE_REVISION"
  | "IDEMPOTENCY_MISMATCH"
  | "EXPIRED"
  | "VERIFICATION_ALREADY_COMPLETED"
  | "REVOKED"
  | "UNSUPPORTED"
  | "QUARANTINED"
  | "LICENSE_REQUIRED"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "READ_ONLY_INSTANCE"
  | "CONFLICT"
  | "SIZE_LIMIT"
  | "STORAGE_FULL"
  | "UNAUTHORIZED"
  | "UNSUPPORTED_SCHEMA"
  | "UNTRUSTED_SIGNING_KEY"
  | "CHECKSUM_MISMATCH"
  | "NOT_READY"
  | "MANUAL_DRIFT"
  /** Local agent instructions were not written (src/agent-kit/install.ts); details.file names the path. */
  | "INSTRUCTIONS_LINKED_PATH" | "INSTRUCTIONS_UNSAFE_MODE" | "INSTRUCTIONS_TOO_LARGE" | "INSTRUCTIONS_EDITED" | "INSTRUCTIONS_LOCKED" | "INSTRUCTIONS_NEWER"
  | "INTERNAL"
  /**
   * Raised by src/services/embeddings.ts when the local Ollama call
   * fails (network, timeout, model not loaded, wrong dim). Callers
   * upstream (notes.fireAndForgetEmbed, recall.vectorNoteCandidates)
   * catch and degrade — the note still saves, recall returns FTS5
   * results only and marks mode='fts5-fallback'.
   */
  | "EMBEDDING_FAILED";

export class QoopiaError extends Error {
  constructor(public code: QoopiaErrorCode, message: string, public details?: Record<string, unknown>) {
    super(message);
    this.name = "QoopiaError";
  }

  toString() {
    return `${this.code}: ${this.message}`;
  }
}

/** Throw a `base` QoopiaError whose public code is the narrower `code` (FEATURE_DISABLED, STALE_VERSION, …). */
export function throwCoded(base: QoopiaErrorCode, code: string, message: string): never {
  const error = new QoopiaError(base, message);
  (error as { code: string }).code = code;
  throw error;
}

/** A V4 feature flag named `name` is off. */
export function featureDisabled(name: string): never {
  return throwCoded("INVALID_INPUT", "FEATURE_DISABLED", name);
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
