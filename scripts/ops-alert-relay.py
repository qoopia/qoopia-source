#!/usr/bin/env python3
"""Loopback receiver for qoopia-alert-channels/1 that delivers operational alerts to the owner's Telegram.

Senders on this host (release-health.py) sign the alert envelope with the channel key. The relay checks
the signature and envelope, sends one Telegram message per event ID, and only after Telegram accepted it
returns the receipt the sender requires ({accepted, event_id, payload_sha256}). A retry of a delivered
event gets the same receipt without a second message.

Bot credentials come from the environment (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: a private 0600
EnvironmentFile); channel keys come from the same policy file the senders read.
"""
import argparse
import base64
import hashlib
import hmac
import http.server
import importlib.util
import json
import os
from pathlib import Path
import urllib.parse
import urllib.request

MAX_BODY = 16384
LEDGER_SIZE = 500


def load_health():
    spec = importlib.util.spec_from_file_location('release_health', Path(__file__).with_name('release-health.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def loopback_keys(policy):
    """Signing keys of the policy channels that point at a receiver on this host."""
    health = load_health()
    return [key for url, key in health.alert_channels(policy) if health.loopback_http(url)]


def render(payload):
    fields = {k: str(payload.get(k) or '')[:1500] for k in ('subject', 'component', 'cause', 'installation', 'at')}
    lines = ['Qoopia ' + fields['subject'] + ': ' + fields['component']]
    if fields['cause']:
        messages = {
            'MEMORY_SIGN_IN_REQUIRED': 'Модель памяти вышла из аккаунта. Откройте Qoopia → Память и войдите в подписку снова. Разговоры сохраняются; сводки продолжатся после входа.',
            'MEMORY_QUOTA': 'Достигнут лимит подписки модели памяти. События сохранены и ждут обработки.',
            'MEMORY_MODEL_UNAVAILABLE': 'Модель памяти недоступна. Проверьте подключение подписки в Qoopia → Память.',
        }
        lines.append(messages.get(fields['cause'], fields['cause'].replace(',', ', ')))
    lines.append(' · '.join(v for v in (fields['installation'], fields['at']) if v))
    return '\n'.join(lines)[:3500]


def send_telegram(text):
    """True only when Telegram confirms the message. The token never reaches argv or a log."""
    token, chat = os.environ.get('TELEGRAM_BOT_TOKEN', ''), os.environ.get('TELEGRAM_CHAT_ID', '')
    if not token or not chat:
        return False
    data = urllib.parse.urlencode({'chat_id': chat, 'text': text, 'disable_web_page_preview': 'true'}).encode()
    try:
        with urllib.request.urlopen('https://api.telegram.org/bot' + token + '/sendMessage', data=data, timeout=10) as r:
            return json.loads(r.read(65536)).get('ok') is True
    except (OSError, ValueError):
        return False


class Ledger:
    """Delivered event IDs with their digests, so a retried event is confirmed without a second message."""

    def __init__(self, path):
        self.path = Path(path)
        try:
            self.entries = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.entries = {}
        if not isinstance(self.entries, dict):
            self.entries = {}

    def add(self, event_id, digest):
        self.entries[event_id] = digest
        self.entries = dict(list(self.entries.items())[-LEDGER_SIZE:])
        temp = self.path.with_suffix('.tmp')
        with open(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump(self.entries, f)
        temp.replace(self.path)


class Relay(http.server.HTTPServer):
    keys = []
    ledger = None
    send = staticmethod(send_telegram)


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, code, body=None):
        raw = json.dumps(body).encode() if body is not None else b''
        self.send_response(code)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        try:
            length = int(self.headers.get('content-length') or 0)
        except ValueError:
            length = -1
        if not 0 < length <= MAX_BODY:
            return self.reply(413)
        body = self.rfile.read(length)
        signature = self.headers.get('x-qoopia-signature', '')
        expected = ['sha256=' + base64.urlsafe_b64encode(hmac.new(key, body, hashlib.sha256).digest()).rstrip(b'=').decode() for key in self.server.keys]
        if not any(hmac.compare_digest(signature, e) for e in expected):
            return self.reply(403)
        try:
            event = json.loads(body)
            event_id = event['id']
            if event['event_type'] != 'operational_alert' or not isinstance(event['payload'], dict) or not isinstance(event_id, str) \
                    or not 0 < len(event_id) <= 128 or self.headers.get('x-qoopia-event-id') != event_id:
                raise ValueError('envelope')
        except (ValueError, KeyError, TypeError):
            return self.reply(400)
        digest = hashlib.sha256(body).hexdigest()
        if self.server.ledger.entries.get(event_id) != digest:
            if not self.server.send(render(event['payload'])):
                return self.reply(502)
            self.server.ledger.add(event_id, digest)
        self.reply(200, {'accepted': True, 'event_id': event_id, 'payload_sha256': digest})

    def log_message(self, fmt, *args):
        # Status lines only; bodies and headers never reach the journal.
        print('relay', self.command, self.path, args[1] if len(args) > 1 else '', flush=True)


def serve(policy, listen, ledger):
    host, _, port = listen.rpartition(':')
    if host.strip('[]') not in ('127.0.0.1', '::1'):
        raise SystemExit('The relay listens on loopback only')
    server = Relay((host.strip('[]'), int(port)), Handler)
    server.keys, server.ledger = loopback_keys(policy), Ledger(ledger)
    if not server.keys:
        raise SystemExit('No loopback channel in the alert policy')
    return server


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--policy', default=os.environ.get('QOOPIA_OPS_CHANNELS_FILE'), required=not os.environ.get('QOOPIA_OPS_CHANNELS_FILE'))
    p.add_argument('--listen', default='127.0.0.1:3791')
    p.add_argument('--ledger', required=True)
    a = p.parse_args()
    os.umask(0o077)
    serve(a.policy, a.listen, a.ledger).serve_forever()


if __name__ == '__main__':
    main()
