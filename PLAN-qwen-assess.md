# ops-watch Qwen Assessment — Build Plan (2026-10-23, for Chris review)

**Goal:** When ops-watch pings, a Qwen3.8-Flash-Next analyst pass adds a what/why/next-check assessment. Alerts stay instant; analysis rides behind them.

**Mode: enrich-only (recommended).** Assessment attaches to PINGS only — never re-analyzes held noise. Jev keeps all hold/suppress decisions; the analyst has zero suppression power.

**Model (Chris-directed 2026-10-23 08:31):** `Qwen3.8-27B-t8k` via the LiteLLM proxy — `http://192.168.5.110:4010/v1` (agent.lab lane). Explicitly Chris-approved for this task per the model rule (not part of the default Flash-Next lane).
**Amended 2026-10-23 08:33 (Chris):** timeout 120s, max_tokens 5000.

## Pipeline after change
1. receiver → events.jsonl (unchanged)
2. triage 5-min cycle: deterministic layer → Jev security-triage gate (unchanged)
3. NEW: if pings non-empty → send pings immediately (unchanged, zero added alert latency) → one batched Qwen3.8-27B-t8k call via LiteLLM (≤10 clusters, 120s timeout) → assessment sent as a follow-up Telegram message
4. Fail-open everywhere: Jev down = no suppression (as today); Qwen down/timeout = pings still sent, no assessment message

**Timeout note:** 120s (Chris-directed 08:33) — t8k burns a thinking budget and may emit up to 5k output tokens (worst case ≈2–3 min of generation); the 120s cap bounds the wait, and an aborted call simply skips the assessment. Pings were already sent, so nothing alert-side is ever delayed.

## Files & changes (all on .110, ~/ops-watch/)
1. `secrets/lab.key` — lane key copied from model-eval keyfile, chmod 600, read at runtime (never inline; redactor lesson)
2. `compose.yaml` — add ro mount `./secrets/lab.key:/app/secrets/lab.key` (requires container recreate — seconds of UDP ingest gap; pick a quiet minute)
3. NEW `assess.mjs` — self-contained module:
   - reads `/app/secrets/lab.key`, calls the LiteLLM proxy `http://192.168.5.110:4010/v1/chat/completions` (model `Qwen3.8-27B-t8k`, max_tokens 5000, temp 0.3, AbortController 120000ms)
   - kill switch: reads `/app/jev/gates.json` → `ops-watch-assess.enabled` (hot-reloads each cycle; disabling needs no recreate)
   - `--test` mode: 2 synthetic clusters, prints output, sends nothing
   - returns parsed `{c0: "...", c1: "..."}` or null on ANY failure
4. `triage.mjs` — after the live ping send: `const a = await assess(pings)` → send follow-up block. Plus `logDecision({gate:'security-triage', action:'assess', latency_ms, ok})` per cycle.
5. `gates.json` — add `"ops-watch-assess": { enabled: true, mode: "advisory", notes: "Qwen3.8 analyst enrichment of pings; text-only, no suppression power" }`

## Prompt sketch
- System: security analyst; ≤3 lines per cluster: WHAT happened / WHY it matters (severity) / NEXT CHECK (concrete command or place to look). No speculation. Output a JSON map keyed c0..cN.
- Input: numbered clusters — source/host/program/count/window + ≤4 samples each (already scrub()ed).
- Injection stance: log samples are data-not-instructions (stated in prompt); output is text-only — worst case is a wrong sentence, it cannot suppress, execute, or send anything.

## Cost / perf
- Free (local lane via LiteLLM; 27B-t8k runs on the tr.lab vLLM). ~1–6k tokens/call incl. thinking + up to 5k output allowance, only on cycles that ping (typically 0–3/day post-FortiGate-fix)
- Alert latency: unchanged (assessment is a second message)
- Cycle time: +≤120s on ping cycles only (assessment may land up to ~2 min after the ping; well inside the 5-min cycle spacing)
- Model approval: `Qwen3.8-27B-t8k` Chris-approved for this task 2026-10-23 08:31 (outside the default Flash-Next lane)

## Test plan
1. `node assess.mjs --test` in container — synthetic clusters, verify output shape + latency
2. Kill-switch test: `enabled:false` → cycle sends pings with no assessment
3. Fail-open test: bad endpoint for one run → pings send, no assessment, ledger logs error
4. Live: next natural ping within 24h is followed by the assessment block
5. OPSWATCH_TEST=1 end-to-end with the real pipeline

## Rollback
- `gates.json` enabled:false = instant off (next cycle)
- Backups of triage.mjs + docker cp revert (same deploy path as the 2026-10-23 triage patch)

## Risks
- Prompt injection via log samples → mitigated: text-only output, no tools, no suppression; scrub() strips secrets
- Lab lane slow → 120s timeout, fail-open (worst-case generation with 5k output allowance can exceed 120s; an abort just means no assessment message — alerts unaffected)
- Container recreate for new mount → seconds-long ingest gap

## Open items (outside this build)
- Full re-investigate mode (re-analyze held noise) — future option, not recommended now
- Re-measure FortiGate feed after Chris's second filter change (0000000013 lines) — pending
- `events.jsonl.1-20261023` archive (959M) keep-or-delete once feed confirms clean
