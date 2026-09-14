# @qoopia/sdk (unpublished V4 preview)

This thin client calls canonical tools through MCP `tools/call`. Supply the
endpoint and token at runtime; the package does not persist or log either.

```ts
import { QoopiaClient } from "@qoopia/sdk";

const client = new QoopiaClient({
  endpoint: process.env.QOOPIA_MCP_URL!,
  tokenProvider: () => process.env.QOOPIA_MCP_TOKEN!,
});
const result = await client.recall({ query: "release decision", latest_only: true });
```

Read operations and writes carrying `idempotency_key` may retry. Other writes
are attempted once. This package is private and must not be published without
the separate owner publication gate.
