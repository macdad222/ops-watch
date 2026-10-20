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
- Unknown-to-me listeners: :8090 (web UI), :3001, :1515 — will ID during rollout

**M5Max (omlx.lab.internal)**
- omlx-serve (:8000) + OpenClaw bot box (:18789), misc listeners :5000/:7000/:8100

**.135 Mac mini M6** — vision lane (omlx-server :8000, omlx-embed-adapter :8010)
- ⚠️ No SSH key from here yet (reverse direction only) — needs one-time key install

**FortiGate** — the perimeter. Not shipping logs anywhere yet.

---

## 2. The shortcut (found during recon)

**Promtail agents already ship Docker + system logs from the whole Linux fleet to Loki on the mini.**
17 job labels confirmed live: `litellm-linux-test, litellm-linux-db, litellm-agentic-gateway, vllm-glm53-flash, vllm-qwen36, cloudflared, admin-portal, buzz-prod-*, sovereign/langgraph/langfuse stacks, kernel, syslog`.

So the log plumbing is mostly **already built**:
- **Linux fleet** → ops-watch taps Loki's query API (new `loki-tail.mjs`, polls every cycle). Zero changes on those boxes.
- **FortiGate** → the ONLY source with no pipeline → ships UDP syslog to ops-watch's receiver (already built).
- **Mac services (launchd)** → our own Node apps (voice-bridge, voice-v3, lab-sentinel, watchers) get a 3-line JSON→UDP logger pointed at localhost:15140.

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
2. Deploy receiver + triage on **.110** (docker, restart-always) — 24/7 home; mini stays the Loki/Loki-tap side
3. LiteLLM + vLLM + cloudflared + container-exit rules (deterministic)
4. Cron: triage loop every 5 min on .110
5. You point FortiGate remote syslog at `.110:15140` (2 clicks in the FortiGate UI)

**Phase 2 — the Macs (~½ day):**
6. JSON→UDP hook in the mini's jarvon services
7. SSH key to .135 → omlx-server + embed-adapter rules (vision lane health = the daily 9am cron already checks; this makes it continuous)
8. M5Max omlx-serve rules (already reachable)
9. ID mystery listeners (:8090, :3001, :1515)

**Phase 3 — the intelligence layer (~½ day):**
10. Daily ops digest (6am): everything held, plain-language
11. Weekly calibration digest (Sun 8pm): false-positive rate, threshold drift, your dismissals → tuning
12. Honeytoken plants (you plant, I match)

**Phase 4 — standing audit (later):**
13. Quarterly "did we get hit" replay of 90 days of held events

---

## 5. What I need from you

1. **Deploy target OK?** — .110 as the 24/7 ops-watch home (my rec; it's already the always-on Docker hub)
2. **FortiGate syslog target** — you set it (Log & Report → Log Settings → Remote Syslog → 192.168.5.110:15140), or hand me admin creds and I do it
3. **.135 SSH key** — one-time: run one command on the M6 (or approve via Screen Sharing) to add my pubkey
4. **Honeytoken plants** — say the word and I'll generate the plant kit + instructions per machine
5. Bless or veto any P1 rule above — the list is tuned to "would this make me look?"
