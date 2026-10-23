# ops-watch Fleet Deployment Plan
*Chris's machines → apps → log paths → detection rules → rollout. 2026-10-20 recon, all verified live.*

---

## 1. The map (what's actually running)

**.110 "aiagent" — the hub (Docker)**
- LiteLLM proxy :4010 (DB-backed, the one friends + our stack hit) + its Postgres
- litellm-agentic-gateway, research-frontend :8080, langgraph-app
- sovereign-chat stack (web :3020, graphiti, neo4j :7474/:7687, postgres, redis, browser)
- buzz-prod stack (relay :3040, postgres, redis, minio)
- admin-portal (nginx :80), cloudflared (tunnel = the public path), ~10 exporter/metrics ports

**.120 "tr9965-fast" — mirror + serving (Docker)**
- Same stack as .110 PLUS: vllm-qwen36 (:8000, GPU serving), promtail, cadvisor, node-exporter

**.115 "vllm-tr" — GPU serving (Docker)**
- vllm-glm53-flash (:8000) — the GLM lane our whole stack runs on
- nvidia-gpu-exporter, node-exporter, promtail

**Mac mini (this box, .56) — Jarvon home**
- OpenClaw gateway, voice-bridge, voice-v3, lab-sentinel, m5max/sonos/telegram watchdogs, mcporter daemon
- **Loki :3100 + Grafana :3002 (login wall)** — the log brain already lives here
- Listeners resolved (Phase 2, 2026-10-22): :8090 = lan-dashboard web UI container, :1515 = fortigate-syslog-promtail TCP listener, :3001 = fortigate-mcp server (all Docker Desktop)
- Ships 9 of its own service logs via `udp-shipper.py` (com.jarvon.udp-shipper) + pulls .135's logs via `ssh-log-pull.py` (com.jarvon.ssh-log-pull)

**M5Max (192.168.5.100, omlx.lab.internal)**
- omlx-serve (:8000) + OpenClaw bot box (:18789), misc listeners :5000/:7000/:8100
- Ships omlx-serve stdout/stderr + gateway.log via `udp-shipper.py` (com.jarvon.udp-shipper)

**.135 Mac mini M6** — vision lane (omlx-server :8000, omlx-embed-adapter :8010)
- SSH key installed (mini → .135, key-based, works)
- ⚠️ **Cannot push UDP from launchd**: macOS Local Network (TCC) restriction — launchd-spawned python gets EHOSTUNREACH on LAN sends while ssh-launched processes work. Logs are PULLED instead: `ssh-log-pull.py` runs on the mini, SSHes in, tails the 6 log files, ships UDP from the mini. See docs/RUNBOOK.md § Mac shipper operations.

**FortiGate** — the perimeter. Not shipping logs anywhere yet.

---

## 2. The shortcut (found during recon)

**Promtail agents already ship Docker + system logs from the whole Linux fleet to Loki — now on .110 (moved off the mini 2026-10-22; the mini's Docker VM + 8GB RAM couldn't sustain the FortiGate firehose + query load).**
17 job labels confirmed live: `litellm-linux-test, litellm-linux-db, litellm-agentic-gateway, vllm-glm53-flash, vllm-qwen36, cloudflared, admin-portal, buzz-prod-*, sovereign/langgraph/langfuse stacks, kernel, syslog`.

So the log plumbing is mostly **already built**:
- **Linux fleet** → ops-watch taps Loki's query API (new `loki-tail.mjs`, polls every cycle). Zero changes on those boxes.
- **FortiGate** → the ONLY source with no pipeline → ships UDP syslog to ops-watch's receiver (already built).
- **Mac services (launchd)** → `udp-shipper.py` tails each service's log file and ships JSON envelopes to the receiver (mini + M5Max push; .135 is pulled over SSH because of its Local Network TCC restriction).

---

## 3. Detection rules per app (what will actually ping you)

