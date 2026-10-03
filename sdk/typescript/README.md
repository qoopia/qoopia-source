# @qoopia/sdk (unpublished V4 preview)

Experimental and unsupported; see `docs/operations/surfaces-and-versions.md`.
This thin client calls canonical tools through MCP `tools/call` and reads both
JSON and Streamable HTTP (`text/event-stream`) replies. Supply the endpoint and
token at runtime; the package does not persist or log either.

```ts
import { QoopiaClient } from "@qoopia/sdk";

const client = new QoopiaClient({
  endpoint: process.env.QOOPIA_MCP_URL!,
  tokenProvider: () => process.env.QOOPIA_MCP_TOKEN!,
});
const result = await client.recall({ query: "release decision" });
```

`tests/sdk-live.test.ts` in the repository runs this call against the server's
real `/mcp` route.

A default server serves `brief` and `recall`. The other methods need server
flags: `noteRelationList` and `noteSupersede` need `QOOPIA_V4_RELATIONS=true`,
the `extraction*` methods `QOOPIA_V4_EXTRACTION=true`, `recallTraceGet`
`QOOPIA_V4_RECALL_EXPLAIN=true` and `recallFeedback` `QOOPIA_V4_FEEDBACK=true`.
`recall({ latest_only: true })` needs `QOOPIA_V4_RELATIONS` and
`QOOPIA_V4_LATEST_ONLY`; without them it fails with `error.code`
`FEATURE_DISABLED`.

Read operations and writes carrying `idempotency_key` are tried again after a
network error or HTTP 429, 502, 503 or 504. Any other answer (HTTP 401, a
JSON-RPC error, a tool error with its `error.code`) is final, and other writes
are attempted once. This package is private and must not be published without
the separate owner publication gate.
