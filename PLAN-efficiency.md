# ops-watch Efficiency Redesign — Plan (2026-10-23, for Chris review)

## Current architecture (verified today)
```
FortiGate CMACFG90G ─UDP 514→ mini .56 (fortigate-514-bridge / collector.py)
                              ├─→ Loki .110:3100 [full fidelity, job=fortigate-syslog]
                              └─→ raw UDP → .110:15140 ops-watch receiver
Fleet Macs (.56 udp-shipper, .135 ssh-log-pull) ─UDP JSON→ .110:15140
Loki other jobs ─loki-tail.mjs (per-job, deduped, direct append)→ events.jsonl

.110 ops-watch container:
  receiver.mjs — appends EVERYTHING to data/events.jsonl (no filter, no rate limit)
  ticker.sh    — 5-min cycle: loki-tail → triage → compaction (mv→processed/, keep 20)
  triage.mjs   — unread window → normalize → cluster → deterministic P0/P1 →
                 Jev gate (TypeSafe) on P2 → Telegram pings → Qwen assessment (new today)
```

## Measured pain (today's evidence)
- 100% of FortiGate volume (60K lines/h, 76–100MB/h bursts) enters triage; ~98% is routine noise
- Cost already paid: triage dead 8.5h (string-limit crash), 1GB events.jsonl, 125MB processed copies, 23MB logs/day, Jev 150-cluster cap burned on firewall noise, every line written to disk 2x (Loki + events.jsonl)
- receiver accepts from anyone, zero filtering — any chatty device can recreate today's incident
- triage failures are SILENT (one line in ticker.log) — that's how 8.5h passed unnoticed
- held.jsonl lives in the container writable layer — a recreate wipes the held-noise ledger

## Design principle
**Loki = bulk lane** (full fidelity, queryable, 30d retention — done today). **ops-watch = signal lane** (security/health events only). Route by class at the edge, defend at the ingest, observe the pipeline itself.

## Phase 1 — Edge routing at collector.py (~80% of the benefit)
Ship to ops-watch ONLY security-relevant lines:
- `type=event` (system, wireless rogue, admin, config change) — any level
- `type=utm` level ≥ warning (virus/ips/webfilter/dns hits) — never information-level app-ctrl signatures
- `type=traffic` level ≥ warning (deny storms) — nothing routine
Loki keeps 100% (unchanged). Implementation: `should_mirror(line)` predicate in collector.py (it already regex-parses type/level for labels). Bridge container rebuild on .56 (seconds).
Volume: ~76MB/h → **~1–2MB/h (~2%)**. events.jsonl working set drops to ~1MB/day; Jev tokens ~0; assessments only on real events.
Risk: signal hidden in info-level logs is missed → mitigations: Loki has everything; 1-week review; threshold is one predicate line. Review after a week, loosen if needed.

## Phase 2 — Receiver defense (kills the incident class) — DO FIRST
- Per-peer rate bucket in receiver.mjs: peer sustained >50 lines/s → drop lines + emit ONE P1 `LOG FLOOD from <peer>` event per window. A flood becomes an alert, not a crash.
- Optional `data/ingest-rules.json` (peer allowlist, prefix drops) — default open (LAN-only anyway).
- ~30 lines of code. Done before Phase 1 so a collector bug can't flood the pipeline mid-deploy.

## Phase 3 — Hygiene, batched into the Phase 1 recreate
- compose: add `./data/held.jsonl:/app/held.jsonl` (ledger persistence fix)
- compaction threshold 50MB → 10MB (right-sized for post-Phase-1 volume)
- processed/ retention — DONE today in daily-trim (3d age cap)

## Phase 4 — Pipeline self-observability
- **ticker failure alerting**: consecutive triage/loki-tail FAILED → Telegram alert via notify.mjs. Today failures are silent — the single biggest operational gap.
- **Daily digest** (~09:00 CT, mirrors your other dailies): ingest lines by peer, pings sent, held count, assess calls + latency, events.jsonl size, disk. Small stats script over the ledger + file sizes.

## Phase 5 — Later, only if pain returns (explicitly NOT now)
- SQLite event store (no compaction coupling, indexed queries) — current JSONL is simple and now bounded; migration risk not worth it yet
- Grafana dashboard for ops-watch stats (vllm-grafana already runs)
- Loki retention 30d → 14d if store growth still annoys

## End state (measurable)
Ingest ~2% of today · events.jsonl ~1MB/day · triage signal-to-noise ~50x · floods self-alert · disk flat · pipeline failures page you.

## Effort / order
Phase 2 (~45m) → Phase 1 (~1h) → Phase 3 (~15m, one recreate) → Phase 4 (~1h). Rollback: file backups + container restart per phase.
