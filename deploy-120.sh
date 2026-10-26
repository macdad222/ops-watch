#!/bin/zsh
# deploy-120.sh — redeploy ops-watch to .120 (2026-10-26, .110 decommission).
# Same git-only flow as deploy.sh; targets .120; ships held.jsonl snapshot.
set -e
H=chris@192.168.5.120
D=ops-watch
cd ~/clawd

DIRTY=$(git status --porcelain projects/ops-watch projects/jev/jev-gate.mjs)
if [ -n "$DIRTY" ]; then
  echo "REFUSING: git tree dirty for ops-watch / jev-gate.mjs — commit first:" >&2
  echo "$DIRTY" >&2
  exit 1
fi
SHA=$(git rev-parse HEAD)
echo "deploying git $SHA to $H"

# 1) git archive → staging dir on .120
git archive HEAD projects/ops-watch projects/jev/jev-gate.mjs | ssh $H "mkdir -p ~/$D/releases/$SHA && tar -x -C ~/$D/releases/$SHA"

# 2) sync code files into ~/ops-watch (code only — data/secrets/logs untouched)
ssh $H "set -e
cd ~/$D
R=releases/$SHA/projects/ops-watch
J=releases/$SHA/projects/jev
cp \$R/*.mjs \$R/*.json \$R/*.sh \$R/*.py \$R/Dockerfile \$R/compose.yaml .
mkdir -p config data logs secrets
cp \$R/config/opswatch.json config/opswatch.json
cp \$J/jev-gate.mjs jev-gate.mjs
[ -f data/held.jsonl ] || touch data/held.jsonl
[ -f data/jev-decisions.log ] || touch data/jev-decisions.log
[ -f config/decisions.log ] || touch config/decisions.log
echo $SHA > RELEASE
chmod +x ticker.sh daily-trim.sh 2>/dev/null || true
"

# 2b) held.jsonl snapshot from workspace (last synced 2026-10-23)
scp -q ~/clawd/projects/ops-watch/data/held.jsonl $H:~/$D/data/held.jsonl

# 3) secrets assembled at runtime, never typed into commands (redactor lesson)
python3 - <<'PY'
import re
mem = open('/Users/chrismacfarland/clawd/MEMORY.md').read()
tok = re.search(r'(\d{9,11}:[A-Za-z0-9_-]{30,45})', mem).group(1)
open('/tmp/ops-tg.cred','w').write(tok + '\n')
lane = open('/Users/chrismacfarland/clawd/projects/jev/ts-lane-id.txt','rb').read()
open('/tmp/ops-lane.txt','wb').write(lane)
PY
chmod 600 /tmp/ops-tg.cred /tmp/ops-lane.txt
scp -q /tmp/ops-tg.cred $H:~/$D/secrets/tg.cred
scp -q /tmp/ops-lane.txt $H:~/$D/config/ts-lane-id.txt
rm -f /tmp/ops-tg.cred /tmp/ops-lane.txt
scp -q ~/clawd/projects/model-eval/.secrets_lab_key $H:~/$D/secrets/lab.key
scp -q ~/clawd/projects/jev/gates.json $H:~/$D/config/gates.json
scp -q ~/clawd/projects/jev/model-pin.txt $H:~/$D/config/model-pin.txt

# 4) build + up + health
ssh $H "set -e
chmod 600 ~/$D/secrets/tg.cred ~/$D/secrets/lab.key ~/$D/config/ts-lane-id.txt
touch ~/$D/config/decisions.log
cd ~/$D && GIT_SHA=$SHA docker compose up -d --build 2>&1 | tail -3
docker ps --filter name=ops-watch --format '{{.Names}} | {{.Status}} | {{.Ports}}'
docker logs ops-watch --tail 6 2>&1
"
echo "deploy done: $SHA"
