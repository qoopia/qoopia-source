# qoopia-sdk (unpublished V4 preview)

The dependency-free client calls only canonical MCP tool names. Endpoint and
token are runtime inputs and are never logged.

```python
import os
from qoopia_v4 import QoopiaClient

client = QoopiaClient(
    os.environ["QOOPIA_MCP_URL"],
    lambda: os.environ["QOOPIA_MCP_TOKEN"],
)
result = client.recall(query="release decision", latest_only=True)
```

Reads and writes carrying `idempotency_key` may retry; other writes run once.
The package is not published by the build workflow.
