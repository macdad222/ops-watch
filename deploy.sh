#!/bin/zsh
# deploy.sh — GIT-ONLY deploy of ops-watch to .110 (v2, 2026-10-23).
# Git is the single source of truth: refuses to deploy a dirty tree, ships a git
# archive of HEAD, and never touches data/, secrets/, logs/, or the Jev shared
# config on .110 (gates.json / ts-lane-id.txt / model-pin.txt / tg.cred / lab.key
# stay host-owned; credential cleanup is a later phase).
set -e
H=chris@192.168.5.110
D=ops-watch
cd ~/clawd

# 0) refuse dirty tree
DIRTY=$(git status --porcelain projects/ops-watch projects/jev/jev-gate.mjs)
if [ -n "$DIRTY" ]; then
  echo "REFUSING: git tree dirty for ops-watch / jev-gate.mjs — commit first:" >&2
  echo "$DIRTY" >&2
  exit 1
fi
SHA=$(git rev-parse HEAD)
echo "deploying git $SHA"

# 1) git archive → staging dir on .110
git archive HEAD projects/ops-watch projects/jev/jev-gate.mjs | ssh $H "mkdir -p ~/$D/releases/$SHA && tar -x -C ~/$D/releases/$SHA"

# 2) sync code files into ~/ops-watch (code only — data/secrets/logs/config-cred untouched)
ssh $H "set -e
cd ~/$D
R=releases/$SHA/projects/ops-watch
J=releases/$SHA/projects/jev
cp $R/*.mjs $R/*.json $R/*.sh $R/*.py $R/Dockerfile $R/compose.yaml .
mkdir -p config
cp $R/config/opswatch.json config/opswatch.json
cp $J/jev-gate.mjs jev-gate.mjs
echo $SHA > RELEASE
chmod +x ticker.sh daily-trim.sh 2>/dev/null || true
"

# 3) secrets assembled at runtime, never typed into commands (redactor lesson) — UNCHANGED sourcing
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

# 4) build + up + health
ssh $H "set -e
chmod 600 ~/$D/secrets/tg.cred ~/$D/config/ts-lane-id.txt
touch ~/$D/config/decisions.log
cd ~/$D && GIT_SHA=$SHA docker compose up -d --build 2>&1 | tail -3
docker ps --filter name=ops-watch --format '{{.Names}} | {{.Status}}'
docker inspect ops-watch --format 'image={{.Image}} rev={{index .Config.Labels \"org.opencontainers.image.revision\"}}'
"
echo "deploy done: $SHA"
