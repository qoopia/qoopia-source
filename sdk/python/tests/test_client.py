import io
import json
import os
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from qoopia_v4 import QoopiaClient, QoopiaClientError


class Response:
    def __init__(self, value):
        self.value = value

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps({"result": {"content": [{"type": "text", "text": json.dumps(self.value)}]}}).encode()


class EventStream(Response):
    """What the live server sends for an `accept: application/json, text/event-stream` request."""
    headers = {"Content-Type": "text/event-stream"}

    def read(self):
        return self.value.encode()


class ToolError(Response):
    def read(self):
        return json.dumps({"result": {"isError": True, "content": [{"type": "text", "text": self.value}]}}).encode()


class ClientTest(unittest.TestCase):
    @patch("qoopia_v4.client.urlopen")
    def test_canonical_call_and_runtime_token(self, opener):
        opener.return_value = Response({"items": []})
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "runtime-secret")
        self.assertEqual(client.recall(query="alpha"), {"items": []})
        request = opener.call_args.args[0]
        self.assertEqual(opener.call_args.kwargs["timeout"], 10.0)
        self.assertEqual(request.get_header("Authorization"), "Bearer runtime-secret")
        payload = json.loads(request.data)
        self.assertEqual(payload["method"], "tools/call")
        self.assertEqual(payload["params"]["name"], "recall")

    @patch("qoopia_v4.client.urlopen", side_effect=OSError("temporary"))
    def test_unsafe_write_is_not_retried(self, opener):
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "token")
        with self.assertRaises(QoopiaClientError):
            client.note_supersede(source_note_id="a")
        self.assertEqual(opener.call_count, 1)

    @patch("qoopia_v4.client.urlopen")
    def test_event_stream_reply_and_only_transient_retries(self, opener):
        def sse(request, timeout):
            request_id = json.loads(request.data)["id"]
            reply = {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps({"items": []})}]}}
            return EventStream("event: message\ndata: " + json.dumps(reply) + "\n\n")
        busy = HTTPError("https://qoopia.example/mcp", 503, "busy", {}, io.BytesIO(b""))
        denied = HTTPError("https://qoopia.example/mcp", 401, "denied", {}, io.BytesIO(b""))
        calls = iter([busy, "sse", denied])

        def respond(request, timeout):
            step = next(calls)
            if step == "sse":
                return sse(request, timeout)
            raise step
        opener.side_effect = respond
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "token")
        self.assertEqual(client.recall(query="sse"), {"items": []})
        self.assertEqual(opener.call_count, 2)
        with self.assertRaises(QoopiaClientError) as raised:
            client.brief()
        self.assertEqual(raised.exception.code, 401)
        self.assertEqual(opener.call_count, 3)

    @patch("qoopia_v4.client.urlopen")
    def test_tool_error_code_is_exposed_and_not_retried(self, opener):
        opener.return_value = ToolError("FEATURE_DISABLED: QOOPIA_V4_RELATIONS/QOOPIA_V4_LATEST_ONLY")
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "token")
        with self.assertRaises(QoopiaClientError) as raised:
            client.recall(query="x", latest_only=True)
        self.assertEqual(raised.exception.code, "FEATURE_DISABLED")
        self.assertEqual(opener.call_count, 1)

    @patch("qoopia_v4.client.urlopen", side_effect=OSError("temporary"))
    def test_token_is_not_in_error(self, _opener):
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "never-log-me", max_attempts=1)
        with self.assertRaises(QoopiaClientError) as raised:
            client.recall(query="x")
        self.assertNotIn("never-log-me", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
