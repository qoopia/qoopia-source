# Recall eval

Golden set and harness for measuring `recall()` quality on a copy of live data, before building
anything on top of recall (entity-page compiler etc.). Nothing here touches production.

- `golden.jsonl` — 107 questions, no note text: `query`, `expected_ids`, `stale_ids`, `alt_ids`, `category`
  (`durable` 47, `current_version` 16, `log_real` 44 incl. 6 with `expected_ids: []`), caller agent.
- `run.ts` — `run` (inside the eval container) and `score` (anywhere).
- `tools/drive.sh` — runs all modes, each on a fresh copy of the snapshot.
- `tools/pool.py` — pooling helper used to label `log_real` (top-k of hybrid + deep per question).
- `tools/miss.py` — miss breakdown (type of top-1 on misses, subject_key coverage, entity pages in top-10).
- `results/<date>.md|json` — reports; JSON keeps metrics and the first 5 ranked ids per case.

`golden.jsonl` and `results/` describe the owner's memory (real queries, note ids, short excerpts), so they are
listed in `scripts/public-source-exclusions.json` and never reach the public source; add every new report there.
The code takes the eval directory and the workspace from `QOOPIA_EVAL_DIR` and `QOOPIA_EVAL_WORKSPACE`.

## How a run is done

1. Snapshot (read-only on the live file): `sqlite3 -readonly /srv/qoopia/data/qoopia.db ".backup <eval>/snap.db"`,
   then `PRAGMA integrity_check`.
2. A disposable container from the production image, never the production one:

   ```sh
   docker run -d --name qoopia-eval --network host --user 1000:1000 --entrypoint sleep \
     -v <eval>:/eval -e QOOPIA_DATA_DIR=/eval/data -e QOOPIA_ROOT=/eval/root -e PORT=3899 \
     -e QOOPIA_RERANK_DEFAULT_DEEP=0 -e QOOPIA_V4_LATEST_ONLY=true -e QOOPIA_V4_LIFECYCLE=true \
     -e QOOPIA_V4_BITEMPORAL=true -e QOOPIA_V4_RELATIONS=true -e QOOPIA_EMBED_PROVIDER=builtin \
     <same rerank / embed endpoints as prod> <prod image id> infinity
   ```

   Copy `run.ts`, `golden.jsonl` to `<eval>/harness/` and `benchmarks/v4/metrics.ts` to `<eval>/v4/`.
3. `QOOPIA_EVAL_DIR=<eval> QOOPIA_EVAL_WORKSPACE=<id> tools/drive.sh [modes…]` — modes: `hybrid`, `deep` (Jina), `deep_llm` (LLM sidecar), `entity_pages`
   (`QOOPIA_ENTITY_PAGES=true`). recall writes `recall_log` and lifecycle stats, so every mode starts from a
   fresh copy of `snap.db`. The container needs `NODE_ENV=development QOOPIA_SERVER_ROLE=canonical`
   (drive.sh passes them).
   A variant is `label:mode[:KEY=VALUE,...]`, e.g. `base:hybrid:QOOPIA_RECALL_CONTEXT_FACTOR=1,QOOPIA_RECALL_CONTEXT_CAP=-1`;
   `QOOPIA_EVAL_SRC` points `run` at another `src/` (e.g. a branch mounted read-only over `/app/src`),
   `QOOPIA_EVAL_EXTRA` adds a second golden file (`negative_extra`: answerless questions for `low_confidence`).
4. Score — `--raw` is repeated before every file:

   ```sh
   bun run.ts score --golden golden.jsonl \
     --raw raw-hybrid.json --raw raw-deep.json --raw raw-deep_llm.json --raw raw-entity_pages.json \
     --out-json score.json --out-md score.md
   ```

5. Cleanup: `docker rm -f qoopia-eval`, delete the eval directory with the snapshot.

## Metrics

hit@1, hit@5, MRR@10 over answerable cases (a hit on `expected_ids` or `alt_ids`); share of empty answers;
share of `current_version` cases where a `stale_ids` note ranks above the current one;
share of `type=context` rows in the top-10 and cases with a context note first; for `low_confidence`: share of
answerless questions flagged, share of answerable ones flagged, correct top-1 answers flagged (lost), and a
threshold grid tuned on synthetic + `negative_extra` with `log_real` kept as the held-out set; p50/p95 latency of the
`recall()` call; response size as JSON characters and ~tokens (chars / 3). `limit` 10, `scope` notes.

## Caveats

- `log_real` labels come from pooling top-k of hybrid and deep plus text search, so they favour the
  pooled modes. Weak labels: `log5332`, `log5367`.
- Entity pages are not counted as hits even when a page covers the fact.
- Without the memory-model profile in `QOOPIA_ROOT`, `deep` applies Jina; in production the main workspace
  has a profile and gets no rerank unless `judge: true` (see the 2026-11-04 report).
