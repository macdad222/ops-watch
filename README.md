# ops-watch

**Jev-gated telemetry triage for the whole fleet** — FortiGate firewall, Linux servers, Docker apps, Mac services. Turns thousands of log events into a handful of Telegram pings that matter, holds the rest in an auditable digest, and never silently drops anything. The judgment layer is **Jev (TypeSafe System One)** — a fast, cheap, typed-decision AI that only ever answers "routine or novel?" on the ambiguous middle band, wrapped in deterministic guardrails. See [docs/JEV.md](docs/JEV.md).

> **Authorized mode:** the `security-triage` gate runs **BLOCKING** per Chris (2026-10-20), scoped to this pipeline only. Original advisory-forever rule for `security-fp-filter` still governs everywhere else. See [docs/RULES.md](docs/RULES.md) for the safety contract.

## TL;DR architecture

```
Mac services ──udp-shipper.py──────┐  (mini + M5Max push; .135 pulled
                                   │   by ssh-log-pull.py on the mini)
                                   ▼
                    ┌── receiver.mjs ──┐      ┌── Loki (.110 :3100) ──────────┐
                    │  events.jsonl    │◄─────┤ loki-tail.mjs (in-container tap)
                    └────────┬─────────┘      │  (promtail agents + FortiGate │
                             ▼                │   via mini:514 collector.py)  │
                    ┌── triage.mjs (every 5 min) ──────────────────┐
                    │ 1. deterministic: honeytokens/IOCs → P0      │
                    │ 2. app rules (rules.json)         → P1       │
                    │ 3. hum: health-scrapes, debug, info-flood → P3│
                    │ 4. generic: auth-burst, config, OOM  → P1    │
                    │ 5. Jev security-triage (BLOCKING)  → hold/ping│
                    └──────┬───────────────────────┬───────────────┘
                           ▼                       ▼
                   Telegram ping (P0/P1/novel)   held.jsonl + Jev ledger
```

**Live deployment:** Docker container `ops-watch` on **.110** (restart-always). Two FortiGate legs: the mini's `fortigate-514-bridge/collector.py` feeds **both** Loki (job=fortigate-syslog, for Grafana) **and** the receiver (:15140 UDP); loki-tail therefore skips the fortigate job. Linux hosts (.110/.120/.115) ship syslog + kern + **auth.log** via promtail containers → Loki. Alert latency: seconds to ingest, ≤5 min to Telegram (300s triage cycle), repeat-suppressed 4h for P1, never for P0.

## Quickstart (mini)

```bash
cd ~/clawd/projects/ops-watch
node demo.mjs                                   # synthetic end-to-end proof (pings labeled SYNTHETIC-TEST)
node loki-tail.mjs /tmp/ev.jsonl --window-min 10 # pull real fleet logs from Loki
node triage.mjs /tmp/ev.jsonl --digest-only      # classify without pinging
./deploy.sh                                      # push + rebuild container on .110
```

## Decision flow (fixed order — code above Jev)

1. **P0 — deterministic emergency.** Honeytoken string/account/domain/IOC match. Bypasses Jev entirely, pings immediately, can never be suppressed.
2. **P1 — app rules** (`rules.json`): postgres FATAL, LiteLLM error bursts, vLLM engine failure, cloudflared tunnel loss, kernel OOM, promtail fatal/critical levels.
3. **P3 — hum (code, not Jev):** health/metrics scrapes, debug-level volume, info floods ≥15, repeated no-keyword patterns ≥8. Held, visible, never deleted.
4. **P1 — generic deterministic:** firewall config change, sudo/su, auth failures across ≥3 users, volume burst ≥50, critical syslog level.
5. **P2 — everything else → Jev `security-triage`** (blocking): benign ≥0.60 → held-to-digest; novel/unparsed → ping.
6. **Repeat suppression:** any P1 sig re-pinging within 4h → held with "still active" note (state in `triage-state.json`). P0s always re-ping.
7. **Fail-open:** Jev down/unreachable → zero Jev suppression; P0/P1 still ping; everything else surfaces flagged `jevDown`.

## Files

| File | Role |
|---|---|
| `receiver.mjs` | UDP syslog listener → `data/events.jsonl` (bind/out via env) |
| `loki-tail.mjs` | Loki range-API poller, dedupes via state hash set |
| `lib.mjs` | parsers (FortiGate KV / RFC3164 / JSON / bare), signature clustering, deterministic verdicts, egress scrubber |
| `triage.mjs` | the decision pipeline + Jev gate call + Telegram pings |
| `notify.mjs` | Telegram sender (token: env `TG_BOT_TOKEN` → `secrets/tg.cred` → MEMORY.md) |
| `rules.json` | app-specific P1 rules — **add rules here, not in code** |
| `udp-shipper.py` | Mac log tailer → UDP JSON envelopes (launchd `com.jarvon.udp-shipper`; mini 9 files, M5Max 3) |
| `ssh-log-pull.py` | SSH pull collector on the mini for .135's logs (Local Network TCC workaround) |
| `honeytokens.json` | canary definitions — must match real planted artifacts |
| `ticker.sh` | container loop: receiver + 5-min cycles + compaction |
| `demo.mjs` | synthetic 71-event proof run |
| `deploy.sh` | push to .110 + rebuild container (secrets assembled at runtime, never typed) |

## The docs

- [docs/GUIDE.md](docs/GUIDE.md) — **start here**: the plain-English guide (no jargon), how to read an alert, glossary
- [docs/JEV.md](docs/JEV.md) — **the novel tech**: Jev principles, **why the system is nearly impossible without it (with live measured numbers)**, the full ops-watch judgment flow, the safety contract, thresholds/ledger/calibration
- [docs/USE-CASES.md](docs/USE-CASES.md) — every high-value use case with real examples (the Oct 21 firewall attack, the SD-WAN forensic)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data flow, fleet map, SD-WAN member→ISP mapping, state, Loki integration
- [docs/RUNBOOK.md](docs/RUNBOOK.md) — deploy/update/rollback, health checks, shipper ops, troubleshooting (includes every gotcha hit during the real deploys)
- [docs/RULES.md](docs/RULES.md) — rule authoring + the security contract (what Jev may and may never do)
