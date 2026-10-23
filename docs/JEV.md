# JEV — TypeSafe System One

*The novel technology underneath ops-watch's judgment layer. This doc covers what Jev is, **why the system is nearly impossible without it**, the principles it runs on, and exactly how ops-watch uses it. Plain-English first, technical detail after.*

---

## 1. What Jev is (and what it is not)

**Jev** (short for "judgment evaluation") is a **fast, cheap, typed-decision model** — think of it as a hyper-specialized judge rather than a general-purpose AI:

- **One call ≈ 300 ms, ≈ $0.00002** (a hundredth of a cent). It makes ONE decision per call: it does not write essays, reason at length, or do math.
- Three output types: **noul** ("is this novel or routine?"), **choice** (pick from options), **score** (rate something 0–1).
- It is **NOT a writer, NOT a reasoner, NOT a calculator.** It answers one well-formed question about one piece of text. That narrowness is the feature.

**The name says the design philosophy.** Psychologists describe two modes of thinking: *System 1* — fast, instinctive, cheap, sometimes wrong — and *System 2* — slow, deliberate, expensive, reliable. Jev is a **System 1** for software: instant pattern-level judgment at negligible cost. "TypeSafe" is the engineering answer to System 1's weakness: **you don't let fast judgment do dangerous things.** You wrap it in types (structured verdicts, not free text), guardrails (deterministic checks outrank it), and a paper trail (every decision is logged). Fast instinct, safety-critical wiring.

---

## 2. Why ops-watch only works because of Jev

This is the most important section in the docs. Read it even if you read nothing else.

### 2.1 The three-way bind

Every log-monitoring system ever built runs into the same wall. You have a stream of events. Some are dangerous, most are noise. To turn the stream into something a human can act on, you must classify every event — and you only get to pick two of these three:

1. **Complete coverage** — every event gets classified, nothing is skipped or sampled.
2. **Low noise** — the human only hears about the events that matter.
3. **Cheap and fast** — the classification costs pennies and finishes in seconds.

Without a judgment layer you can have any two, never all three:

- **Coverage + low noise** = a human reads everything. Complete and quiet, but it costs hours per day — forever.
- **Coverage + cheap** = code-only rules ping on every match. Cheap and complete, but the phone never stops buzzing, so the human starts ignoring it.
- **Low noise + cheap** = strict rules and hard thresholds. Quiet and cheap, but blind — anything you didn't anticipate gets silently filed away. Including attacks.

This is why enterprise security monitoring is a whole industry: companies pay full-time analysts (option 1) or buy SIEM platforms that flood analysts with false positives (option 2). Both are answers to the same bind. **Jev is how a one-person system escapes it.**

### 2.2 The size of the problem, measured

These are live numbers from this house's own ledger (Oct 20 – Oct 23, 2026):

- **~130,000 to 360,000 raw log events per day** flow into ops-watch (firewall, servers, Docker apps, Mac services).
- After clustering and the deterministic layers, **~28,000 ambiguous clusters per day** land in the P2 band — events that are *neither clearly an attack nor clearly routine*. This is the band where novel attacks live.
- The deterministic code layer alone already fires **~380 pings per day** (840 in the measured window) on things it *can* classify: honeytokens, IOCs, config changes, auth bursts, volume bursts.
- In one measured flood cycle, a single 5-minute window produced **5,633 ambiguous clusters at once**.

Now the counterfactual math — what each alternative costs to classify those ~28,000 clusters *per day*:

| Approach | Cost per day | Latency | Result |
|---|---|---|---|
| **Human reads them** (even 5 sec each) | **~39 hours of labor** | hours | Nobody has 39 hours. The band goes unread. |
| **Frontier LLM** (GPT-class, ~$1–10/M tokens, ~300–500 tokens/verdict) | **$14–140/day** ($420–4,200/mo) | 2–10 sec per call — doesn't fit a 5-min cycle at this volume | Works, sort of. Costs as much as a salary, still slow at volume. |
| **Jev** (measured: 27,781 verdicts in the window) | **~$0.25/day** | 300 ms per batch | Complete coverage of the band, inside the cycle, effectively free. |

**That last row is the whole argument.** Jev's price point is what makes *exhaustive* classification possible. Any classifier that costs more per verdict forces you to start sampling — and sampling is how the one weird cluster that matters gets skipped.

### 2.3 Every alternative, autopsied

Each of these has already been tried — by the industry, and by this house before Jev was wired in. Real incidents cited from this system's own history:

