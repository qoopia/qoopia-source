export type TokenProvider = () => string | Promise<string>;

export type QoopiaClientOptions = {
  endpoint: string;
  tokenProvider: TokenProvider;
  fetch?: typeof globalThis.fetch;
  maxAttempts?: number;
  timeoutMs?: number;
};

/** brief and recall are served by default; the others need QOOPIA_V4_* server flags (see README). */
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

/** Only these may succeed on another try; any other answer already reached a decision. */
const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);

export class QoopiaClientError extends Error {
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
    this.name = "QoopiaClientError";
  }
}

type Envelope = {
  id?: unknown;
  error?: { code?: number; message?: string };
  result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
};

/** Streamable HTTP answers with SSE when the client accepts it: take this request's JSON-RPC reply. */
async function readEnvelope(response: Response, id: number): Promise<Envelope> {
  const body = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return JSON.parse(body) as Envelope;
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    const message = JSON.parse(data) as Envelope;
    if (message.id === id && (message.result !== undefined || message.error !== undefined)) return message;
  }
  throw new QoopiaClientError("Qoopia stream ended without a reply");
}

const pause = (attempt: number) => new Promise((resolve) => setTimeout(resolve, 100 * attempt));

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
    const attempts = RETRYABLE_READS.has(name) || typeof args.idempotency_key === "string" ? this.maxAttempts : 1;
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokenProvider();
      const id = ++this.requestId;
      let response: Response;
      try {
        response = await this.request(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name, arguments: args },
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt < attempts) { await pause(attempt); continue; }
        throw new QoopiaClientError(error instanceof Error ? error.message : "Qoopia request failed");
      }
      if (!response.ok) {
        if (TRANSIENT_STATUS.has(response.status) && attempt < attempts) { await pause(attempt); continue; }
        throw new QoopiaClientError(`Qoopia request failed with HTTP ${response.status}`, response.status);
      }
      let envelope: Envelope;
      try {
        envelope = await readEnvelope(response, id);
      } catch (error) {
        throw error instanceof QoopiaClientError ? error : new QoopiaClientError(error instanceof Error ? error.message : "Unreadable Qoopia reply");
      }
      if (envelope.error) throw new QoopiaClientError(envelope.error.message ?? "Qoopia JSON-RPC error", envelope.error.code);
      const text = envelope.result?.content?.find((item) => item.type === "text")?.text;
      if (envelope.result?.isError || text === undefined) {
        const message = text ?? "Qoopia returned no result";
        // Tool errors read "CODE: message".
        throw new QoopiaClientError(message, /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1]);
      }
      return JSON.parse(text) as T;
    }
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
