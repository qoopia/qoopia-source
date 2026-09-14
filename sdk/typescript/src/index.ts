export type TokenProvider = () => string | Promise<string>;

export type QoopiaClientOptions = {
  endpoint: string;
  tokenProvider: TokenProvider;
  fetch?: typeof globalThis.fetch;
  maxAttempts?: number;
  timeoutMs?: number;
};

export const CANONICAL_V4_TOOLS = [
  "brief",
  "recall",
  "note_relation_list",
  "note_supersede",
  "extraction_preview",
  "extraction_run_get",
  "extraction_run_list",
  "extraction_review",
  "recall_trace_get",
  "recall_feedback",
] as const;

const RETRYABLE_READS = new Set([
  "brief",
  "recall",
  "note_relation_list",
  "extraction_run_get",
  "extraction_run_list",
  "recall_trace_get",
]);

export class QoopiaClientError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = "QoopiaClientError";
  }
}

export class QoopiaClient {
  private readonly endpoint: string;
  private readonly tokenProvider: TokenProvider;
  private readonly request: typeof globalThis.fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private requestId = 0;

  constructor(options: QoopiaClientOptions) {
    if (!/^https?:\/\//.test(options.endpoint)) throw new Error("endpoint must be an absolute HTTP(S) URL");
    this.endpoint = options.endpoint;
    this.tokenProvider = options.tokenProvider;
    this.request = options.fetch ?? globalThis.fetch;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const retryable = RETRYABLE_READS.has(name) || typeof args.idempotency_key === "string";
    let lastError: unknown;
    for (let attempt = 1; attempt <= (retryable ? this.maxAttempts : 1); attempt++) {
      const token = await this.tokenProvider();
      try {
        const response = await this.request(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++this.requestId,
            method: "tools/call",
            params: { name, arguments: args },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) throw new QoopiaClientError(`Qoopia request failed with HTTP ${response.status}`, response.status);
        const envelope = await response.json() as {
          error?: { code?: number; message?: string };
          result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        };
        if (envelope.error) throw new QoopiaClientError(envelope.error.message ?? "Qoopia JSON-RPC error", envelope.error.code);
        const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
        if (envelope.result?.isError || text === undefined) throw new QoopiaClientError(text ?? "Qoopia returned no result");
        return JSON.parse(text) as T;
      } catch (error) {
        lastError = error;
        if (attempt >= (retryable ? this.maxAttempts : 1)) break;
      }
    }
    if (lastError instanceof QoopiaClientError) throw lastError;
    throw new QoopiaClientError(lastError instanceof Error ? lastError.message : "Qoopia request failed");
  }

  brief<T>(args: Record<string, unknown> = {}) { return this.call<T>("brief", args); }
  recall<T>(args: Record<string, unknown>) { return this.call<T>("recall", args); }
  noteRelationList<T>(args: Record<string, unknown>) { return this.call<T>("note_relation_list", args); }
  noteSupersede<T>(args: Record<string, unknown>) { return this.call<T>("note_supersede", args); }
  extractionPreview<T>(args: Record<string, unknown>) { return this.call<T>("extraction_preview", args); }
  extractionRunGet<T>(args: Record<string, unknown>) { return this.call<T>("extraction_run_get", args); }
  extractionRunList<T>(args: Record<string, unknown> = {}) { return this.call<T>("extraction_run_list", args); }
  extractionReview<T>(args: Record<string, unknown>) { return this.call<T>("extraction_review", args); }
  recallTraceGet<T>(args: Record<string, unknown>) { return this.call<T>("recall_trace_get", args); }
  recallFeedback<T>(args: Record<string, unknown>) { return this.call<T>("recall_feedback", args); }
}
