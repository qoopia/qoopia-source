#!/usr/bin/env python3
"""Durable daily lease and evidence gate for the interactive discovery runbook."""
import argparse
from contextlib import closing
import datetime as dt
import fcntl
import hashlib
import json
import sqlite3
from pathlib import Path
from zoneinfo import ZoneInfo

REQUIRED = {'google-search-console', 'bing-webmaster', 'bing-ai', 'crux',
            'chatgpt-consumer', 'claude-consumer'}
TZ = ZoneInfo('America/Chicago')


def read(path):
    return json.loads(path.read_text()) if path.exists() else {}


def write(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    temp.replace(path)


def begin(root, now):
    path = root / 'daily-state.json'
    state = read(path)
    day = now.astimezone(TZ).date().isoformat()
    if now.astimezone(TZ).hour < 8:
        return {'action': 'NOT_DUE'}
    if state.get('date') == day:
        if state.get('status') in ('COMPLETED', 'COMPLETED_WITH_GAPS'):
            return {'action': 'ALREADY_DONE', 'state': state}
        age = (now - dt.datetime.fromisoformat(state['started_at'])).total_seconds()
        if age < 7200:
            return {'action': 'IN_PROGRESS', 'state': state}
        if state.get('attempt', 1) >= 2:
            return {'action': 'RECOVERY_EXHAUSTED', 'state': state}
    output = root / ('daily-' + day.replace('-', ''))
    output.mkdir(exist_ok=True)
    if state:
        write(output / ('prior-state-' + now.strftime('%H%M%S%f') + '.json'), state)
    measurement_start = (state.get('measurement_started_at', state.get('started_at'))
                         if state.get('date') == day else now.isoformat())
    state = {'date': day, 'status': 'STARTED', 'started_at': now.isoformat(),
             'measurement_started_at': measurement_start,
             'attempt': state.get('attempt', 1) + 1 if state.get('date') == day else 1,
             'evidence': str(output.resolve())}
    write(path, state)
    return {'action': 'RUN', 'state': state}


def finish(root, now, decision, rationale):
    state = read(root / 'daily-state.json')
    if state.get('status') != 'STARTED':
        raise ValueError('No active daily lease')
    start = dt.datetime.fromisoformat(state['started_at'])
    measurement_start = dt.datetime.fromisoformat(state.get('measurement_started_at', state['started_at']))
    if (now - start).total_seconds() > 7200:
        raise ValueError('Lease expired; resume through start before finishing')
    output = Path(state['evidence'])
    technical = read(output / 'technical.json')
    age = (now - dt.datetime.fromisoformat(technical['observed_at'])).total_seconds()
    if not 0 <= age <= 30 * 3600 or not technical.get('results'):
        raise ValueError('Technical evidence is missing or stale')
    db = root / 'visibility/observations.sqlite'
    with closing(sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True)) as conn:
        records = [json.loads(row[0]) for row in conn.execute('SELECT body FROM observations ORDER BY observed_at')]
    fresh = {}
    sessions = {}
    for record in records:
        observed = dt.datetime.fromisoformat(record['observed_at'])
        if measurement_start <= observed <= now and record['source'] in REQUIRED:
            evidence = Path(record['evidence'])
            if not evidence.is_file() or hashlib.sha256(evidence.read_bytes()).hexdigest() != record['evidence_sha256']:
                raise ValueError('Missing or altered evidence: ' + record['source'])
            fresh[record['source']] = record
            if record['source'].endswith('-consumer') and record['status'] == 'OBSERVED':
                key = (record['source'], record.get('prompt_id', 'UNKNOWN'))
                sessions.setdefault(key, set()).add(record.get('session', 'UNKNOWN'))
    missing = REQUIRED - fresh.keys()
    if missing:
        raise ValueError('Fresh observations required: ' + ', '.join(sorted(missing)))
    if not rationale.strip():
        raise ValueError('Editorial decision rationale required')
    gaps = {source: r.get('reason', r['status']) for source, r in fresh.items()
            if r['status'] in ('BLOCKED', 'ERROR', 'PENDING')}
    if any('CONTAMINATED' in r.get('personalization', '') for r in fresh.values()):
        gaps['consumer_isolation'] = 'Connector-visible response recorded separately; not a clean discovery measurement'
    sampling = {source + '/' + prompt: len(sessions.get((source, prompt), set()))
                for source in ('chatgpt-consumer', 'claude-consumer')
                for prompt in ('category-memory', 'branded')}
    if any(count < 3 for count in sampling.values()):
        gaps['consumer_sampling'] = 'Initial panel target is 3 independent responses per engine/prompt; see actual counts'
    if technical.get('status') != 'TECHNICAL_CHECKS_PASS':
        gaps['technical'] = technical.get('findings', 'Technical check failed')
    report = {'date': state['date'], 'completed_at': now.isoformat(),
              'decision': decision, 'rationale': rationale, 'gaps': gaps, 'consumer_samples': sampling,
              'sources': {s: {k: r[k] for k in ('status', 'observed_at', 'evidence')} for s, r in fresh.items()}}
    write(output / 'completion.json', report)
    state.update(status='COMPLETED_WITH_GAPS' if gaps else 'COMPLETED',
                 completed_at=now.isoformat(), decision=decision,
                 report=str(output / 'completion.json'), gaps=gaps)
    write(root / 'daily-state.json', state)
    return state


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['start', 'finish', 'status'])
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--decision', choices=['NO_CHANGE', 'PUBLISHED', 'PIPELINE_FIXED'])
    p.add_argument('--rationale', default='')
    args = p.parse_args()
    args.root.mkdir(parents=True, exist_ok=True)
    with (args.root / 'daily-cycle.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = dt.datetime.now(dt.timezone.utc)
        if args.action == 'start':
            result = begin(args.root, now)
        elif args.action == 'finish':
            if not args.decision:
                p.error('--decision is required for finish')
            result = finish(args.root, now, args.decision, args.rationale)
        else:
            result = read(args.root / 'daily-state.json')
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
