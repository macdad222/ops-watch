# ops-watch — Jev-gated telemetry triage (FortiGate + syslog + apps)

Chris authorized **blocking mode** for this pipeline only (2026-10-20, scoped).
The original `security-fp-filter` advisory-forever rule stays in force everywhere else.

## Decision order (fixed, in triage.mjs)
1. **P0 — deterministic emergency** (honeytoken hit, IOC match): *bypasses Jev entirely*, pings immediately.
2. **P1 — deterministic high** (firewall config change, privilege escalation, auth failures across ≥3 users, volume burst ≥50, critical syslog level): always pings.
3. **P2 — everything else**: Jev `security-triage` gate (blocking, threshold in gates.json) scores "routine background noise".
   - benign ≥ threshold → **HELD** (digest only; written to `held.jsonl` + Jev ledger — never deleted)
   - below threshold / unparsed → ping
   - **Jev down → fail-open: zero Jev-based suppression** — P2 clusters all surface flagged `jevDown`; P0/P1 still ping. (The P3 hum rule is deterministic code, not Jev — it keeps holding obvious background noise even with Jev disabled. Held ≠ deleted: everything is in `held.jsonl` + the Jev ledger.)

Adversarial-text mitigation (Chris's original concern, kept bounded): attacker-crafted log text can at worst steer Jev to *digest instead of ping* — but honeytokens/IOCs/burst thresholds are deterministic and sit **above** Jev, so planted markers can't be talked down. Weekly digest review closes the loop.

## Run
```bash
cd ~/clawd/projects/ops-watch
node demo.mjs                                  # synthetic end-to-end proof
OPSWATCH_BIND=127.0.0.1:15140 node receiver.mjs  # UDP syslog receiver → events.jsonl
node triage.mjs events.jsonl --live            # one triage cycle, pings Telegram
node triage.mjs events.jsonl --digest-only     # produces JSON, no Telegram
```

## Going live (needs Chris/infra)
1. **FortiGate** → Log & Report → Log Settings → Remote Syslog → this host, port 15140 (or run receiver on .110 for 24/7 — recommended; TCC sandbox on the mini needs LAN-bind approval first).
2. **Servers**: rsyslog/syslog-ng forward `*.info` to the receiver (UDP).
3. **Apps**: JSON lines to UDP or drop into events.jsonl.
4. **Honeytokens**: plant the canary strings/accounts from `honeytokens.json` (decoy SSH user on each server, canary DNS record, fake cred in a config file). Edit `honeytokens.json` to match what you planted — a canary that isn't planted can't trip.
5. **Cron**: `*/5 * * * * cd ~/clawd/projects/ops-watch && node triage.mjs events.jsonl --live >> triage.log 2>&1` (on .110 via the existing cron lane if deployed there).

## Files
- `lib.mjs` — normalize (FortiGate KV / RFC3164 / JSON / bare), signature clustering, deterministic severity, egress scrubber
- `triage.mjs` — decision pipeline + Jev gate call
- `receiver.mjs` — UDP syslog listener
- `notify.mjs` — Telegram (Bot API, token runtime-read, never inlined)
- `honeytokens.json` — canary definitions (EDIT to match real plants)
- `held.jsonl` — suppressed-to-digest log (audit trail)

## Egress rule (unchanged)
Log samples sent to api.typesafe.ai are scrubbed (tokens/JWTs/emails/phones) and truncated. Keys, bet content, contact data never leave.