**a) Ping everything (no suppression).** This is what ops-watch looked like before the judgment layer, in miniature: on Oct 22 the SD-WAN watcher forwarded *raw syslog lines* as CRITICAL alerts — Chris got a 200-character wall of `FIND_BEST_PATH member 1 flapped 19x` gibberish on his phone. Multiply that failure by 28,000 ambiguous clusters a day and you get the alert-fatigue death spiral: the human mutes the bot, and then the system is worse than no system, because it *feels* monitored.

**b) Rules only (no judgment).** The Oct 21 FortiGate brute-force attack — 65 attempts from 8 IPs in minutes — was caught by *manually* querying Loki, because at that moment the rule catalog had **zero security rules**. Rules can only catch what you predicted in advance. Novel attacks are novel precisely because nobody wrote their rule yet. The deterministic layer is essential, but it has a hard ceiling: it classifies the *known*-bad and the *known*-boring, and by definition it cannot classify the middle.

**c) Fixed thresholds (no semantics).** A threshold is a guess frozen in time. The same SD-WAN link flapped *because* its health check sat at a 50 ms latency threshold — in/out every 15–35 seconds, 173 times a day, while the link itself was physically fine. Log volume drifts, apps change their logging, health checks hover at the edge. Threshold-only alerting either rots into noise or gets tightened into blindness. And it can't tell a *new backup job* from a *new exfil pattern* — both are "new log signature."

**d) Classic statistical anomaly detection.** The textbook answer — flag statistical outliers — fails on logs for one reason: it has no semantics. It knows event *rates*, not *meanings*. It cannot answer "is this routine?" because routine-ness is a judgment about what the text *means* in context, not a z-score. It also can't explain itself, so every alert it does fire needs a human to re-do the classification anyway.

**e) Human SOC.** Option 1 in the bind. 39 hours/day at 5 seconds per cluster — and that's *skimming*. Fully impossible for one person, prohibitively expensive for a company. This is the option enterprises choose, which is why enterprises have SOC teams.

### 2.4 Why a *tiny typed model* is the only tool that closes the band

"It's AI" is not the argument — a big model fails differently. The specific design points are what make Jev close the three-way bind:

1. **$0.00002 per verdict → exhaustive coverage.** You can afford to ask about *every* ambiguous cluster, every cycle. No sampling, no skimming. This is the property that breaks the bind.
2. **300 ms per call → fits the pipeline.** A full batch of up to 150 cluster verdicts completes inside a 5-minute triage cycle with room to spare. A frontier model's latency doesn't.
3. **Typed output → machine-checkable.** Jev returns a number (noul 0–1), not an essay. Code compares it to a threshold. There is no "the model said maybe" parsing problem, and no rambling.
4. **One narrow question → bounded blast radius.** Jev never sees the whole picture; it sees scrubbed, truncated samples of one cluster and one question. Adversarial text planted in a log line can at worst flip *its own cluster* from held to pinged (or vice versa) — and the deterministic layer plus weekly digest review bounds even that. The safe failure is a ping: silence requires an explicit, confident "yes, routine" above threshold.
5. **A pipeline seat, not a throne.** Jev is one component among five layers (§4). Code above it decides what it never sees; a ledger below it records everything it said. The system was designed so the AI *cannot* be a single point of failure — which is exactly why it's safe to lean on it for the 28,000-cluster band.

### 2.5 Proof from the live ledger

The argument above isn't a design sketch — it's measured. From the Jev ledger, Oct 20 22:52 UTC → Oct 23 03:25 UTC (636 triage cycles):

- **62,287 ambiguous clusters** reached the judgment band (~28,000/day).
- Jev scored **27,781 verdicts** across 441 batch calls (caps in §4 held the rest back conservatively).
- **17,822 clusters were confirmed routine and held** (64%) — that's 17,822 potential pings Chris never got, each one logged with its score and available in the digest.
- The score distribution validates the 0.60 threshold: min 0.60, average 0.74, max 0.98 — healthy content clusters in the 0.60–0.80 band exactly as the calibration predicted (0.60–0.70: 5,571 · 0.70–0.80: 6,849 · 0.80–0.90: 4,812 · 0.90+: 590).
- **Jev was down or errored on 56 of 636 cycles (8.8%) — and on every one of those cycles, suppression was fully disabled.** Nothing was hidden, every cycle was flagged `fail-open` in the ledger. The failure mode behaved exactly as designed: the system got *more* transparent when its judge went quiet, never less.

**Without Jev, every one of those 17,822 held clusters is either a ping (option a's death spiral) or an unread digest line (option b's blindness). There is no third option — that's the bind. Jev is the third option.**

### 2.6 The same argument everywhere else

