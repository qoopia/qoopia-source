#!/bin/sh
# Runs each variant on a fresh copy of the snapshot (recall writes recall_log and lifecycle stats).
#   drive.sh [VARIANT ...]   VARIANT = label:mode[:KEY=VALUE,KEY=VALUE...]
#   e.g. drive.sh base:hybrid:QOOPIA_RECALL_CONTEXT_FACTOR=1,QOOPIA_RECALL_CONTEXT_CAP=-1 ctx:hybrid
# A bare mode (hybrid, deep, deep_llm, entity_pages) is label=mode with no extra env.
# QOOPIA_EVAL_SRC (path inside the container) selects the recall code; default /app/src of the image.
# QOOPIA_EVAL_EXTRA (path inside the container) adds a second golden file.
set -u
E="${QOOPIA_EVAL_DIR:?set QOOPIA_EVAL_DIR to the eval directory}"
: "${QOOPIA_EVAL_WORKSPACE:?set QOOPIA_EVAL_WORKSPACE}"
SRC="${QOOPIA_EVAL_SRC:-/app/src}"
VARIANTS="${*:-hybrid deep deep_llm entity_pages}"
for v in $VARIANTS; do
  label=${v%%:*}; rest=${v#"$label"}; rest=${rest#:}
  m=${rest%%:*}; [ -z "$m" ] && m=$label
  kv=""; case "$rest" in *:*) kv=${rest#*:} ;; esac
  cp "$E/snap.db" "$E/data/qoopia.db" && rm -f "$E/data/qoopia.db-wal" "$E/data/qoopia.db-shm"
  EP=false; [ "$m" = entity_pages ] && EP=true
  set -- -e NODE_ENV=development -e QOOPIA_SERVER_ROLE=canonical -e "QOOPIA_ENTITY_PAGES=$EP" \
    -e "QOOPIA_EVAL_WORKSPACE=$QOOPIA_EVAL_WORKSPACE"
  old_ifs=$IFS; IFS=,
  for pair in $kv; do set -- "$@" -e "$pair"; done
  IFS=$old_ifs
  extra=""; [ -n "${QOOPIA_EVAL_EXTRA:-}" ] && extra="--golden-extra $QOOPIA_EVAL_EXTRA"
  echo "start $label ($m) $(date -u +%FT%TZ)" >> "$E/logs/driver.log"
  # shellcheck disable=SC2086
  docker exec -w /app "$@" qoopia-eval \
    bun /eval/harness/run.ts run --mode "$m" --label "$label" --src "$SRC" --golden /eval/harness/golden.jsonl $extra \
    --out "/eval/harness/raw-$label.json" > "$E/logs/$label.log" 2>&1 || echo "FAIL $label" >> "$E/logs/driver.log"
  echo "done $label $(date -u +%FT%TZ)" >> "$E/logs/driver.log"
done
echo ALLDONE >> "$E/logs/driver.log"
