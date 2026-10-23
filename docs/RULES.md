# RULES — authoring guide + the security contract

*The judgment layer behind this contract — what Jev is, its eight principles, the full call flow, thresholds, ledger, and calibration — is documented in [JEV.md](JEV.md).*

## The contract (Chris, 2026-10-20 — scoped authorization)

The `security-triage` gate runs **BLOCKING**: Jev may move noise clusters to the digest instead of pinging. This was authorized for **this pipeline only**. The original rule — "`security-fp-filter` is advisory PERMANENTLY; never let Jev suppress a security finding" — still governs every other context, and is recorded in `skills/jev-habits/SKILL.md` ground rule #6 as a scoped exception.

What makes blocking safe here (all enforced in code, none optional):

1. **A deterministic layer sits ABOVE Jev.** Honeytokens, IOCs, firewall config changes, auth bursts, volume bursts, critical levels — these ping *regardless of Jev's verdict*. Jev cannot suppress anything the deterministic layer flagged.
2. **Suppression = held, never deleted.** Every held cluster lands in `held.jsonl` AND the Jev ledger with its why. Nothing is unrecoverable.
3. **Fail-open.** Jev down → zero Jev suppression; everything surfaces (flagged `jevDown`).
4. **Repeat suppression is time-boxed (4h) and level-limited (P1 only).** P0s always re-ping.
5. **Jev only sees scrubbed, truncated samples** (tokens/emails/phones redacted) — adversarial text can at worst steer a *ping-vs-digest* call, and the deterministic layer + weekly digest review bounds that.

If Chris ever revokes the scoped authorization: flip `security-triage.mode` back to `advisory` in gates.json — triage then holds nothing via Jev (all P2 → digest flagged), deterministic layers unchanged.

## rules.json — app-specific P1 rules

**Live catalog (2026-10-22 — 17 rules: 13 ops + 4 security):**

| Rule | Match | Fires when |
|---|---|---|
| `postgres-fatal` | job db/postgres + FATAL/PANIC | ≥1 fatal DB error |
| `litellm-error-burst` | job litellm-linux-test/agentic-gateway + errors | ≥5 errors/window |
| `vllm-engine-down` | vllm job + engine failure patterns | ≥1 |
| `cloudflared-tunnel-down` | cloudflared + tunnel errors | ≥2 |
| `kernel-oom` | job kernel\|syslog + OOM strings | ≥1 |
| `detected-error-burst` | any job, error level | ≥5/window |
| `detected-fatal-level` | any job, fatal level | ≥1 |
| `omlx-lane-failure` | omlx-serve + 500/model-load patterns | ≥2 |
| `voice-lane-failure` | voice-bridge/voice-v3 + errors | ≥3 |
| `gateway-failure` | openclaw-gateway + errors | ≥3 |
| `watchdog-silence` | watchdog job + silence/failure | ≥1 |
| `sonos-watchdog` | sonos job + errors | ≥2 |
| `homebridge-failure` | homebridge + ERROR/FATAL/EADDRINUSE | ≥2 |
| **`fortigate-admin-auth-fail`** | job fortigate + "Admin login failed"/ssl-login-fail/admin_lockout | **≥3/window (brute-force signature — would have caught Oct 21)** |
| **`fortigate-botnet-c2`** | job fortigate + Botnet C&C patterns | ≥10/window (needs FortiGate UTM logging enabled — unverified) |
| **`ssh-bruteforce`** | job syslog + Failed password/Invalid user/auth failure | ≥10/window |
| **`honeytoken-trigger`** | any job + HONEYTOKEN string | ≥1 — P0-adjacent, armed, plants pending Phase 3 |

Semantics below; full rule bodies live in `rules.json` (repo + `ops-watch:/app/rules.json` — triage re-reads it **every 300s cycle**, so `docker cp` a new rules.json for live reload, no restart).

```json
{
  "name": "postgres-fatal",              // unique id, appears in the ping
  "match": {                             // ALL specified keys must match (regex, case-insensitive)
    "job": ".*(db|postgres).*",          // Loki job / event program
    "detected_level": "fatal",           // promtail severity label
    "host": "agent-server"               // Loki host label (agent-server|tr-server|vllm-tr|…)
  },
  "patterns": ["FATAL", "PANIC"],        // ANY-of regex against cluster samples; [] = level/count alone
  "minCount": 1,                         // cluster.count >= minCount required
  "level": "P1",                         // P1 recommended; P0 reserved for honeytokens
  "why": "database fatal error"          // shown in the Telegram ping
}
```

Evaluation order per cluster: honeytokens → rules.json (top to bottom, first match wins) → hum → generic deterministic. **Add new app rules here, not in lib.mjs.** Good candidates: nginx 5xx burst on admin-portal, sovereign-chat neo4j down, langfuse worker queue backlog, voice-bridge error bursts.

Match fields available: `job` (Loki job = container name), `detected_level` (promtail's classification: debug|info|warning|error|fatal), `host` (Loki host label), `source` (`loki`/`fortigate`/`syslog`/`app`), `program` (syslog tag).

## honeytokens.json — canary definitions

```json
{
  "strings": ["XJ7-CANARY-CRED-2026"],   // exact strings planted in config files/decoy creds
  "users":   ["svc-backup-adm"],         // decoy accounts — ANY log mention trips P0
  "domains": ["cmaclab-canary.internal"],// canary DNS names — any lookup trips P0
  "iocs":    []                          // known-bad IPs/domains/hashes
}
```

**A canary that isn't planted can't trip.** After planting, update this file to match exactly, redeploy, and run the demo (`node demo.mjs`) to verify the P0 path fires. Keep the plant list and this file in sync — document plants in the private runbook, never in git.

## gates.json — `security-triage` entry

```json
"security-triage": {
  "enabled": true,
  "threshold": 0.60,     // noul P(routine); Jev calibration: benign logs score 0.6-0.8
  "mode": "blocking",
  "notes": "…"
}
```

Threshold discipline: thresholds live HERE, never hardcoded in scripts. 0.60 chosen per Jev's own calibration guidance (benign ≈ 0.6–0.8 on noul); raising it back toward 0.75 makes Jev ping more (conservative), lowering below 0.55 risks digesting novel events — don't go below 0.55 without a week of digest evidence.

## Jev call shape (for reference)

Per P2 cluster, one `noul` question `c{i}`: *"Cluster is ROUTINE recurring background noise — a repeated known-good pattern (…) It is NOT novel, NOT a config or policy change, NOT a spike in failure rate, NOT security-relevant."* Answer ≥ threshold → held; < threshold or unparsed → ping; API error → fail-open. Every call lands in the Jev ledger (`gate: security-triage`, actions: `triage`, `hold-noise`, `hold-hum`, `deterministic-layer`, `fail-open`) — that ledger is the calibration dataset for the weekly digest.
