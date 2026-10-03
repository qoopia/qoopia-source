"""Dependency-free thin client for Qoopia's canonical MCP tools."""

from __future__ import annotations

import json
import re
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

TokenProvider = Callable[[], str]
_RETRYABLE_READS = {
    "brief", "recall", "note_relation_list", "extraction_run_get",
    "extraction_run_list", "recall_trace_get",
}
# Only these may succeed on another try; any other answer already reached a decision.
_TRANSIENT_STATUS = {429, 502, 503, 504}


class QoopiaClientError(RuntimeError):
    def __init__(self, message: str, code: int | str | None = None):
        super().__init__(message)
        self.code = code


def _envelope(raw: bytes, content_type: str, request_id: int) -> dict[str, Any]:
    """Streamable HTTP answers with SSE when the client accepts it: take this request's reply."""
    if "text/event-stream" not in content_type:
        return json.loads(raw)
    for event in re.split(r"\r?\n\r?\n", raw.decode()):
        data = "\n".join(line[5:].removeprefix(" ") for line in event.splitlines() if line.startswith("data:"))
        if not data:
            continue
        message = json.loads(data)
        if message.get("id") == request_id and ("result" in message or "error" in message):
            return message
    raise QoopiaClientError("Qoopia stream ended without a reply")


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
        for attempt in range(1, attempts + 1):
            self._request_id += 1
            request_id = self._request_id
            body = json.dumps({
                "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            }).encode()
            request = Request(self.endpoint, data=body, method="POST", headers={
                "Authorization": f"Bearer {self.token_provider()}",
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            })
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    headers = getattr(response, "headers", None)
                    content_type = headers.get("Content-Type", "") if headers else ""
                    raw = response.read()
            except HTTPError as error:
                if error.code in _TRANSIENT_STATUS and attempt < attempts:
                    time.sleep(0.1 * attempt)
                    continue
                raise QoopiaClientError(f"Qoopia request failed with HTTP {error.code}", error.code) from None
            except (URLError, OSError) as error:
                if attempt < attempts:
                    time.sleep(0.1 * attempt)
                    continue
                raise QoopiaClientError(str(error) or "Qoopia request failed") from None
            try:
                envelope = _envelope(raw, content_type, request_id)
            except ValueError as error:
                raise QoopiaClientError(str(error)) from None
            if envelope.get("error"):
                raise QoopiaClientError(envelope["error"].get("message", "Qoopia JSON-RPC error"), envelope["error"].get("code"))
            result = envelope.get("result", {})
            texts = [item.get("text") for item in result.get("content", []) if item.get("type") == "text"]
            if result.get("isError") or not texts:
                message = texts[0] if texts else "Qoopia returned no result"
                # Tool errors read "CODE: message".
                code = re.match(r"([A-Z][A-Z0-9_]+):", message)
                raise QoopiaClientError(message, code.group(1) if code else None)
            return json.loads(texts[0])
        raise QoopiaClientError("Qoopia request failed")

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
