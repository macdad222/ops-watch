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

## Mac shipper operations (Phase 2, 2026-10-22)

**Components:** `udp-shipper.py` (push, stdlib Python) on mini + M5Max; `ssh-log-pull.py` (pull, stdlib Python) on the mini for .135.

**Mini (push, 9 files)** — `com.jarvon.udp-shipper` launchd agent:
```bash
launchctl print gui/$(id -u)/com.jarvon.udp-shipper | grep -E 'state|pid'   # running?
tail -5 ~/clawd/projects/ops-watch/logs/shipper.out                          # send failures logged here
```
Files covered: openclaw-gateway, voice-bridge, voice-v3, lab-sentinel ×2, m5max-watchdog, sonos-watchdog, homebridge ×2.

**Loki location (moved 2026-10-22):** Loki + Grafana now run on **.110** (`~/monitoring/loki/`, container `vllm-loki`, port 3100; Grafana still on the mini :3500 with datasource → .110). Promtail agents on .110/.120/.115 point at 127.0.0.1/.110. The mini's old `vllm-loki` container is STOPPED, its data volume intact as rollback. The ops-watch container taps Loki in-process (`LOKI_TAIL_ENABLED=1`, writes events.jsonl locally — no UDP involved). The one-off mini tap launchd job (`com.jarvon.ops-watch-loki-tail`) was removed after the move.

