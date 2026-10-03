# qoopia-sdk (unpublished V4 preview)

Experimental and unsupported; see `docs/operations/surfaces-and-versions.md`.
The dependency-free client calls only canonical MCP tool names and reads both
JSON and Streamable HTTP (`text/event-stream`) replies. Endpoint and token are
runtime inputs and are never logged.

```python
import os
from qoopia_v4 import QoopiaClient

client = QoopiaClient(
    os.environ["QOOPIA_MCP_URL"],
    lambda: os.environ["QOOPIA_MCP_TOKEN"],
)
result = client.recall(query="release decision")
```

A default server serves `brief` and `recall`. The other methods need server
flags: `note_relation_list` and `note_supersede` need `QOOPIA_V4_RELATIONS=true`,
the `extraction_*` methods `QOOPIA_V4_EXTRACTION=true`, `recall_trace_get`
`QOOPIA_V4_RECALL_EXPLAIN=true` and `recall_feedback` `QOOPIA_V4_FEEDBACK=true`.
`recall(latest_only=True)` needs `QOOPIA_V4_RELATIONS` and `QOOPIA_V4_LATEST_ONLY`;
without them it raises `QoopiaClientError` with `code` `FEATURE_DISABLED`.

Reads and writes carrying `idempotency_key` are tried again after a network
error or HTTP 429, 502, 503 or 504; any other answer is final, and other writes
run once. Tests: `python3 -m unittest discover -s sdk/python/tests`. The package
is not published by the build workflow.
