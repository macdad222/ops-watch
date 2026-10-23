#!/bin/bash
# ops-watch daily trim (2026-10-23, Chris: "trim log files once a day")
# - deletes events.jsonl.* archives older than 3 days
# - rotates triage.log / loki-tail.log (mv aside + fresh file; active fds drain into .prev, deleted next pass)
# - DOES NOT touch jev-decisions.log (Jev ledger — never deleted per gate notes)
# - events.jsonl itself is bounded by ticker compaction (offset==size && >50MB)
# Root crontab: 30 4 * * * /home/chris/ops-watch/daily-trim.sh >> /home/chris/ops-watch/logs/trim.log 2>&1
set -u
D=/home/chris/ops-watch
echo "=== daily-trim $(date -u +%FT%TZ) ==="
find "$D/data" -maxdepth 1 -name 'events.jsonl.*' -mtime +3 -print -delete
for f in triage.log loki-tail.log; do
  [ -f "$D/logs/$f" ] || continue
  if [ -s "$D/logs/$f" ]; then
    mv "$D/logs/$f" "$D/logs/$f.prev"
    : > "$D/logs/$f"
    echo "rotated $f ($(du -h "$D/logs/$f.prev" | cut -f1) -> .prev)"
  fi
done
find "$D/logs" -name '*.prev' -mtime +2 -print -delete
find "$D/data/processed" -maxdepth 1 -name 'events-*.jsonl' -mtime +3 -print -delete 2>/dev/null
echo "sizes after trim:"
du -sh "$D/data" "$D/logs" 2>/dev/null
df -h / | tail -1
