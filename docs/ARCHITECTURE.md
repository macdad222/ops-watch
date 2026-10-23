# ARCHITECTURE

*Current as of 2026-10-22 evening. The plain-English version of all of this is [GUIDE.md](GUIDE.md); the "why does this matter" version is [USE-CASES.md](USE-CASES.md); the judgment layer is documented in full in [JEV.md](JEV.md).*

## The pipeline in one diagram

```
Mac services ──udp-shipper.py──────┐  (mini + M5Max push; .135 pulled
                                   │   by ssh-log-pull.py on the mini)
FortiGate ──mini:514/udp──► collector.py ──┬──► Loki (retro/Gráfana)
Linux servers ──promtail──► Loki ──────────┘        │
                                   ▼               │
                    ┌── receiver.mjs ◄─(fortigate UDP leg)
                    │  data/events.jsonl
                    └────────┬────────
                    loki-tail.mjs (in-container tap, all jobs
                                   except fortigate-syslog)
                             ▼
                    triage.mjs (every 300s ticker cycle)
                    1. honeytokens/IOCs        → P0 (never suppressed)
                    2. app rules (rules.json)  → P1 (17 rules)
                    3. hum (health/debug/flood)→ P3 (held)
                    4. generic deterministic   → P1
                    5. Jev security-triage     → P2 hold/ping (blocking, 0.60)
                           ▼
                   Telegram ping | held.jsonl + Jev ledger
```

**Alert latency:** ingest = seconds (UDP), decision = one 300s ticker cycle → worst case ~5 min event-to-Telegram, typical 1–3 min. Repeat suppression: same P1 signature held 4h; P0 never suppressed.

## Fleet map (verified 2026-10-22 evening)

| Host | IP | Role | Coverage → ops-watch |
|---|---|---|---|
| aiagent (.110) | 192.168.5.110 | LiteLLM proxy :4010 + DB, agentic-gateway, research-frontend, langgraph, sovereign-chat, buzz-prod, admin-portal, cloudflared + **Loki :3100 host** + ops-watch container | **agent-promtail container** → Loki (journals `/var/log/syslog` + `kern.log` + `/var/log/auth.log` + ~25 docker container streams) + local receiver |
| tr9965-fast (.120) | 192.168.5.120 | LiteLLM mirror + DB, vllm-qwen36 :8000 | **agent-promtail container** → Loki (syslog + kern + **auth.log since 10-22 21:44**) |
| vllm-tr (.115) | 192.168.5.115 | vllm-glm53-flash :8000 (the GLM lane) | **vllm-promtail container** → Loki (syslog + kern + auth.log since 10-22 21:44) |
| Chris-Mac-mini (.56) | 192.168.5.56 | OpenClaw gateway, voice-bridge, voice-v3, lab-sentinel, watchdogs, homebridge | `udp-shipper.py` push (9 files, launchd `com.jarvon.udp-shipper`) + FortiGate collector host + `ssh-log-pull.py` for .135 |
| MacBook-Pro-2 (192.168.5.100) | omlx.lab.internal | omlx-serve :8000, OpenClaw bot box | `udp-shipper.py` push (3 files) |
| Chriss-Mac-Mini-M6 (.135) | 192.168.5.135 | vision lane (omlx-server :8000, embed-adapter :8010) | PULLED by mini's `ssh-log-pull.py` (6 files; Local Network TCC blocks launchd UDP push — RUNBOOK gotcha 9) |
| FortiGate CMACFG90G | 192.168.5.1 | perimeter firewall (FGT90G, FortiOS 7.4.12) | syslog → mini:514/udp → `fortigate-514-bridge/collector.py` → **both** Loki (job=fortigate-syslog) **and** receiver :15140/udp |
| **Loki :3100 + Grafana :3500** | **.110** (Loki) / mini (Grafana UI) | log brain — moved off mini 2026-10-22 (query timeouts + RAM pressure; full history preserved) | Grafana datasource → .110 |

