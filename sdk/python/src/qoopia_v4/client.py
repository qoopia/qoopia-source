"""Dependency-free thin client for Qoopia's canonical MCP tools."""

from __future__ import annotations

import json
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TokenProvider = Callable[[], str]
_RETRYABLE_READS = {
    "brief", "recall", "note_relation_list", "extraction_run_get",
    "extraction_run_list", "recall_trace_get",
}


class QoopiaClientError(RuntimeError):
    pass


class QoopiaClient:
    def __init__(self, endpoint: str, token_provider: TokenProvider, max_attempts: int = 2, timeout: float = 10.0):
        if not endpoint.startswith(("http://", "https://")):
            raise ValueError("endpoint must be an absolute HTTP(S) URL")
        self.endpoint = endpoint
        self.token_provider = token_provider
        self.max_attempts = max(1, max_attempts)
        self.timeout = max(0.1, timeout)
        self._request_id = 0

    def call(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        arguments = arguments or {}
        retryable = name in _RETRYABLE_READS or isinstance(arguments.get("idempotency_key"), str)
        attempts = self.max_attempts if retryable else 1
        last_error: Exception | None = None
        for _ in range(attempts):
            self._request_id += 1
            body = json.dumps({
                "jsonrpc": "2.0", "id": self._request_id, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }).encode()
            request = Request(self.endpoint, data=body, method="POST", headers={
                "Authorization": f"Bearer {self.token_provider()}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            })
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    envelope = json.loads(response.read())
                if envelope.get("error"):
                    raise QoopiaClientError(envelope["error"].get("message", "Qoopia JSON-RPC error"))
                result = envelope.get("result", {})
                texts = [item.get("text") for item in result.get("content", []) if item.get("type") == "text"]
                if result.get("isError") or not texts:
                    raise QoopiaClientError(texts[0] if texts else "Qoopia returned no result")
                return json.loads(texts[0])
            except (HTTPError, URLError, OSError, ValueError, QoopiaClientError) as error:
                last_error = error
        message = str(last_error) if last_error else "Qoopia request failed"
        raise QoopiaClientError(message)

    def brief(self, **arguments: Any) -> Any:
        return self.call("brief", arguments)

    def recall(self, **arguments: Any) -> Any:
        return self.call("recall", arguments)

    def note_relation_list(self, **arguments: Any) -> Any:
        return self.call("note_relation_list", arguments)

    def note_supersede(self, **arguments: Any) -> Any:
        return self.call("note_supersede", arguments)

    def extraction_preview(self, **arguments: Any) -> Any:
        return self.call("extraction_preview", arguments)

    def extraction_run_get(self, **arguments: Any) -> Any:
        return self.call("extraction_run_get", arguments)

    def extraction_run_list(self, **arguments: Any) -> Any:
        return self.call("extraction_run_list", arguments)

    def extraction_review(self, **arguments: Any) -> Any:
        return self.call("extraction_review", arguments)

    def recall_trace_get(self, **arguments: Any) -> Any:
        return self.call("recall_trace_get", arguments)

    def recall_feedback(self, **arguments: Any) -> Any:
        return self.call("recall_feedback", arguments)
