import io
import json
import os
import sys
import unittest
from unittest.mock import patch

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

    @patch("qoopia_v4.client.urlopen", side_effect=OSError("temporary"))
    def test_token_is_not_in_error(self, _opener):
        client = QoopiaClient("https://qoopia.example/mcp", lambda: "never-log-me", max_attempts=1)
        with self.assertRaises(QoopiaClientError) as raised:
            client.recall(query="x")
        self.assertNotIn("never-log-me", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