**Loki host labels:** `agent-server` = .110, `tr-server` = .120, `vllm-tr` = .115. Hostname inside syslog *lines* is the OS hostname (`aiagent`, `tr9965-fast`, `vllm-tr`) — the raw-line parsers extract that, so triage sources show OS hostnames for raw jobs and Loki labels for container jobs.

## FortiGate SD-WAN intelligence (mapped 2026-10-22, keep for future incidents)

| Member | Interface | Link | Public IP | Behavior |
|---|---|---|---|---|
| 1 | wan1 | **Fiber** (PrairieNet) | 66.182.245.79 | carries ~all routed traffic; flaps SLA every 15–35s in bad windows (health-check SLA too tight) |
| 2 | "a" (alias SPECTRUM_1G) | **Spectrum cable** | 66.52.109.63 (Charter range, RDAP-confirmed) | 42 hard link-down/up per day; takes WAN scans (73 local-in denies/24h) |
| 3 | port1 | **Starlink** (double-NAT via Starlink router) | CGNAT (FGT leases 192.168.1.x) | 592 SLA flips/day, worst; real traffic out of it times out; never receives scans (CGNAT) |

Evidence chain (for when this needs re-verification): whois of each link's public IP (egress fingerprint via `curl api.ipify.org` from LAN hosts), second-level correlation of member state-changes with interface events, and the DATA→port1 timeout bursts when member 3 passed SLA. Root cause of the flap storm = `FIND_BEST_PATH` health check SLA (latency 50ms / jitter 8ms / loss 1% vs 8.8.8.8+1.1.1.1) — fix pending Chris (raise thresholds + exclude member 3).

## Ingest paths (three, corrected 2026-10-22)