Ops-watch is the biggest consumer of Jev, not the only one. The identical impossible-band problem shows up all over an agent stack, and the same economics solve it each time:

- A subagent says "done" — is the report actually backed by evidence, or inflated? (Checking every report by hand doesn't scale; sampling lets hallucinations through.)
- Inbound text (email, PDF, web) — does it contain instructions trying to steer the agent? You can't read every word of everything; you also can't act on injected instructions.
- A draft about to leave the machine — does it contain private data? Every send, every time, or the one you skip is the leak.
- A code diff from a worker — destructive ops, secrets, config changes?

In each case: exhaustive checking must be cheap (it is: $0.00002), the question must be narrow (it is: one typed verdict per call), and the failure mode must be safe (it is: fail-open, ledgered, advisory by default). The gate catalog in §5 is this same pattern applied a dozen times.

---

## 3. The eight principles (non-negotiable, enforced in code)

These are the ground rules from `skills/jev-habits/SKILL.md`. They are not guidelines — the ops-watch code enforces them structurally.

1. **Judgment informs; it never replaces.** A Jev verdict is an input to a decision, never the decision-maker on anything critical. Chris's approval and deterministic checks always outrank it.
2. **Fail-open, always.** If Jev is unreachable or errors, the system continues as if the gate didn't exist — and says so. In ops-watch terms: **a missing filter must never become a missing alert.** Jev down → zero suppression, everything surfaces flagged `jevDown`. Measured live: 56 of 636 cycles ran fail-open, all flagged (§2.5).
3. **Deterministic code sits ABOVE the AI.** Honeytokens, IOCs, firewall config changes, auth bursts across ≥3 users, volume bursts, critical levels — these are plain code checks that ping *regardless of what Jev says*. Jev never sees a chance to suppress something the deterministic layer flagged.
4. **Suppression means "held," never "deleted."** Anything Jev files away lands in `held.jsonl` **and** the Jev ledger with its reasoning. Recoverable, searchable, reviewable. The system has no delete path for security data.
5. **Every decision is written down.** Every single Jev call appends a row to the ledger (`projects/jev/decisions.log` on the mini, mirrored container-side in ops-watch) — gate name, action, verdict, model version, timestamp. This is what makes calibration possible: you can measure a gate's behavior, not just trust it.
6. **Only Chris moves a gate from advisory to blocking.** Advisory = the verdict informs a human. Blocking = the verdict decides an action autonomously. That promotion is a policy decision, permanently reserved. (`security-fp-filter` is advisory **forever** — Jev is steerable by adversarial text, and a planted backdoor is adversarial text.)
7. **Jev is a literal reader and bad at numbers.** Arithmetic, ID matching, date logic, counting — all in code. Jev only does semantic questions ("is this log cluster routine?"). This is why ops-watch computes counts, thresholds, and clustering deterministically and only hands Jev the final "novel or routine" call.
8. **Egress discipline.** Every Jev call sends text to a third party (`api.typesafe.ai`). ops-watch scrubs before sending: API keys, tokens, emails, phone numbers redacted; samples truncated to 3 × 160 chars. Keys, bet content, and contact data never leave the house.

---

## 4. How ops-watch uses Jev — the full flow

Here's the exact journey of one log cluster through the judgment layer (per 5-minute triage cycle):

```
events.jsonl (new events — ~130k–360k/day)
   │
   ▼
cluster by signature (deterministic code)
   │
   ├─ honeytoken/IOC match? ──────────────► P0 ping (Jev never consulted)
   ├─ rules.json match? ──────────────────► P1 ping (Jev never consulted)
   ├─ hum patterns (health checks, debug,
   │  info floods ≥15, repeats ≥8)? ──────► P3 held (Jev never consulted)
   ├─ generic deterministic (config change,
   │  sudo/su, auth-burst ≥3 users, volume
   │  burst ≥50, critical level)? ────────► P1 ping (Jev never consulted)
   │
   ▼  — only the leftovers reach Jev —
P2 pool (weird-but-not-obviously-bad clusters, ~28k/day, avg ~98/cycle)
   │
   ▼
ONE Jev batch call per cycle (up to 150 clusters scored in a single call):
   per cluster, question type 'noul', worded essentially:
   "Cluster is ROUTINE recurring background noise — a repeated
    known-good pattern (...). It is NOT novel, NOT a config or
    policy change, NOT a spike in failure rate, NOT
    security-relevant." + scrubbed samples (3 × 160 chars max)
   │
   ├─ score ≥ 0.60  → ROUTINE → held to digest (held.jsonl + ledger)
   ├─ score < 0.60  → NOVEL   → Telegram ping
   ├─ unparsed      → NOVEL   → ping (fail-closed for ambiguity)
   └─ API error     → FAIL-OPEN → nothing suppressed this cycle,
                                  everything surfaces flagged jevDown
   │
   ▼
every call → ledger row (gate=security-triage, action, verdict, jev_model)
   │
   ▼
weekly calibration digest (Sundays 20:00 CT) reviews the ledger
   → threshold adjustments proposed, never auto-applied
```

**The caps — how a flood day can't become a flood of calls or a flood of pings:**

- Jev scores at most **150 clusters per cycle**; beyond that, clusters are held *unscored* to the digest (overflow). Measured worst case: 5,633 clusters in one cycle during the Oct 21 backlog flood — 150 scored, 5,483+ safely held.
- Only the **first 20 clusters per cycle** can be suppressed by Jev's score alone; everything past that is held regardless of score — a belt-and-suspenders cap so a single hot cycle can never file away more than a bounded amount.
- Pings are capped at **10 per Telegram message** per cycle, and repeat suppression time-boxes re-pings of the same signature (4h, P1 only; P0s always re-ping).

**Notice the shape:** Jev only ever answers *one question* — "routine or novel?" — about clusters that four deterministic layers already declined to classify. The AI gets the narrow, low-risk band.

**The question is deliberately worded so the safe failure is a ping.** If the phrasing confuses the model, if the log text is unusual, if the answer comes back unparsable — the cluster pings. Silence requires an explicit, confident "yes, routine" above threshold.

---

## 5. The gate catalog (all Jev gates, ops-watch highlighted)

Jev is a family of gates — same engine, same economics, different questions (see §2.6 for why the family exists). All live in `~/clawd/projects/jev/`:

| Gate | When it runs | Verdict | Mode |
|---|---|---|---|
| **`security-triage`** | ops-watch triage, per P2 cluster | hold vs ping | **BLOCKING** (scoped, see §6) |
| `security-fp-filter` | security findings elsewhere | inform only | **advisory — permanently** |
| `handoff-qc` | before spawning a subagent / cron prompt | brief quality ok/rewrite | advisory |
| `subagent-check` | when a subagent reports "done" | PASS / REVIEW / **INFLATED** | advisory (+exit codes) |
| `inbound` | before acting on foreign text (email/PDF/web) | ok / **QUARANTINE** | advisory |
| `diffguard` | before applying subagent/Jarvis code changes | ok / FLAGGED (destructive/secrets/config) | advisory |
| `presend` | before sending a draft to anyone | ok / blocked (private data, half-baked) | advisory |
| `ping` (`reach-gate`) | before a proactive reach-out to Chris | ping[] vs held[] | advisory |
| `router` | before big/uncertain tasks | lane choice / ask Chris | advisory |
| `pagefocus` / `browse` | browser automation (snapshots, loops, scrape completeness) | focus refs / states / progress | advisory |
| `memory-score` / `supersede` / `promotion` | memory writes | annotate / supersede / promote | advisory |
| `retrieval-trim` | when search returns too many hits | keep[] | advisory |
| `compaction-check` | after context compaction (dry-run only — NOT wired into live compaction; a 2026-09-28 dry-run showed it can drop needed segments) | OK / LOSSY | advisory |

The complete trigger→command table with examples lives in `skills/jev-habits/SKILL.md`.

---

## 6. The safety contract for the one BLOCKING gate

`security-triage` is the only gate in the whole system allowed to *act* without a human in the loop (it files noise instead of pinging). Chris authorized this for ops-watch only, on 2026-10-20, and re-scoped it as **BLOCKING** the same day. What makes that safe — every item enforced in code, none optional:

1. Four deterministic layers sit **above** Jev and always ping regardless of its verdict (§3 principle 3).
2. Suppression = held in `held.jsonl` **and** the ledger — never deleted (principle 4).
3. Fail-open on any Jev error — zero suppression (principle 2; measured live in §2.5).
4. Repeat suppression is time-boxed (4h) and level-limited (P1 only); P0s always re-ping.
5. Jev only sees scrubbed, truncated samples (principle 8) — adversarial log text can at worst flip a ping-vs-digest call on its own cluster, and the deterministic layer plus the weekly digest review bounds that.
6. The batch caps (§4) bound how much can be suppressed per cycle even in a flood.

**To revoke:** flip `security-triage.mode` back to `advisory` in `gates.json` — triage then holds nothing via Jev (all P2 → digest flagged); deterministic layers unchanged. Only Chris makes this change.

---

## 7. Thresholds and calibration

- **Thresholds live in `gates.json`** (`security-triage.threshold` = **0.60** for ops-watch). Never hardcode thresholds in scripts.
- **Why 0.60:** Jev's own calibration says healthy, benign content scores **0.6–0.8** on the noul scale — not 0.9+. The live ledger confirms it: 17,822 held verdicts average **0.74**, with the mass in the 0.60–0.80 band (§2.5). A threshold of 0.60 accepts genuinely-routine content while anything unusual scores lower and pings. Earlier the gate ran at 0.75 (ping-happy); a week of ledger evidence moved it to 0.60.
- **The discipline:** lowering below 0.55 risks digesting *novel* events (bad — that's how a real attack gets filed as noise). Raising toward 0.75+ makes it ping more (safe but noisy). Changes happen only with digest evidence in hand, and Chris makes the call.
- **The weekly digest** (`jev-digest.mjs --days 7`, cron Sundays 20:00 CT) reads the week's ledger and reports: hold rates, flag rates, version consistency. It's the feedback loop that keeps the judgment layer honest — and it's the same ledger data that produced every number in §2.
- **Version pinning:** `model-pin.txt` pins the Jev model (`jev-1.13.0`); every ledger row carries `jev_model`. If the digest shows multiple versions or `pin_fallback`, thresholds may have drifted — compare flag rates before changing anything.
- **Regression testing:** `node selftest.mjs` runs 36 fixed cases (~$0.01) — run it after touching any gate. ops-watch's own `node demo.mjs` (71 synthetic events → 4 pings / 2 held, labeled SYNTHETIC-TEST) proves the full path including the P0 canary and fail-open behavior.

---

## 8. The ledger (why you can trust the noise reduction)

Every Jev decision appends a row like:

```
2026-10-22T19:20:32-05:00 | gate=security-triage action=hold-noise score=0.71 jev_model=jev-1.13.0 sig=<cluster-sig>
```

- Query it: `grep security-triage ~/ops-watch/data/jev-decisions.log | tail -20` (container copy) or the canonical ledger on the mini.
- **Hold ≠ lost:** every held cluster is also in `held.jsonl` with samples and the verdict. The daily/weekly digest reads both.
- **It doubles as the calibration dataset** — and as the evidence base for this doc. Every number in §2 was computed from it. The ledger is *the* proof that the judgment layer behaves as designed; the alternative is vibes, and vibes is how alerting systems rot.

---

## 9. Operations quick reference

| Task | Command |
|---|---|
| Kill ALL Jev (every gate) | `JEV_DISABLE=1` on the process/container |
| Kill one gate | `enabled: false` for that gate in `gates.json` |
| Change a threshold | edit `gates.json` (mini) **and** `~/ops-watch/config/gates.json` (.110, mounted ro → recreate container) — then `node selftest.mjs` |
| Weekly health | `cd ~/clawd/projects/jev && node jev-digest.mjs --days 7` (cron does it Sundays 20:00 CT) |
| Regression check | `node selftest.mjs` (36 cases) |
| See recent ops-watch verdicts | `grep security-triage ~/ops-watch/data/jev-decisions.log \| tail` |
| See what was held | `tail -20 ~/ops-watch/data/held.jsonl` |

**Gotcha:** the Jev API key is read from `projects/jev/ts-lane-id.txt` at runtime by the scripts — never inline it in a command (the exec redactor corrupts key literals; see RUNBOOK gotcha 14's cousin lesson).

---

## 10. The short versions

**One paragraph for a newcomer:**

> Jev is a tiny, fast AI judge that answers one narrow question at a time — "is this routine or new?" — for two hundredths of a cent. The system is built so that the AI can never be the only thing standing between you and a problem: plain code checks catch everything known-bad and known-boring first, the AI only sees the genuinely ambiguous middle, its mistakes are recoverable (nothing is ever deleted, only filed), it logs every decision it makes so its behavior can be measured and tuned weekly, and if it's ever down, the system gets louder, not quieter.

**The elevator argument (why this only works because of Jev):**

> Roughly 28,000 ambiguous log clusters a day land in the band where novel attacks live — too weird for rules, too numerous for a human, too expensive and slow for a frontier model, and invisible to statistics. Ping them all and the phone gets muted; file them all and the next Oct 21 runs unnoticed. A tiny typed model at $0.00002 and 300 ms per verdict is the only price point at which you can classify *every* one of them — exhaustively, inside the cycle, safely wrapped in deterministic guardrails and a complete ledger. Take Jev out and the system must choose between alert fatigue and blindness. That choice is the whole reason monitoring systems fail; Jev is why this one doesn't.
