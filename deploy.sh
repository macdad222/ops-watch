#!/bin/zsh
# deploy.sh — push ops-watch to .110 and bring the container up. Run from the mini.
set -e
H=chris@192.168.5.110
D=ops-watch
cd ~/clawd/projects/ops-watch

ssh $H "mkdir -p ~/$D/data/processed ~/$D/logs ~/$D/config ~/$D/secrets"
scp -q triage.mjs lib.mjs notify.mjs loki-tail.mjs receiver.mjs ticker.sh rules.json honeytokens.json Dockerfile compose.yaml $H:~/$D/
scp -q ../jev/jev-gate.mjs $H:~/$D/jev-gate.mjs
scp -q ../jev/gates.json ../jev/model-pin.txt $H:~/$D/config/

# secrets assembled at runtime, never typed into commands (redactor lesson)
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

ssh $H "chmod 600 ~/$D/secrets/tg.cred ~/$D/config/ts-lane-id.txt
touch ~/$D/config/decisions.log
cd ~/$D && docker compose up -d --build 2>&1 | tail -3
docker ps --filter name=ops-watch --format '{{.Names}} | {{.Status}}'"
echo "deploy done"
