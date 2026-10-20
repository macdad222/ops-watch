# ARCHITECTURE

## Fleet map (verified 2026-10-20)

| Host | IP | Role | Logs → ops-watch via |
|---|---|---|---|
| aiagent (.110) | 192.168.5.110 | LiteLLM proxy :4010 + DB, agentic-gateway, research-frontend, langgraph, sovereign-chat stack, buzz-prod stack, admin-portal, cloudflared | Loki tap + local receiver |
| tr9965-fast (.120) | 192.168.5.120 | mirror of .110 + vllm-qwen36 (:8000) | Loki tap |
| vllm-tr (.115) | 192.168.5.115 | vllm-glm53-flash (:8000) — the GLM lane | Loki tap |
| Chris-Mac-mini (.56) | 192.168.5.56 | OpenClaw gateway, voice-bridge, voice-v3, lab-sentinel, watchdogs, **Loki :3100 + Grafana :3002** | localhost UDP (Phase 2 hook) |
| MacBook-Pro-2 | omlx.lab.internal | omlx-serve :8000, OpenClaw bot box | Phase 2 |
| Chriss-Mac-Mini-M6 (.135) | 192.168.5.135 | vision lane (omlx-server :8000, embed-adapter :8010) | Phase 2 (needs SSH key) |
| FortiGate | 192.168.5.1 | perimeter firewall | **UDP syslog → .110:15140** (only source without a pipeline today) |

Hostnames seen in Loki labels: `agent-server` = .110, `tr-server` = .120, `vllm-tr` = .115.

## Data flow

1. **Ingest — two paths:**
   - `receiver.mjs` binds UDP (container: `0.0.0.0:15140`, host-mapped 1:1). Each datagram → `{"received_at","peer","line"}` envelope appended to `data/events.jsonl`. FortiGate + Mac services land here.
   - `loki-tail.mjs` polls `GET /loki/api/v1/query_range` on the mini's Loki (:3100) each cycle: `{job=~".+"}`, forward direction, start = last processed ns + 1 (state: `data/loki-state.json`), capped 5000 lines/cycle. Docker-job lines are re-emitted as `{source:'loki', host, program:<job>, level:<detected_level>, ts, message}`; `syslog`/`kernel` jobs are re-emitted as raw lines so the RFC3164 parser keeps host/program. Dedupe via rolling 4k hash set in state.
2. **Normalize** (`lib.mjs`): four parsers — FortiGate KV (devid/type/subtype/level/action/ips/user), RFC3164-ish syslog (with sshd user extraction), JSON app logs, bare fallback. Every event gets a `sig` = sha1 of (source, host, program, behavior-masked message) — usernames→`<user>`, ips→`<ip>` last-octet-masked for FortiGate, numbers/hex→masked. Same behavior = same sig = one cluster.
3. **Cluster** (`clusterEvents`): group by sig within the window (default 5 min), track counts, distinct users/ips, first/last seen, 3 samples.
4. **Decide** (`triage.mjs`, order is fixed and code-owned):
   - honeytokens (P0) → `appRulesVerdict` from rules.json (P1) → health/metrics hum + debug/info hum (P3) → generic deterministic (config change, sudo, auth-burst ≥3 users, volume ≥50, critical level) (P1) → hum (P3) → **Jev `security-triage`** (blocking, threshold 0.60) → P2.
   - Repeat suppression: P1 sigs re-ping suppressed for 4h (`data/triage-state.json` → `lastP1` map). P0 never suppressed.
   - Batch cap: max 300 P2 clusters per Jev call (~$0.006/cycle worst case); overflow → held-flagged, never ping.
5. **Act:** pings → Telegram (combined message, ≤10 clusters); held → `data/held.jsonl` + Jev ledger. Offsets in `data/triage-state.json` make triage resumable; compaction at >50 MB only when fully consumed.

## State files (all under `data/` on .110)

| File | Written by | Purpose |
|---|---|---|
| `events.jsonl` | receiver + loki-tail | raw event stream (rotated to `processed/` when >50 MB & fully consumed) |
| `loki-state.json` | loki-tail | `lastNs` cursor + dedupe hash ring |
| `triage-state.json` | triage | `offset` into events.jsonl + `lastP1` repeat-suppression map |
| `held.jsonl` | triage | every suppressed/heap item — the audit trail (also in Jev ledger) |
| `jev-decisions.log` | jev-gate (container) | container-side decision ledger (mini's ledger stays canonical) |

## The Loki shortcut

The Linux fleet already runs promtail agents → Loki on the mini (17+ job labels). ops-watch consumes that instead of requiring per-box shippers. Consequence: **container logs from .110/.120/.115 are covered the moment the tap runs** — no changes on those boxes. FortiGate and Mac services are the only direct-UDP sources.

## Egress discipline

Log samples shipped to `api.typesafe.ai` (Jev) pass `scrub()`: tokens (`sk-*`, `AKIA*`, JWTs, Bearer), emails, phone numbers redacted; samples truncated (3 × 160 chars). Keys, bet content, and contact data never leave. The Telegram path carries only verdict summaries + samples.

## Cost model

Jev verdicts ≈ $0.00002 each. Worst case (300 P2/cycle, 288 cycles/day) ≈ $1.70/day; observed real-fleet P2 pool after hum rules ≈ 20-60/cycle → cents/day. Deterministic layers are free.