1. **UDP receiver** (`receiver.mjs`): binds `0.0.0.0:15140` in-container (host-mapped 1:1 on .110). Mac shippers + the FortiGate collector's UDP leg land here as `{"received_at","peer","line"}` envelopes in `data/events.jsonl`.
2. **Loki tap** (`loki-tail.mjs`, runs inside the ops-watch container): fetches the Loki job list, queries **each job separately** (never `{job=~".+"}` — it hangs on this Loki build even with ~29 streams), merges into events.jsonl. **Excludes `fortigate-syslog`** — those lines arrive via the collector's UDP leg instead (full-window scans of that stream are pathologically slow; RUNBOOK 2026-10-22). Docker-job lines re-emitted as structured events; `syslog`/`kernel` jobs re-emitted as raw lines so the RFC3164 parser keeps host/program fidelity. Dedupe via rolling 4k hash set.
3. **FortiGate collector** (`fortigate-514-bridge/collector.py` on the mini): receives device syslog on :514/udp, batches, pushes verbatim lines to Loki (`job=fortigate-syslog`) **and** ships the same lines as UDP to the receiver (`192.168.5.110:15140` — host IP, *not* 127.0.0.1: inside a container that's the container itself, the 2026-10-22 networking slip). Two consumers, one source of truth.

**Linux coverage detail (added 2026-10-22 21:44):** each Linux host runs an `agent-promtail`-style container whose config scrapes `/var/log/syslog` + `/var/log/kern.log` (job=`syslog`, host label) — **and `/var/log/auth.log`** (job `agent-auth` → same `syslog` stream). rsyslog routes SSH/auth lines to auth.log *exclusively*, so without the auth scrape the ssh-bruteforce rule was blind. promtail's watchConfig may not fire on bind-mounted config edits → `docker restart` the promtail container after changes.

## Rules (17 live as of 2026-10-22)

**13 ops rules:** postgres-fatal, litellm-error-burst, vllm-engine-down, cloudflared-tunnel-down, kernel-oom, detected-error-burst, detected-fatal-level, omlx-lane-failure, voice-lane-failure, gateway-failure, watchdog-silence, sonos-watchdog, homebridge-failure.

**4 security rules (added 2026-10-22, closed the gap where the Oct 21 brute force would NOT have auto-alerted):**
- `fortigate-admin-auth-fail` — ≥3 failed admin/VPN logins per 5-min window ("Admin login failed", ssl-login-fail, admin_lockout)
- `fortigate-botnet-c2` — ≥10 botnet C&C block events per window (needs FortiGate UTM logging enabled — unverified on device)
- `ssh-bruteforce` — ≥10 failed SSH auths per window on job syslog
- `honeytoken-trigger` — ≥1 HONEYTOKEN string mention, any source (armed; plants = Phase 3)

Rule semantics and authoring: [RULES.md](RULES.md). Rules are re-read from `/app/rules.json` by **every** triage cycle → live update via `docker cp` needs no container restart (see RUNBOOK).

## Decision flow (fixed order — code above Jev)

1. **P0 — deterministic emergency.** Honeytoken string/account/domain/IOC match. Bypasses everything, pings immediately, never suppressed.
2. **P1 — app rules** (`rules.json`, first match wins).
3. **P3 — hum:** health/metrics scrapes, debug-level volume, info floods ≥15, repeated no-keyword patterns ≥8 → held.
4. **P1 — generic deterministic:** firewall config change, sudo/su, auth failures across ≥3 users, volume burst ≥50, critical syslog level.
5. **P2 — everything else → Jev `security-triage`** (blocking, threshold 0.60): per cluster, ONE typed call (noul: "is this routine recurring background noise? Not novel, not a config/policy change, not a spike, not security-relevant") over scrubbed, truncated samples. Score ≥ 0.60 → held to digest; < 0.60 or unparsed → ping; Jev down → **fail-open** (nothing suppressed, everything surfaces flagged `jevDown`). The question is worded so the safe failure is a ping. Full principles, call shape, ledger, and calibration: [JEV.md](JEV.md).
6. **Repeat suppression:** same P1 sig within 4h → held with "still active" note. P0 always re-pings.
7. **Batch cap:** ≤300 P2 clusters per Jev call (~$0.006 worst case); overflow → held, never pinged.
8. **Clustering scope (2026-10-23 flood hotfix):** the v1/shadow DECISION path clusters only the last `--window-min` window (`v1_cluster_mode: "window"`, default; `"batch"` opts back into whole-batch clustering). v2 mode clusters the whole unread batch — the backlog-drop fix (no silent event loss) is **v2-only until the v1→v2 flip**. In shadow, v2 still scores the full batch, ledger-only.

## State files (all under `data/` on .110, in the ops-watch container volume)

| File | Written by | Purpose |
|---|---|---|
| `events.jsonl` | receiver + loki-tail | raw event stream (rotated to `processed/` when >50 MB & fully consumed) |
| `loki-state.json` | loki-tail | `lastNs` cursor + dedupe hash ring (advances only on success → Loki outages self-heal) |
| `triage-state.json` | triage | `offset` into events.jsonl + `lastP1` repeat-suppression map |
| `held.jsonl` | triage | every held item with its why — the audit trail (mirrored to Jev ledger) |
| `jev-decisions.log` | jev-gate (container) | container-side decision ledger |

## Egress discipline

Log samples shipped to `api.typesafe.ai` (Jev) pass `scrub()`: tokens (`sk-*`, `AKIA*`, JWTs, Bearer), emails, phone numbers redacted; samples truncated (3 × 160 chars). Keys, bet content, contact data never leave. Telegram pings carry only verdict summaries + masked samples.

## Cost model

Jev verdicts ≈ $0.00002 each; worst case ≈ $1.70/day, observed cents/day (P2 pool 20–60/cycle after hum rules). Deterministic layers (rules, hum, generic) are free. The entire stack runs on existing infrastructure (one container on .110 + launchd agents on the Macs) — no new hardware, no new subscriptions.