**P0 — honeytokens (deterministic, can't be talked down):**
- Canary account touched on any server · canary DNS lookup · canary cred string in any log

**P1 — deterministic, per app:**
| App | Rule |
|---|---|
| LiteLLM (.110/.120) | 5xx/error-rate spike vs baseline; DB unhealthy; gateway container restart |
| vLLM (.115/.120) | server restart / CUDA OOM / healthcheck fail = model lane down (you'd notice within minutes via OpenClaw anyway — this explains it) |
| cloudflared | tunnel disconnect/reconnect = **public LiteLLM path down** |
| Containers (all) | unexpected exit/OOM-kill in kernel or docker logs |
| admin-portal (nginx) | 5xx spike, 401/403 burst on admin paths |
| buzz / sovereign / langfuse / langgraph | unhealthy → restart transitions, DB/redis/neo4j down |
| OpenClaw gateway (mini + M5Max) | gateway restart/exit = **me going down** (meta-monitoring) |
| FortiGate | config changes, auth bursts, new-deny spikes (already built) |
| Voice bridge/watchers (mini) | process exit (launchd restart loops), error bursts |

**P2 — everything else:** Jev triage → held-to-digest (blocking, per your 2026-10-20 call) or ping if novel.

**P3 — held:** recurring hum (already built).

---

## 4. Rollout

**Phase 1 — core lane (this week, ~1 day):**
1. `loki-tail.mjs` — Loki range-query poller feeding the existing normalizer (Loki labels map to `source`/`program` natively)
2. Deploy receiver + triage on **.110** (docker, restart-always) — 24/7 home; Loki lives on .110 too (moved 2026-10-22), tapped in-container
3. LiteLLM + vLLM + cloudflared + container-exit rules (deterministic)
4. Cron: triage loop every 5 min on .110
5. ✅ FortiGate: already feeding via mini:514 → `fortigate-514-bridge`/collector.py → Loki (found 2026-10-22; no device change needed — the promtail :1514/:1515 listeners are vestigial)

**Phase 2 — the Macs (DONE 2026-10-22):**
6. ✅ Mini shipper: `udp-shipper.py` + `com.jarvon.udp-shipper` — 9 files/7 programs (openclaw-gateway, voice-bridge, voice-v3, lab-sentinel ×2, m5max-watchdog, sonos-watchdog, homebridge ×2). Verified in events.jsonl.
7. ✅ .135 vision lane: SSH key installed; **push blocked by macOS Local Network TCC** (launchd python → EHOSTUNREACH; ssh context works). Solution: `ssh-log-pull.py` runs on the MINI, pulls .135's 6 logs over SSH (30s cycle, byte-offset state), ships from the mini. Same rule set applies (omlx-lane-failure, omlx-error-burst).
8. ✅ M5Max: `udp-shipper.py` on omlx-serve stdout/stderr + gateway.log. Verified in events.jsonl. Quirk: after bootout+bootstrap, launchd sometimes leaves the job not running — explicit `launchctl kickstart` fixes.
9. ✅ Mystery listeners: :8090 = lan-dashboard UI, :1515 = fortigate-syslog-promtail, :3001 = fortigate-mcp (all Docker Desktop, mini).

**Phase 2 rules added (rules.json):** omlx-lane-failure, omlx-error-burst, voice-lane-failure, openclaw-gateway-failure, watchdog-failure-burst, homebridge-failure.

**Phase 3 — the intelligence layer (~½ day):**
10. Daily ops digest (6am): everything held, plain-language
11. Weekly calibration digest (Sun 8pm): false-positive rate, threshold drift, your dismissals → tuning
12. Honeytoken plants (you plant, I match)

**Phase 4 — standing audit (later):**
13. Quarterly "did we get hit" replay of 90 days of held events

---

## 5. What I need from you

1. **Deploy target OK?** — .110 as the 24/7 ops-watch home (my rec; it's already the always-on Docker hub) ✅
2. ~~FortiGate syslog target~~ — RESOLVED 2026-10-22: device feeds mini:514 → collector.py → .110 Loki; ops-watch taps it through Loki
3. **.135 SSH key** — one-time: run one command on the M6 (or approve via Screen Sharing) to add my pubkey ✅ (done 2026-10-22)
4. **Honeytoken plants** — say the word and I'll generate the plant kit + instructions per machine
5. Bless or veto any P1 rule above — the list is tuned to "would this make me look?"