**FortiGate real ingestion path (found 2026-10-22, don't confuse it with promtail):** FortiGate → **mini :514/udp → `fortigate-514-bridge` container** → runs `~/clawd/tools/fortigate-syslog/collector.py` (preserves lines verbatim, batches, pushes straight to Loki with job=fortigate-syslog). The `fortigate-syslog-promtail` container (:1514/:1515) is VESTIGIAL — the device doesn't target it, its RFC5424 parser rejects the FortiGate KV format (4 parse errors ever, all its own noise). When Loki moves, update **collector.py's `LOKI` URL** (was host.docker.internal → now http://192.168.5.110:3100) — that's the failure that silently killed the fortigate feed during the migration.

**Loki gotchas learned in the move:**
- The `{job=~".+"}` regex matcher hangs even with 29 streams while every `{job="x"}` is instant → tap queries per-job.
- Copying the TSDB volume while Loki runs corrupts it ("segments are not sequential") — stop Loki first.
- Compose project dir names prefix volume names (`~/monitoring/loki` → `loki_loki-data`); extracting into a guessed volume name silently feeds an empty volume.
- Docker NAT drops heavily-fragmented UDP datagrams (>~8KB) on BOTH the mini and .110 — keep UDP datagrams ≤1300B (the Mac shippers already do; the in-container tap doesn't use UDP at all).

**M5Max (push, 3 files)** — same label, plist at `~/Library/LaunchAgents/com.jarvon.udp-shipper.plist` (user chrismacfarland): omlx-serve stdout/stderr + `~/Library/Logs/openclaw/gateway.log`. Gotcha: after `bootout`+`bootstrap`, launchd sometimes leaves it not running — run `launchctl kickstart gui/$(id -u)/com.jarvon.udp-shipper` explicitly.

**.135 (pull, 6 files)** — `com.jarvon.ssh-log-pull` on the MINI, not on .135. The mini SSHes to `chrismacfarland@192.168.5.135` (key-based), tails each file by byte offset (state: `state/ssh-log-pull-state.json`), ships UDP from the mini:
- omlx-serve stdout+stderr (note: omlx-serve writes to **stderr** — stdout.log has been stale since Oct 3)
- omlx-embed-adapter stdout+stderr, vllm-mlx proxy.log + embed.log

**Grafana:** stays on the mini (:3500, provisioned read-only datasources in `~/monitoring/grafana/provisioning/datasources/datasources.yaml` — edit there + `docker restart vllm-grafana`; admin/vllmrocks1!).

**Why pull for .135:** macOS **Local Network (TCC) restriction** — launchd-spawned python on .135 gets `[Errno 65] No route to host` on UDP sends to LAN targets, while ssh-launched processes work. Verified: direct python UDP tests from .135 arrive at any payload size; firewall app rules are all "Allow"; oMLX.app's bundled python also fails from launchd. Fixing properly = grant Local Network to Python in System Settings → Privacy & Security → Local Network **via Screen Sharing** (GUI-only), then re-enable push:
```bash
# on .135, after granting:
mv ~/Library/LaunchAgents/internal.lab.udp-shipper.plist.disabled-20261022 ~/Library/LaunchAgents/internal.lab.udp-shipper.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/internal.lab.udp-shipper.plist
launchctl kickstart gui/$(id -u)/internal.lab.udp-shipper
# then on the mini: launchctl bootout gui/$(id -u)/com.jarvon.ssh-log-pull
```

**Add a new log file to any shipper** → edit the plist's ProgramArguments (`--file`/`--program` pairs; pull collector also needs `--host`), `plutil -lint`, bootout+bootstrap+kickstart. `program` value = the rule-matcher job name — keep it consistent with rules.json.

**Verification one-liner:** append a harmless line to a covered log on the target host, wait ≤35s, then `ssh chris@192.168.5.110 "grep <marker> ~/ops-watch/data/events.jsonl"`.

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
9. **macOS Local Network (TCC) blocks launchd UDP sends on .135** — launchd-spawned python gets EHOSTUNREACH on LAN sends; ssh-context works; oMLX.app's python fails too (not the binary — the launchd context). Worked around with the ssh-pull collector; GUI grant needed to ever re-enable push.
10. **Mini/M5Max launchd jobs can boot without firing RunAtLoad** — after bootout+bootstrap, `launchctl print` may show `state = not running / runs = 0`; explicit `launchctl kickstart` fixes. Don't trust bootstrap alone.
11. **/usr/bin/python3 is 3.9 on the minis** — no `int | None` PEP 604 syntax (TypeError at def time); use plain annotations or `typing.Optional` in shipper scripts.
12. **omlx-serve on .135 logs to stderr, stdout is stale** — tail stderr.log; the pull collector covers both, but don't be surprised stdout shows nothing since Oct 3.
13. **Append-before-start gets skipped** — both shippers start at EOF; to test, START the shipper first, THEN append the test line.
14. **brew versioned-Cellar upgrades break resolved-path pins** (2026-10-22, cost the M5Max bot ~4h of dead exec): upgrading `node@24` 24.20.0→24.22.1 deleted `Cellar/node@24/24.20.0/`, and every long-running process that resolved that path at startup (process.execPath) then failed to spawn children. **Verify rule: after any brew upgrade that bumps a runtime binary, test a FRESH spawn of the pinned path — running-process survival proves nothing.** Durable pins use `/opt/homebrew/opt/<formula>/bin/<bin>` (opt symlink), never `Cellar/<formula>/<version>/`.
15. **promtail watchConfig does not fire on bind-mounted config edits** — `docker exec ... promtail` hot-reload worked for the URL change once, but the auth-job addition never reloaded → always `docker restart` the promtail container after config edits, then verify positions/streams in Loki.
16. **127.0.0.1 inside a container is the container, not the host** — hit TWICE on 2026-10-22 (fortigate collector UDP leg + agent-promtail Loki push on .110, silently dead since the old-Loki era). Inside a container, target the host LAN IP (192.168.5.110) or the docker network alias (vllm-loki). Symptom: "connection refused" in logs, zero data flowing, everything else looks healthy.
17. **rsyslog routes SSH/auth lines to `/var/log/auth.log` EXCLUSIVELY** — `/var/log/syslog` does not contain them (authpriv is excluded). A promtail config that scrapes only syslog+kern.log leaves the ssh-bruteforce rule blind even though "it ships syslog".

## Common operations

**Change a threshold** → edit `~/ops-watch/config/gates.json` on .110 (mounted ro; recreate container after) **and** mirror to `~/clawd/projects/jev/gates.json` on the mini. Never hardcode thresholds in scripts.

**Add an app rule** → edit `rules.json` (repo), then live-reload without downtime:
```bash
scp ~/clawd/projects/ops-watch/rules.json chris@192.168.5.110:/tmp/rules.json
ssh chris@192.168.5.110 'docker cp /tmp/rules.json ops-watch:/app/rules.json && rm /tmp/rules.json && docker exec ops-watch node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"/app/rules.json\")).rules.length + \" rules live\")"'
```
Triage re-reads rules.json **every 300s cycle** — the new rule is live within one cycle, no container restart. (Verify with a `--digest-only` manual run.) Schema in [docs/RULES.md](docs/RULES.md). Run `node selftest.mjs` in `projects/jev/` after any gate-touching change.

**Silence a noisy legit pattern** → add it to the hum check in `lib.mjs` (deterministic) or let Jev learn it (it holds benign ≥0.60). Prefer rules.json patterns for app-specific cases.

**See what was held and why** → `ssh chris@192.168.5.110 'tail -20 ~/ops-watch/data/held.jsonl'` or query the Jev ledger: `grep security-triage ~/ops-watch/data/jev-decisions.log | tail`.

**Kill switch:** `JEV_DISABLE=1` env on the container → Jev never consulted, nothing suppressed, P0/P1 deterministic still pings. Container-level: `docker stop ops-watch` → FortiGate logs buffer nowhere (UDP is fire-and-forget); restart ASAP.

**Alert latency model (know what "fast" means):** ingest is seconds (UDP + promtail batch ≈ 1s); triage cycles every 300s → worst case ~5 min event-to-Telegram, typical 1–3 min. The SAME P1 signature is held for 4h (no re-ping) — an ongoing brute force pings once, then "still active" notes land in held.jsonl. P0 (honeytokens) always re-pings. If you need faster cycles, change CYCLE_SEC in `ticker.sh` (300s chosen to balance Telegram noise vs detection speed).

## Add a new host (5 minutes per Linux box)

**Linux (.x):** copy the working promtail pattern from .110 (or .120/.115 — identical):
```bash
ssh chris@192.168.5.<NEW> 'docker ps | grep promtail'   # already covered? (.115 uses name vllm-promtail)
# If not: run the agent-promtail container with /home/chris/monitoring-agent/promtail-config.yaml:
#   - clients.url → http://192.168.5.110:3100/loki/api/v1/push   (NOT 127.0.0.1 — gotcha 4/16!)
#   - static job → labels: job: syslog, host: <hostname>, __path__: /var/log/syslog
#   - SECOND static job (agent-auth) → same labels, __path__: /var/log/auth.log
#     (rsyslog routes SSH lines to auth.log EXCLUSIVELY — without this the ssh-bruteforce rule is blind)
#   - kern.log job for kernel coverage
#   - optional docker_sd job for container stdout
# then: docker restart <promtail-container>   # watchConfig does NOT fire on bind-mounted config edits (gotcha 15)
```
Verify: `curl -sG http://192.168.5.110:3100/loki/api/v1/query --data-urlencode 'query=sum by (host) (count_over_time({job="syslog"}[15m]))' | jq` — the new host label must appear within ~2 min. Then confirm loki-tail picks it up on the next ticker cycle (`grep <host> ~/ops-watch/data/events.jsonl`).

**Mac:** edit the `com.jarvon.udp-shipper` plist `--file`/`--program` pairs, `plutil -lint`, bootout+bootstrap+kickstart (see gotcha 10). **.135:** add `--file`/`--program`/`--host` args to `ssh-log-pull.py`'s plist on the MINI.

**Loki down:** loki-tail logs the failure, ticker continues; receiver events still flow. Old range is picked up when Loki returns (state cursor only advances on success — actually verify: cursor advances only for fetched lines; a full failure leaves lastNs untouched → backlog refetches automatically).

## Jev operations (the judgment layer)

The full principles/flow doc is [JEV.md](JEV.md); here's the operator's table:

| Task | How |
|---|---|
| Kill ALL Jev (every gate) | `JEV_DISABLE=1` on the container env → recreate (fail-open verified: nothing suppressed, P0/P1 still ping) |
| Kill one gate | `enabled: false` in `gates.json` (mini) **and** `~/ops-watch/config/gates.json` (.110, mounted ro → recreate container) |
| Change a threshold | edit both gates.json copies, then `cd ~/clawd/projects/jev && node selftest.mjs` (36 cases, ~$0.01) |
| Weekly health | `node jev-digest.mjs --days 7` (cron `jev-calibration-digest`, Sun 20:00 CT) — reads the ledger, reports hold/flag rates + version consistency |
| See recent verdicts | `grep security-triage ~/ops-watch/data/jev-decisions.log \| tail` (also canonical ledger on mini: `projects/jev/decisions.log`) |
| See what was held | `tail -20 ~/ops-watch/data/held.jsonl` |
| Version drift check | digest shows `⚠ MULTIPLE jev versions` / `pin_fallback` → compare flag rates before any threshold change (pin file: `projects/jev/model-pin.txt`, currently `jev-1.13.0`) |
| Revoke the BLOCKING authorization | Chris-only: `security-triage.mode: advisory` in gates.json → all P2 flows to digest, deterministic layers unchanged |

**Never** inline the Jev API key in commands — scripts read `projects/jev/ts-lane-id.txt` at runtime (exec redactor corrupts key literals; gotcha 14's cousin). **Never** hardcode thresholds in scripts — gates.json only. **Never** propose moving `security-fp-filter` (or any security gate outside this pipeline) to blocking — advisory is permanent by Chris's rule.

## What still needs Chris

1. Honeytoken plants + matching `honeytokens.json` update.
2. *(Optional)* Grant Local Network to Python on .135 via Screen Sharing if you ever want the push shipper back there — the pull collector works fine without it.
3. *(Resolved 2026-10-22)* FortiGate direct-to-receiver syslog (→ .110:15140) is no longer needed — the device already feeds Loki via mini:514 → `fortigate-514-bridge/collector.py`, which ops-watch taps through Loki.

**Done 2026-10-22 (Phase 2):** mini services shipper, M5Max shipper, .135 ssh-pull collector + vision-lane rules, mystery listeners identified (:8090 lan-dashboard, :1515 fortigate-promtail, :3001 fortigate-mcp).

**Done 2026-10-22 (evening, Phase 2.5):** 4 security rules added to rules.json and live-deployed (fortigate-admin-auth-fail, fortigate-botnet-c2, ssh-bruteforce, honeytoken-trigger — the Oct 21 brute force would now auto-alert); Linux fleet auth.log coverage added on all three (.110/.120/.115) — the ssh-bruteforce rule has real eyes on every server; .110's agent-promtail push URL repaired (127.0.0.1 slip — gotcha 16) so ~25 docker containers + syslog/kernel/auth now flow; alert latency quantified (≤5 min worst case, 4h P1 repeat suppression); docs rebuilt (GUIDE.md + USE-CASES.md new, ARCHITECTURE/RULES/RUNBOOK current).

**Still needs Chris:** (1) honeytoken plants + matching `honeytokens.json` update (Phase 3 — the rule is armed, nothing feeds it yet). (2) FortiGate: confirm SD-WAN health-check SLA change (raise 50ms/8ms/1% → ~130ms/30ms/2%, exclude member 3) and whether UTM/DNS logging is enabled (feeds the botnet rule). (3) Confirm the FortiAnalyzer at 52.23.219.9 (serial FAZAWSTA24002558) is yours — if not, disable it (log exfiltration). (4) Optional: real API token into `projects/fortigate-monitor/.env` for live latency dashboards (project exists, placeholder creds).
