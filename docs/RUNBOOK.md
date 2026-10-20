# RUNBOOK

## Deploy / update (.110)

```bash
cd ~/clawd/projects/ops-watch
./deploy.sh        # scp code + config + secrets (assembled at runtime), rebuild, up
```

Force-recreate after compose changes (don't trust `up` alone to apply env/port changes):

```bash
ssh chris@192.168.5.110 'cd ~/ops-watch && docker compose down && docker compose up -d --build'
```

**Rollback:** the mini's repo is source of truth — `git revert` + `./deploy.sh`. Container rollback: `ssh chris@192.168.5.110 'cd ~/ops-watch && docker compose down && git -C ~ 2>/dev/null; docker run --rm -it ghcr.io/berriai/litellm... '` — no image history kept; redeploy from a previous commit instead.

## Health checks (60 seconds)

```bash
ssh chris@192.168.5.110 '
  docker ps --filter name=ops-watch --format "{{.Status}}"                    # Up?
  docker exec ops-watch sh -c "tail -1 logs/receiver.log"                     # "listening udp://0.0.0.0:15140 → data/events.jsonl"
  tail -2 ~/ops-watch/logs/ticker.log                                         # no FAILED lines?
  tail -1 ~/ops-watch/logs/loki-tail.log                                      # appended>0 or "no new range"
  tail -1 ~/ops-watch/logs/triage.log | python3 -m json.tool | head -8        # counts sane?
'
```

Live-fire test (safe — hum events, held not pinged):

```bash
ssh chris@192.168.5.110 'python3 -c "
import socket
s=socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(b\"<30>Oct 20 23:59:00 smoketestHost prog[1]: routine smoke keepalive\", (\"127.0.0.1\",15140))
" && sleep 2 && grep -c smoketestHost ~/ops-watch/data/events.jsonl'
```

Full-cycle test without Telegram: `docker exec ops-watch node triage.mjs data/events.jsonl --digest-only --state-file /tmp/t.json --window-min 5`

## Gotchas hit during the real deploy (do not re-learn these)

1. **Compose env/port changes need `down` then `up`** — `up -d --build` alone kept the old spec (env missing, random host port 32769).
2. **Bind-mount file targets must pre-exist on the host** — `touch data/jev-decisions.log` before `up`, else Docker creates a *directory* and the mount fails ("mount a directory onto a file").
3. **Container layout vs repo layout** — triage imports `../jev/jev-gate.mjs` (repo: `projects/jev/` sibling) but the image flattens to `/app`, where `../jev` = `/jev`. Solved with import fallback: try `../jev/` then `./jev/`. Keep `jev-gate.mjs` copied to image at `./jev/`.
4. **Receiver bind inside container must be `0.0.0.0`** — `127.0.0.1` binds container-loopback; the docker port map forwards to container eth0 and packets vanish silently (smoke test "sent 3, received 0").
5. **File mounts need placeholder files IN THE IMAGE** (`touch jev/gates.json ...` in Dockerfile) so host files mount as files, not dirs.
6. **`/dev/udp` echo doesn't work over non-interactive ssh on some shells** — use the python UDP snippet above.
7. **`docker compose down -q`** — `-q` not supported on the installed compose version; plain `down` is fine.
8. **ufw on .110 is inactive** — no firewall rule needed for :15140; if ufw gets enabled later: `ufw allow from 192.168.5.0/24 to any port 15140 proto udp`.

## Common operations

**Change a threshold** → edit `~/ops-watch/config/gates.json` on .110 (mounted ro; recreate container after) **and** mirror to `~/clawd/projects/jev/gates.json` on the mini. Never hardcode thresholds in scripts.

**Add an app rule** → edit `rules.json` (in repo + scp to .110, rebuild). Schema in [docs/RULES.md](docs/RULES.md). Run `node selftest.mjs` in `projects/jev/` after any gate-touching change.

**Silence a noisy legit pattern** → add it to the hum check in `lib.mjs` (deterministic) or let Jev learn it (it holds benign ≥0.60). Prefer rules.json patterns for app-specific cases.

**See what was held and why** → `ssh chris@192.168.5.110 'tail -20 ~/ops-watch/data/held.jsonl'` or query the Jev ledger: `grep security-triage ~/ops-watch/data/jev-decisions.log | tail`.

**Kill switch:** `JEV_DISABLE=1` env on the container → Jev never consulted, nothing suppressed, P0/P1 deterministic still pings. Container-level: `docker stop ops-watch` → FortiGate logs buffer nowhere (UDP is fire-and-forget); restart ASAP.

**Loki down:** loki-tail logs the failure, ticker continues; receiver events still flow. Old range is picked up when Loki returns (state cursor only advances on success — actually verify: cursor advances only for fetched lines; a full failure leaves lastNs untouched → backlog refetches automatically).

## What still needs Chris

1. **FortiGate → Remote Syslog → 192.168.5.110:15140** (UDP). Until then, firewall events only reach ops-watch if they appear in Linux syslog (they don't).
2. Honeytoken plants + matching `honeytokens.json` update.
3. Phase 2: mini services JSON→UDP hook, .135 SSH key, M5Max rules.
