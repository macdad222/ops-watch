#!/bin/sh
# ops-watch ticker: receiver (background) + 5-min triage cycles + log compaction
cd /app
OPSWATCH_OUT=data/events.jsonl OPSWATCH_BIND=0.0.0.0:15140 node receiver.mjs >> logs/receiver.log 2>&1 &
echo "$(date -u +%FT%TZ) ops-watch ticker started (receiver bg, cycle ${CYCLE_SEC:-300}s, loki $LOKI_URL)" >> logs/ticker.log
while true; do
  node loki-tail.mjs data/events.jsonl --state data/loki-state.json --url "$LOKI_URL" >> logs/loki-tail.log 2>&1 \
    || echo "$(date -u +%FT%TZ) loki-tail FAILED" >> logs/ticker.log
  node triage.mjs data/events.jsonl --live --state-file data/triage-state.json --window-min 5 >> logs/triage.log 2>&1 \
    || echo "$(date -u +%FT%TZ) triage FAILED" >> logs/ticker.log
  # compact when >50MB AND fully consumed by triage (offset == size); receiver re-creates file on next append
  SIZE=$(wc -c < data/events.jsonl 2>/dev/null || echo 0)
  OFF=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('data/triage-state.json','utf8')).offset||0)}catch(e){console.log(0)}")
  if [ "${SIZE:-0}" -gt 52428800 ] && [ "${SIZE:-0}" -eq "${OFF:-0}" ]; then
    mv data/events.jsonl "data/processed/events-$(date +%s).jsonl"
    rm -f data/triage-state.json
    echo "$(date -u +%FT%TZ) events compacted" >> logs/ticker.log
  fi
  ls -t data/processed/ 2>/dev/null | tail -n +21 | while read f; do rm -f "data/processed/$f"; done
  sleep "${CYCLE_SEC:-300}"
done
