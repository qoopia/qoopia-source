#!/usr/bin/env python3
"""Read-only official visibility APIs. Credentials are explicit local files."""
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
from urllib.parse import quote


def read_key(name):
    filename = os.environ.get(name)
    if not filename:
        raise FileNotFoundError(name)
    return Path(filename).read_text().strip()


def fetch(url, body=None, headers=None, params=None):
    import requests
    with requests.request('POST' if body is not None else 'GET', url, json=body,
                          headers=headers, params=params, timeout=(10, 30),
                          allow_redirects=False, stream=True) as response:
        if response.status_code != 200:
            # Do not expose URLs containing Bing keys or provider error bodies.
            raise ValueError('HTTP_' + str(response.status_code))
        raw = bytearray()
        for chunk in response.iter_content(65536):
            raw.extend(chunk)
            if len(raw) > 4_000_000:
                raise ValueError('RESPONSE_TOO_LARGE')
        return json.loads(raw)


def gsc():
    filename = os.environ.get('QOOPIA_GSC_CREDENTIALS')
    if not filename:
        raise FileNotFoundError('QOOPIA_GSC_CREDENTIALS')
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    credentials = Credentials.from_authorized_user_file(filename, scopes=['https://www.googleapis.com/auth/webmasters.readonly'])
    if not credentials.valid:
        credentials.refresh(Request())
    end = dt.date.today() - dt.timedelta(days=3)
    start = end - dt.timedelta(days=27)
    result = {'period': {'start': str(start), 'end': str(end), 'timezone': 'America/Los_Angeles'}, 'datasets': {}}
    url = 'https://www.googleapis.com/webmasters/v3/sites/' + quote('sc-domain:qoopia.ai', safe='') + '/searchAnalytics/query'
    for dimension in ('date', 'query', 'page', 'country', 'device'):
        rows = fetch(url, {'startDate': str(start), 'endDate': str(end), 'dimensions': [dimension],
                          'type': 'web', 'dataState': 'final', 'rowLimit': 25000},
                     {'Authorization': 'Bearer ' + credentials.token})
        result['datasets'][dimension] = rows
    result['coverage'] = 'Top rows only; provider privacy limits apply; never sum across dimensions. 25000-row cap per dimension.'
    return result


def bing():
    key = read_key('QOOPIA_BING_API_KEY_FILE')
    result = {}
    for method in ('GetRankAndTrafficStats', 'GetQueryStats'):
        result[method] = fetch('https://ssl.bing.com/webmaster/api.svc/json/' + method,
                               params={'siteUrl': 'https://qoopia.ai/', 'apikey': key})
    result['coverage'] = 'Bing aggregate traffic includes multiple verticals; not a standalone Copilot/AI citation count.'
    return result


def crux():
    key = read_key('QOOPIA_CRUX_API_KEY_FILE')
    return fetch('https://chromeuxreport.googleapis.com/v1/records:queryRecord',
                 {'origin': 'https://qoopia.ai'}, {'X-Goog-Api-Key': key})


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    with (output / '.providers.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return []
        now = dt.datetime.now(dt.timezone.utc)
        folder = output / 'evidence' / now.strftime('%Y%m%dT%H%M%S.%fZ')
        folder.mkdir(parents=True)
        records = []
        for source, operation in [('google-search-console', gsc), ('bing-webmaster', bing), ('crux', crux)]:
            try:
                data = operation()
                record = {'status': 'OBSERVED', 'metrics': data}
            except FileNotFoundError:
                record = {'status': 'BLOCKED', 'reason': 'Explicit provider credential file not configured or absent'}
            except Exception as error:
                # Error class only: SDK messages may include credentials or account identifiers.
                record = {'status': 'ERROR', 'reason': type(error).__name__}
                if isinstance(error, ValueError) and str(error).startswith('HTTP_'):
                    record['reason'] = str(error)
                    if source == 'crux' and str(error) == 'HTTP_404':
                        record.update(status='NO_DATA', reason='CrUX has no record for this origin')
            evidence = folder / (source + '.json')
            evidence.write_text(json.dumps(record, indent=2) + '\n')
            records.append(dict(record, source=source, observed_at=now.isoformat(), evidence=str(evidence.resolve())))
        tmp = output / 'providers.tmp'
        tmp.write_text(json.dumps(records, indent=2) + '\n')
        tmp.replace(output / 'providers.json')
        return records


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps([{k: r[k] for k in ('source', 'status')} for r in run(args.output)]))
