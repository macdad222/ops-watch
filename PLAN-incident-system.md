# ops-watch: Trustworthy Incident Intelligence Plan

**Date:** 2026-10-23 (audit completed ~22:25 CDT)  
**Status:** proposal for Chris review; no implementation or deployment authorized by this document  
**Scope:** `projects/ops-watch/`, its documented ingestion/feedback boundaries, deployed container health, and selected live ledgers on `.110`  
**Recommended outcome:** evolve ops-watch from a log-to-card classifier into a reliable, measurable incident system without replacing Loki, Jev, the local model lane, Telegram, or the existing feedback flow

---

## 1. Executive recommendation

The dramatic enhancement is **not another model or a dashboard**.

Build this, in order:

1. **A trustworthy event and delivery pipeline.** Every accepted event has a durable, queryable outcome. Backlogs, floods, malformed output, service failures, and restarts produce visible state rather than silent gaps.
2. **An incident engine.** Related observations become one persistent incident with a lifecycle: open, acknowledged, escalated, recovered, and resolved. Stop representing every five-minute log batch as a new problem.
3. **Evidence-backed investigation.** For a small allowlisted set of services, gather read-only health and log evidence before explaining the incident. Separate observations, assessment, and unknowns. Never let a model run arbitrary commands.
4. **Measured learning.** Attach feedback to the exact incident and decision, measure useful-alert rate and missed-event fixtures, and promote model changes only after replay and shadow evaluation. Do not train an ML filter merely because 300 rows exist.

The user-facing result should be:

> **What is affected, why this matters now, what evidence supports it, what should happen next, and whether the alert actually reached anyone.**

Keep Loki as the high-fidelity log archive. Keep deterministic P0/P1 policy above AI. Keep Jev for ambiguous classification until a replacement earns promotion. Keep Qwen for explanation, not as an unaccountable second decision-maker. Keep Telegram and the existing Jarvon feedback route.

### What not to build yet

- No Datadog-sized rewrite or new microservice fleet.
- No dashboard before incident state and evidence are trustworthy. A CLI plus existing Grafana/Loki is enough initially.
- No ML auto-suppression with the present feedback set.
- No arbitrary AI-generated shell commands, firewall changes, container restarts, or automated remediation.
- No cloud-model dependency or additional paid API lane.
- No Telegram polling/webhook against the shared bot token.

---

## 2. Audit baseline and evidence quality

### Reviewed

- All first-party runtime JavaScript, Python shippers, shell scripts, rules/configuration, Docker/deployment files, documentation, examples/training scripts, and tests in `projects/ops-watch/`.
- Existing proposals: `PLAN-efficiency.md`, `PLAN-qwen-assess.md`, `PLAN-v1.md`, `DEPLOY-PLAN.md`, and `docs/v2-design.md`.
- Current working-tree diff and repository history for this project.
- Running container/process state, selected state files, log tails, queue/label/ping aggregates, and deployed file hashes on `.110`.
- Existing decisions in memory, including the efficiency-plan approval gate and ops-watch feedback protocol.

The external FortiGate collector is a dependency, not part of this repository; its full implementation was not re-audited here. Its edge-routing change must therefore have its own fixture/replay review before deployment.

### Important version distinction

- The running image reports revision `17ea0a25411ed0d0c22ab3dc0e779c058403db14`.
- The local working tree contains uncommitted v3.1 work in `triage.mjs`, `cards.mjs`, `digest.mjs`, `label.mjs`, `gen-card-examples.mjs`, and three test files.
- The deployed `triage.mjs`, `cards.mjs`, and `digest.mjs` hashes differ from the working tree. Findings below identify the common path or the affected version; the audit does not pretend the two are identical.
- This review made no code/configuration/deployment changes and sent no test alerts. It only adds this plan file.

### Verification

- Explicit six-file Node test run: **43 passed, 0 failed, 1 skipped**. The skipped test is the external Jev contract test.
- `git diff --check` on the pre-existing ops-watch changes reported no whitespace errors.
- Live snapshot: container was up with zero restarts and about 16 MiB memory in use, but there is **no Docker healthcheck**. A running container therefore does not prove that collection, triage, or delivery works.
- Live snapshot: `data/` about 3.8 GiB; logs about 85 MiB. At one sampled point, the 41 MiB event file was fully consumed; this is only a point-in-time observation, not a coverage guarantee.
- Live feedback: five non-auto labels, all `useful`. This is not enough to estimate classifier quality or train a useful/noise model.
- Live delivery snapshot: `pings.jsonl` had 26 ping rows and zero digest rows. `digest-queue.jsonl` contained 4,864 rows (1.33 MB): 2,970 routine, 1,046 over-cap, and 848 previously marked Telegram-send-failed. Counts are a snapshot, not a lifetime total.
- Live digest log contains Telegram `400` failures: `Unsupported start tag "info"`. The failed body send leaves the queue pending, explaining why the queue continues to grow.

### Scope limitation

The existing unit tests are useful but mostly mock the network and exercise components independently. Passing tests do not establish production event coverage or end-to-end Telegram delivery. The reproductions below used synthetic events and temporary state directories unless explicitly identified as live inspection.

---

## 3. What is already good and should be retained

1. **The overall boundary is right:** raw telemetry goes to Loki; ops-watch is supposed to be the signal layer.
2. **Deterministic security invariants belong above AI.** Honeytoken/IOC P0 checks scan the cluster's retained raw events (`lib.mjs:234-244`).
3. **The bounded byte-range reader is a good recovery from the 512 MB crash.** It reads complete lines and carries a torn tail forward (`triage.mjs:322-341`).
4. **The card direction is good:** friendly service names, concise lead text, expandable evidence, per-card feedback, and no routine-only live messages.
5. **Feedback ambiguity is handled thoughtfully.** v3.1 card/message mapping avoids guessing which card a reply labels.
6. **P0 is protected from repeat/mute suppression.** Any change to incident aggregation must preserve that policy unless Chris explicitly changes it.
7. **Jev is already isolated behind a typed contract and supports shadow comparison.** Do not throw that away while fixing transport and lifecycle problems.
8. **The efficiency plan has the right instinct:** keep full-fidelity logs in Loki and reduce signal-lane noise. It needs to come after correctness, not before it.
9. **The deployment script now refuses a dirty tree.** Extend that discipline to functional health verification rather than reverting it.

---

## 4. Findings, ranked by consequence

### P0 — restore the integrity promise before adding intelligence

#### F1. Active v1/shadow mode can consume backlog without classifying it

`clusterEvents()` drops events older than the five-minute window in window mode (`lib.mjs:118-150`). `triage.mjs` deliberately uses window clustering for v1/shadow decisions (`triage.mjs:114-124`), then advances the event-file offset after the cycle (`triage.mjs:436-438`).

An isolated fixture containing a 30-minute-old unread fatal error in default window mode produced:

- clusters: `0`
- consumed offset: advanced to the full file length

A mixed fixture containing one recent and one old event classified only the recent event. A second cycle cannot recover the old one because its offset was consumed. Batch mode avoids this particular loss, but active configuration is `shadow` and its decision path defaults to window mode.

**Impact:** outages and backlogs can hide the exact events that monitoring should recover.  
**Required change:** separate *coverage* from *baseline windows*. Every unread event must be deterministically evaluated; the five-minute window is context, not permission to discard the backlog.

#### F2. Loki tailing loses data under ordinary edge cases

`loki-tail.mjs` has several independent problems:

- At over-cap, it keeps the newest 5,000 lines and discards older lines, then advances beyond them (`loki-tail.mjs:124-146`). A synthetic 6,001-line response produced 5,000 appended events, `truncated:false`, and a cursor at the newest source timestamp. The comment claiming capped data is revisited is incorrect.
- Deduplication is `job|line`, not timestamped (`loki-tail.mjs:129-132`). Identical recurring log messages can be suppressed while the content hash remains in the 4,000-entry set.
- A gap greater than two hours is deliberately skipped (`loki-tail.mjs:35-40`) without a durable, user-visible backlog-loss incident.
- Errors are logged as JSON but can exit zero. If some events were appended, a later error is not reflected in process status (`loki-tail.mjs:149-157`).
- State loading and saving are not robust/atomic (`loki-tail.mjs:30,77-80`). Corrupt state can repeatedly break polling; a torn write is not safely recovered.

**Impact:** silent undercounting, missed bursts, and misleading health during floods or outages.  
**Required change:** paginated/per-stream cursors, no content-only dedup, durable drop/backlog counters, nonzero failure status, and atomic state.

#### F3. Some deterministic rules do not match the normalized event shapes they receive

- FortiGate normalization sets `program = type` (`lib.mjs:51-52`), so a system event has `program = "event"`; a rule expecting `job = "auth"` cannot match. The `auth-burst` rule also expects `job = "sshd"`, while RFC3164 normalization produces `program = "sshd"` and no `fields.job` (`lib.mjs:65-82`, `lib.mjs:291-305`).
- FortiGate message extraction uses only `msg || action` (`lib.mjs:56`), discarding useful text such as `logdesc="Admin login failed"` when `msg` is absent.
- App rules inspect only `cluster.samples`, which contain the first three messages (`lib.mjs:146,296`). A matching event later in a large cluster need not be seen. The same limitation affects some generic background/severity checks.
- Background rules can be evaluated before a meaningful pattern in a non-sampled event. P0 honeytoken/IOC raw-event scanning is the important exception; this finding is **not** a claim that the P0 honeytoken scan examines only three samples.

Synthetic FortiGate and SSH auth fixtures returned `rule_match: null` with the current selectors. This is a parser/rule-contract defect, not proof that every production auth event is missed; real sanitized fixtures must become regression tests.

**Impact:** documented deterministic coverage can be narrower than operators believe.  
**Required change:** one canonical event schema, selector aliases with explicit semantics, preservation of security-relevant fields, and per-event safety evaluation before aggregation.

#### F4. Digest and live delivery are not durable end to end

- Digest displays at most 15 items, then rotates the entire queue (`digest.mjs:137-141,205-209`). A 16-item fixture showed 15 and left zero pending afterward. Overflow is only a count, not a retained next-digest backlog.
- A digest body is sent before question cards; failed question sends are only logged and the queue is still rotated (`digest.mjs:180-209`).
- The live digest is currently failing Telegram HTML parsing. `routineSummaryLine()` interpolates the group title without escaping (`cards.mjs:305-307`); other renderers also truncate assembled HTML using `slice()` (`cards.mjs:327,353`), which can split a tag or entity.
- A mocked `{ok:false}` response was treated as delivered by `deliver()`; the production helper normally throws for this case, but the delivery contract itself does not validate a message ID.
- Live sends update in-memory repeat state per card, but the durable ping/card mapping is written after all sends (`triage.mjs:265-295`). A crash after a successful Telegram send can leave a real card with dead buttons and repeat suppression not yet persisted.
- AI failure can turn Jev-only novel items into `no_action` fallback cards. That is not a consistently fail-visible interpretation of “fail-open.”

**Impact:** the alert can exist in code but never become a usable Telegram message or feedback record.  
**Required change:** durable outbox, per-message acknowledgement, safe message construction, and explicit pending/failed/unknown delivery states.

### P1 — make failures observable and the system operable

#### F5. Collection and pipeline failures are mostly log-only

- `ticker.sh` starts the UDP receiver once, outside its loop; a receiver crash is not supervised (`ticker.sh:4-6`).
- `receiver.mjs` has two socket error handlers, one of which exits the process (`receiver.mjs:17-27`). UDP writes are synchronous per line and have no global/peer backpressure or ingest counters.
- There is no functional healthcheck in `compose.yaml`; `restart: always` cannot repair a live but stuck pipeline.
- The existing proposed flood defense drops lines but does not yet specify a bounded peer map, durable per-class drop counters, or a flood signal that bypasses its own dropping path.
- A 64 MiB byte cap does not cap memory after parsing and retaining full event objects in clusters. High-volume floods can still expand far beyond the input buffer.

**Required change:** supervised receiver, functional health state, source freshness, resource limits, bounded aggregation, and measurable shedding with Loki as the archive backstop.

#### F6. State persistence and compaction have avoidable failure modes

- `triage-state.json`, `sig-stats.json`, `mutes.json`, and Loki state use direct writes; reads often turn corruption into empty state. That can reset offsets or lose repeat/mute history.
- `history.mjs` silently ignores save failures (`history.mjs:31-33`). Baselines can be empty without an operator-visible warning.
- Compaction measures file size and then moves the file; a receiver append in between can move unprocessed bytes into an archive (`ticker.sh:16-22`).
- `deploy.sh` touches `config/decisions.log`, but Compose mounts `data/jev-decisions.log`. A fresh deployment can create the wrong type/path for the actual ledger.
- Large JSONL ledgers are repeatedly read in full by digest/label/history tools. Rotation currently focuses on logs/event archives, not all state.

**Required change:** atomic writes during transition, safe compaction, bounded reads, then one durable store for operational state with JSONL compatibility exports.

#### F7. Documentation and runtime authority have drifted

The README still describes older card/Jev behavior; `docs/ARCHITECTURE.md` describes older clustering and delivery; `docs/JEV.md` and `docs/GUIDE.md` promise complete coverage or louder failure in terms stronger than the current implementation demonstrates. Deployed code and working-tree code differ. The Qwen plan still describes a separate follow-up assessment although cards now fold it into rendering.

**Required change:** versioned architecture docs generated from the actual release manifest, explicit “live” versus “proposed” sections, and release acceptance based on behavior rather than container status.

### P2 — improve judgment quality only after the foundation is measurable

#### F8. The system has classifiers, but not a durable concept of an incident

Five-minute clusters, repeat suppression, and friendly card grouping are useful, but they do not answer: Is this the same ongoing outage? Has it spread? Was it acknowledged? Did it recover? Is a stopped log stream recovery or collector failure?

This is the largest product limitation after integrity. It is why better wording alone cannot dramatically improve the system.

#### F9. Feedback is not yet a reliable learning dataset

- Only five non-auto labels exist, all useful. There is no meaningful noise class or evaluation baseline yet.
- Labels join the latest shadow row by signature (`label.mjs:60-66,131-149`), not necessarily the exact decision/cycle that produced the alert.
- Features/model/prompt/card versions are not consistently captured as one immutable decision record.
- Auto-labels can be useful triage hints, but ignored/no-action and model-generated routine judgments are not independent ground truth.
- Planned ML features include Jev probabilities; a future “ML beat Jev” comparison must control for this predictor leakage and use time-held-out human outcomes.
- The planned 300-label gate is a minimum convenience threshold, not evidence of class coverage, recall, calibration, or deployability.

**Required change:** exact-decision feedback, human-only evaluation, meaningful class coverage, and replay/shadow gates.

---

## 5. Target architecture

```text
Loki (full-fidelity archive)          UDP/Mac shippers (best-effort edge)
             \                              /
              \                            /
               +------ ingestion ----------+
               | canonical event schema    |
               | cursors + source health   |
               | bounds + loss counters    |
               +-------------+-------------+
                             |
               +-------------v-------------+
               | deterministic evaluation  |
               | every event, P0/P1 first  |
               +-------------+-------------+
                             |
               +-------------v-------------+
               | signals + features        |
               | Jev for ambiguous band    |
               | pending != routine        |
               +-------------+-------------+
                             |
               +-------------v-------------+
               | incident engine           |
               | entity/condition identity |
               | open/ack/change/recover   |
               +-------------+-------------+
                             |
          +------------------+-------------------+
          |                                      |
+---------v---------+                 +----------v----------+
| durable outbox    |                 | evidence playbooks  |
| retries/backoff   |                 | read-only, typed    |
| per-message ack   |                 | observed vs inferred|
+---------+---------+                 +----------+----------+
          |                                      |
+---------v---------+                 +----------v----------+
| Telegram cards    |<----------------| explanation layer  |
| feedback/actions  |                 | Qwen: words, not   |
| exact decision ID |                 | arbitrary authority|
+-------------------+                 +---------------------+
          |
+---------v-------------------------------+
| SQLite operational state + JSONL export |
| incidents, deliveries, feedback, health |
+-----------------------------------------+
          |
+---------v---------+
| independent       |
| dead-man monitor  |
+-------------------+
```

### Core design decisions

1. **Coverage and notification are separate.** Complete durable accounting does not mean every event pings.
2. **A signal is not an incident.** `source + signature` is useful for grouping events; `entity + condition + scope` is the incident identity.
3. **Pending is not routine.** Unscored, unclassified, AI-unavailable, and over-cap items remain visibly pending. They cannot be silently converted into no-action feedback.
4. **AI explains; policy decides.** P0/P1 severity, quiet-hours policy, muting, retries, and escalation are code/config. Jev remains an explicit ambiguous-band classifier until evaluated otherwise.
5. **Delivery is at-least-once with explicit uncertainty.** Telegram plus a process crash cannot provide magical exactly-once delivery. Store intent before sending, record success immediately, and expose `unknown` after ambiguous timeouts instead of silently pretending either success or failure.
6. **Logs are evidence, not instructions.** No log text, model response, or Telegram label can authorize tools or configuration changes.
7. **Self-monitoring must have an independent path.** AI/Qwen/Jev/Loki failure must not disable the monitor's own failure signal. Whole-host failure requires a watcher off `.110`.

### Storage choice: small SQLite, not a new platform

Use Node's built-in `node:sqlite` (available in the current Node runtime) with one writer, WAL, busy timeout, schema migrations, and bounded retention. This removes many full-file scans and torn JSON writes without adding a database container.

Suggested tables:

- `ingest_state(source, cursor_json, file_identity, updated_at)`
- `events_accounting(cycle_id, received, parsed, classified, held, pending, delivered, digest, suppressed, dropped, error)`
- `signals(signal_id, fingerprint, entity, condition, first_seen, last_seen, count, severity, decision_json, evidence_locator)`
- `incidents(incident_id, fingerprint, state, severity, first_seen, last_seen, version, ack_by, ack_at, resolved_at)`
- `incident_updates(incident_id, version, change_type, summary_json, created_at)`
- `outbox(delivery_id, incident_id, update_version, kind, payload_json, state, attempts, next_attempt_at, telegram_message_id, last_error, created_at, sent_at)`
- `feedback(feedback_id, delivery_id, incident_id, decision_id, label, origin, actor, created_at)`
- `source_health(source, last_seen, expected_cadence, status, metadata_json)`
- `daily_baselines(entity, condition, day, event_count, cycle_count, ping_count)`
- `schema_migrations(version, applied_at)`

Do not store raw secrets. Store scrubbed snippets or Loki locators, with size/retention limits. Preserve existing JSONL files during migration and generate compatibility exports until feedback/report tooling is migrated and verified.

---

## 6. Implementation phases

## Phase 0 — Freeze a known baseline and create the replay harness

**Effort:** 0.5–1 focused day.  
**Goal:** make changes reviewable and distinguish deployed behavior from working-tree behavior.

### Tasks

1. Review the existing uncommitted v3.1 changes with Chris; preserve them in a named branch/commit only after approval. Do not mix them with unrelated workspace changes.
2. Produce a release manifest: Git revision, runtime file hashes, config hash, model names, deployed hashes, and test results.
3. Add sanitized fixtures for FortiGate auth/config, SSH auth, recurring identical logs, honeytokens, floods, backlog, malformed HTML, and model/Telegram failure.
4. Create `scripts/replay.mjs` (new): read a fixture manifest or sanitized exported JSONL, use a temporary data directory, inject model/send functions, and produce machine-readable decisions/accounting. It must reject live sending unless a separate explicit canary flag is supplied.
5. Record seven-day baselines before promising percentage improvements: actionable messages/day, duplicate messages, delivery failures, Jev/model calls, cycle latency, and source freshness. Current ledgers are insufficient to invent these numbers.
6. Mark docs that describe future or old behavior; do not present the v2 shadow as the acting engine.

### New/changed files

- `test/fixtures/*.jsonl` and `test/fixtures/manifest.json`
- `scripts/replay.mjs`
- `test/replay.test.mjs`
- `docs/ARCHITECTURE.md`, `README.md`
- `RELEASE.md` or generated `release-manifest.json` (no secrets)

### Acceptance

- One command replays every fixture without external network or Telegram.
- The baseline manifest identifies exactly which code produced which expected output.
- All existing tests still pass; external contract tests are reported separately, not silently skipped in CI.
- No deployment is implied by completing this phase.

### Verification

```sh
cd ~/clawd/projects/ops-watch
node --test test/cards.test.mjs test/digest.test.mjs test/label.test.mjs \
  test/triage.test.mjs test/v2.test.mjs test/contract-jev.test.mjs
node scripts/replay.mjs --fixtures test/fixtures/manifest.json --report /tmp/ops-baseline.json
node -e 'const r=require("/tmp/ops-baseline.json"); if(r.network||r.telegram)process.exit(1)'
```

---

## Phase 1 — Correct ingestion, deterministic coverage, and bounded flood behavior

**Effort:** 2–3 focused days plus a 24-hour shadow soak.  
**Goal:** every unread event is accounted for, even during backlog and model failure.

### Tasks

1. **Canonical event schema.** Preserve `origin`, `source`, `host`, `service/job`, `program`, `event_ts`, `received_at`, `level`, `message`, selected fields, and parse status. Keep `job` and `program` distinct; define rule matching explicitly.
2. **Parser/rule contract tests.** Build fixtures from real sanitized logs. Preserve `logdesc`, `status`, and other relevant fields in searchable security text. Test the actual emitted shipper shape, not a guessed format.
3. **Coverage before aggregation.** Evaluate P0/P1 security invariants per event, then aggregate matching observations. Apply volume/background suppression only after higher-priority matches. P3 must never erase a P0/P1 match.
4. **Backlog-safe triage.** Classify the full unread batch in bounded chunks. Use event-time windows for baselines and card wording, but never discard older unread events. Treat Jev/model caps as `pending/unscored`, with deterministic priority and a visible backlog—not as routine holds.
5. **Loki cursor correctness.** Replace newest-only truncation with proper pagination/per-stream continuation. Include timestamp/stream identity in continuation; do not dedup identical messages by content alone. Preserve cursor on failure and expose lag. Replace the silent two-hour skip with an explicit replay or a durable, counted operator decision.
6. **Streaming/resource bounds.** Avoid retaining every full event in every cluster when only counts/samples/selected safety fields are needed. Bound chunk bytes, cluster count, sample memory, and concurrent work. Measure RSS under a flood before choosing a container memory limit.
7. **Receiver supervision.** Remove duplicate fatal handlers; supervise/restart the receiver and expose last successful socket/bind/write time. Append failures must create health state, not just an uncaught crash.
8. **Safe rotation/compaction.** Coordinate file identity, consumed offset, and rename. Never reset the cursor or delete a file while unread bytes remain. Add a kill/restart/compaction concurrency test.
9. **Flood defense with evidence.** Add bounded per-peer/global buckets and an allowlist. A flood signal must use a durable internal path that cannot be dropped by its own bucket. Record dropped counts by peer/class and expose them in health/digest. Do not enable collector edge-dropping until dry-run counts and P0/P1 fixture preservation pass.
10. **Atomic transition state.** Add write-temp/fsync/rename helpers for remaining JSON state, corruption backup, and safe recovery. Never interpret a corrupt cursor as permission to replay all alerts without suppression history.

### Acceptance

- 6,001-line Loki fixture: all 6,001 are emitted or an explicit durable backlog remains; no silent skip.
- Identical messages ten minutes apart both survive.
- Thirty-minute backlog plus fresh events: every event receives a deterministic outcome; no offset advances past unaccounted input.
- FortiGate/SSH fixtures match their intended deterministic rules; P0 fixtures always outrank background suppression.
- Corrupt/torn state, killed receiver, full-disk simulation, and restart produce visible health errors and no uncontrolled replay storm.
- Measured flood run stays within the agreed memory budget and reports any shedding.
- No unread events are lost during 100 repeated compaction/restart fixture iterations.

### Verification

```sh
node --test test/ingest.test.mjs test/loki-tail.test.mjs test/rules.test.mjs \
  test/recovery.test.mjs test/replay.test.mjs
node scripts/replay.mjs --scenario backlog-35m --assert-accounting
node scripts/replay.mjs --scenario loki-6001 --assert-accounting
node scripts/replay.mjs --scenario flood --max-rss-mib 256 --report /tmp/ops-flood.json
docker build -t ops-watch:candidate .
docker run --rm --network none --read-only \
  -v /tmp/ops-watch-fixture:/data ops-watch:candidate \
  node scripts/replay.mjs --fixtures /data/manifest.json --no-network
```

The memory target is a proposed acceptance budget, to be validated against real replay rather than used as an unmeasured production limit.

---

## Phase 2 — Durable delivery, digest recovery, and real health monitoring

**Effort:** 3–4 focused days plus 48-hour shadow/canary observation.  
**Goal:** a log line never has to become a Telegram message immediately to remain safe, but its status must always be known.

### Tasks

1. **Add the SQLite operational store and migration.** Preserve old JSONL read-only; back up before migration; do not rewrite historical labels.
2. **Durable outbox.** Insert alert intent and rendered content before send. Process one message at a time with bounded concurrency, exponential backoff/jitter, rate-limit handling, and dead-letter state. Record each Telegram success immediately before starting the next send.
3. **Honest timeout semantics.** States: `pending`, `sent`, `retryable_failed`, `unknown`, `dead_letter`. Require `ok === true` and a numeric message ID for `sent`. Never silently mark an uncertain timeout as delivered. Do not blindly retry an ambiguous send if duplicate P0s are worse; surface the uncertainty through the independent health path.
4. **Safe Telegram rendering.** Escape every dynamic title, service/program label, headline, sample, and summary. Build text chunks before adding HTML tags; never slice markup. Split digest bodies into numbered pages and preserve every item. A minimal plain-text health message must not depend on the card/model renderer.
5. **Digest recovery.** Acknowledge queue entries individually only after the message containing them is sent. Failed question cards remain pending. Overflow remains pending for the next digest or is represented by a complete aggregate, not discarded. Do not auto-label an item that was never actually rendered and delivered.
6. **Migrate the existing 4,864-row backlog safely.** Import/dedupe by stable queue fingerprint, label it `legacy-backlog`, and produce a dry-run summary first. Do not bulk-send old cards and do not delete the queue. Review the latest high-priority/send-failed signatures; routine history can be summarized. Migration requires a backup and an explicit run, not container startup magic.
7. **Exact feedback identity.** Store `delivery_id`, `incident/signal_id`, `decision_id`, cycle, prompt/model/card versions, and the exact feature snapshot. Keep `pings.jsonl`/`labels.jsonl` compatibility exports until Jarvon's `label.mjs` path is verified against the new store.
8. **Functional healthcheck.** Check receiver/cursor progress, last successful cycle, model error rate, oldest outbox/pending item, disk/database writability, and expected source freshness. A health endpoint/file returning stale state must become unhealthy even if Node is still running.
9. **Independent dead-man signal.** A lightweight watcher on the mini/M5Max checks an authenticated local heartbeat or heartbeat age and emits one deduped DOWN and one RECOVERED notification. It must not depend on `.110`, Loki, Jev, or Qwen being healthy. Whole-host loss cannot be detected by a process on that host.
10. **Deployment hardening.** Fix the ledger path, use only the existing secret mount (remove token scraping from `MEMORY.md`), add `healthcheck`, `pids_limit`, `cap_drop`, `no-new-privileges`, and measured memory limits. Move to a non-root user with carefully migrated bind-mount ownership; do not casually `chown` the whole data directory during deployment.
11. **Release verification.** Container status is insufficient. Require one no-network replay, one synthetic in-container cycle, and an explicit Telegram canary only when Chris authorizes it. Verify feedback resolution and rollback before calling the deploy healthy.

### Quiet-hours requirement

Existing ops-watch comments describe P0 as immediate/24×7, while the global quiet-hour rule currently names only four exception classes. This plan does **not** silently add another exception. Before changing escalation policy, Chris must explicitly decide whether deterministic P0 security emergencies may page overnight and whether the independent ops-watch-DOWN alert is an allowed exception. Until then, preserve existing behavior and document the conflict rather than “fixing” it implicitly.

### Acceptance

- Kill the process after each of three sends: already acknowledged cards retain working feedback IDs; unsent work remains pending; recovery causes no uncontrolled storm.
- HTML containing `<info>`, ampersands, long Unicode, model-generated markup, and 20 digest pages never produces malformed entities or silent truncation.
- Failed body/question sends remain retryable. The current digest failure is reproduced by a fixture before the fix.
- No digest item disappears merely because it exceeds the display cap.
- Model down leaves deterministic alerts functional and ambiguous work visibly pending.
- Receiver down, Loki down, database unwritable, source stale, and whole-`.110` heartbeat loss each produce the intended, deduplicated health state.
- A rollback preserves the database and can still read/export prior feedback.

### Verification

```sh
node --test test/outbox.test.mjs test/digest-durability.test.mjs \
  test/telegram-render.test.mjs test/feedback-join.test.mjs test/health.test.mjs
node scripts/migrate-state.mjs --source data --target /tmp/ops-migration --dry-run
node scripts/migrate-state.mjs --source data --target /tmp/ops-migration --verify
docker compose config -q
docker build -t ops-watch:candidate .
docker inspect ops-watch:candidate --format '{{json .Config.Healthcheck}}'
```

Production Telegram canaries are a separate explicit step, never part of an unattended test command.

---

## Phase 3 — Replace repetitive cards with an incident lifecycle

**Effort:** 3–5 focused days plus a seven-day comparison period.  
**Goal:** fewer, more useful conversations about actual conditions rather than repeated observations.

### Incident identity and policy

Use a fingerprint such as:

```text
entity (host + service) + condition (auth_burst, model_lane_unavailable,
config_change, public_path_down, disk_error) + scope (lane/site, where relevant)
```

Do not use a raw message signature alone: IPs and counts change during one incident. Do not merge unrelated services merely because they log similar text.

Lifecycle:

- `open`: first actionable observation; notify immediately according to severity policy.
- `acknowledged`: Chris/Jarvon has seen it; suppress routine repeats, not meaningful escalation.
- `escalated`: severity increases, a new host/lane is affected, or the condition persists beyond a configured threshold.
- `recovering`: evidence suggests recovery but requires confirmation.
- `resolved`: confirmed recovery, or manual resolution for security/config events.
- `stale/unknown`: logs stop but source health cannot distinguish recovery from ingestion failure.

Recommended log-derived recovery is two or three healthy observation cycles **while the source itself is proven alive**. Silence alone is not recovery. P0 repeat behavior stays unchanged unless Chris explicitly approves aggregation; a new P0 is never muted by AI.

### Initial deterministic correlations

1. Proxy 5xx/timeouts plus backend model-serving failure → one `model lane degraded` incident, with proxy and backend as evidence.
2. Cloudflared disconnect plus external-path failure while local service health remains good → one `public path unavailable` incident; do not claim the proxy itself is down without evidence.
3. Auth failures across users/source IPs on one entity → one `authentication burst` incident, with counts and distinct principals as updates.
4. Multiple service failures on one host plus host/kernel evidence → one host-level candidate incident, clearly labeled as correlated rather than proven causal.

### Card contract

Every incident card answers:

- **What happened?** One plain sentence.
- **What is affected?** Service, host/lane, and user impact if known.
- **Why now?** New, worse, still ongoing, or recovered.
- **How confident?** Deterministic match / classifier assessment / evidence-confirmed, with unknowns.
- **What next?** One safe check or “Investigate” action.
- **State:** incident short ID and open/ack/recovering/resolved state.

Technical details remain expandable and scrubbed. Add a verified Grafana/Loki deep link only after its existing authenticated route and query parameters are tested; never invent links. A local `incidents.mjs list/show/history` CLI is sufficient before any dashboard.

### Feedback/actions

Retain the current `useful/noise/mute` meanings for learning. Add incident-level `ack`, `resolve`, and `investigate` through the existing Jarvon callback/reply path. Do not poll Telegram from ops-watch or create a webhook on the shared bot token. Acknowledgement must not hide a later severity/scope change.

### Baselines

Store compact per-entity/condition daily aggregates for at least 30 days. Query Loki for older raw evidence when necessary; do not retain full raw events in SQLite. Only call something a spike with enough count/history to support that statement. Low-volume new patterns are “new,” not statistically anomalous.

### Acceptance

- One continuing condition produces one incident and no duplicate initial cards after restart.
- Severity/scope changes create an update; unrelated service failures do not merge.
- Recovery requires the specified healthy evidence and source freshness.
- Feedback/mute/ack survives restart and joins the exact incident update.
- A seven-day replay compares message count and critical-fixture recall against Phase 2 with no AI decision change hidden inside the comparison.

### Verification

```sh
node --test test/incident-state.test.mjs test/correlation.test.mjs \
  test/incident-recovery.test.mjs test/incident-feedback.test.mjs
node scripts/replay.mjs --days 7 --mode phase2 --report /tmp/ops-cards.json
node scripts/replay.mjs --days 7 --mode incidents --report /tmp/ops-incidents.json
node scripts/compare-replay.mjs /tmp/ops-cards.json /tmp/ops-incidents.json
```

---

## Phase 4 — Evidence-backed, read-only investigation

**Effort:** 4–6 focused days; deploy only after Phases 1–3 are stable.  
**Goal:** transform “something unusual happened” into “here is what we checked and what remains unknown.”

### First three investigation adapters

1. **Loki evidence query:** bounded logs for the incident's entity/condition/time range; return counts and scrubbed samples, not unrestricted queries.
2. **Service/container health:** allowlisted inspect/status/health information for known ops services; no restart, stop, update, or arbitrary Docker API access.
3. **Model-lane health:** existing HTTP health/model endpoints with short timeouts and minimal response allowlists; no credentials in evidence or prompts.

### Evidence playbook contract

Each playbook has a fixed incident type, typed parameters, allowed target set, timeout, output size limit, and sanitization. It emits:

```json
{
  "check": "model-backend-health",
  "target_alias": "approved-lane-a",
  "observed_at": "...",
  "status": "ok|failed|timeout|unavailable",
  "facts": [],
  "unknowns": [],
  "artifact_locator": "...",
  "redactions": 0
}
```

A model may summarize this structured evidence using the already approved local model lane. It may not choose a shell command, target, credential, or remediation. Output must distinguish:

- **Observed:** directly returned by a check.
- **Assessment:** interpretation of those observations.
- **Unknown:** unavailable, contradictory, or unchecked.
- **Next safe step:** a human-readable action or an allowed additional check.

Run investigation on demand first. Automatic investigation for selected P1 incident types can be enabled later only if it is reliable and useful. There is no automatic remediation in this plan.

### Acceptance

- Timeouts/unavailable dependencies produce `unknown` and never a fabricated healthy/root-cause conclusion.
- Injection strings in logs cannot select a tool, alter the target, or cause a network/action outside the playbook.
- Every conclusion links to structured evidence; every check is timeout/output bounded and scrubbed.
- No write-capable Docker socket, shell evaluator, or arbitrary SSH command is exposed to the model.
- A blind fixture evaluation confirms that the summary is more useful than the Phase 3 card without increasing unsupported claims.

### Verification

```sh
node --test test/evidence-playbooks.test.mjs test/evidence-redaction.test.mjs \
  test/investigation-prompt.test.mjs test/investigation-policy.test.mjs
node scripts/investigate.mjs --fixture test/fixtures/model-lane-degraded.json --offline
node scripts/investigate.mjs --fixture test/fixtures/injection.json --offline --assert-no-egress
```

Any live read-only adapter rollout is separately allowlisted and verified; offline tests do not authorize production access.

---

## Phase 5 — Evaluation, decision consolidation, and responsible learning

**Effort:** 2–3 days of tooling, then one to two weeks of observation.  
**Goal:** improve decisions with evidence rather than adding overlapping AI judgments.

### Tasks

1. Keep Jev v2 in shadow until the acting baseline and v2 are compared on identical, correctly ingested events. Do not change ingestion, incident logic, and classifier authority in one release.
2. Separate **classification** (routine/fault/security/uncertain) from **wording** (card explanation). Qwen should not silently reroute a previously actionable ambiguous signal to no-action merely because the model is unavailable or disagrees without a policy reason.
3. Report per-source/per-severity performance and class counts. Include unscored/pending rates; a classifier that scores only easy events must not appear highly accurate.
4. Build a human-labeled benchmark with both useful and noise/missed examples. Include missed events discovered through sampled Loki review and synthetic canaries. Auto-labels are weak hints, never independent test truth.
5. Measure critical-fixture recall, actionable precision, duplicate rate, missed-event review, detection latency, recovery accuracy, and investigation evidence yield.
6. Compare ML against a trivial baseline and Jev without leaking Jev probabilities into a claimed independent improvement. Use time-based holdout, exact-decision joins, and human-only test labels.
7. Keep the 300-human-label minimum if desired, but add class-coverage and performance gates. More rows of one class are not readiness. No automatic model retraining or auto-promotion.
8. Produce a concise weekly report: open/resolved incidents, false-positive feedback, missed review, delivery reliability, source coverage, pending backlog, and model/token usage. No “300 predictions → 2 questions” claim until measured.

### Proposed promotion gates

- 100% pass on deterministic P0/P1 safety fixtures and ingestion accounting fixtures.
- No regression in human-labeled critical recall relative to the current acting baseline.
- Lower duplicate/actionable-message burden on the same replay, with the reduction reported rather than assumed.
- Zero unaccounted events and zero silently pending/dead-letter deliveries.
- Stable soak with no unexplained health gaps or resource growth.
- Chris explicitly approves acting-mode promotion. Shadow output alone never changes live suppression.

---

## Phase 6 — Complete the efficiency work and simplify operations

**Effort:** 1–2 days after correctness is deployed, plus a one-week review.  
**Goal:** realize the existing efficiency plan without turning cost reduction into blindness.

### Tasks

1. Enable collector edge routing only from a versioned, tested filter configuration with P0/P1 allow-before-drop behavior, dry-run counts, and full Loki retention.
2. Report per-class drops and per-peer flood shedding in the daily health summary. Preserve an easy way to replay filtered classes from Loki.
3. Rotate/bound large JSONL compatibility exports and logs; retain database backups and restore tests. Pruning must never erase the only copy of unacknowledged work.
4. Replace remaining full-file reads with indexed queries or bounded tails. Archive historical shadow rows after reporting/retention requirements are met.
5. Measure token/model use after incident correlation; optimize repeated classification with incident context and safe caching before considering any new model.
6. Update README, architecture, rules, feedback, and runbook to match the deployed release. Document rollback, backup/restore, stale-source handling, and failure injection.
7. Remove obsolete v1/v2/digest paths only after compatibility and replay checks prove they are no longer needed.

---

## 7. Metrics and targets

Measure a seven-day baseline first. These are proposed targets, not claims about current performance.

| Area | Metric | Proposed gate/target |
|---|---|---|
| Event integrity | Accepted events with a durable accounted outcome | 100%; zero unexplained loss |
| Backlog | Oldest unprocessed/pending item | Visible; deterministic alert threshold, no silent aging |
| Source coverage | Expected sources with fresh heartbeat/progress | 100%, or one explicit stale-source incident |
| Deterministic safety | P0/P1 fixture recall | 100% |
| Delivery | Alerts with known delivery state | 100%; unknown explicitly surfaced |
| Delivery | Silent dead-letter/failed digest items | 0 |
| Latency | Event-to-actionable notification | p95 ≤10 minutes initially; tighten after measurement |
| Noise | Duplicate initial messages for one continuing incident | 0 |
| Noise | Actionable messages on identical replay | ≥50% reduction target without recall regression |
| Attention | Digest questions | At most the configured cap; only actually delivered items eligible |
| Recovery | Resolved solely because logs went quiet while source health is unknown | 0 |
| Investigation | Claims backed by returned evidence or explicitly marked unknown | 100% |
| Learning | Evaluation labels | Human, exact-decision joined, class counts reported |
| Resources | RSS/cycle time/model spend | Bounded and no worse than agreed baseline after soak |

The most important daily report is small:

> Open incidents · new/resolved · delivery failures · stale sources · pending backlog · dropped-event counters · items needing Chris

If all are healthy, no extra “everything is fine” Telegram message is needed outside the chosen digest cadence.

---

## 8. File-level implementation map

| Existing/new file | Planned responsibility |
|---|---|
| `lib.mjs` | Incrementally extract canonical event, clustering, policy, and atomic-state helpers; avoid a giant rewrite |
| `loki-tail.mjs` | Correct cursors/pagination, per-source health, durable backlog/loss counters, testable main guard |
| `receiver.mjs` | Supervised/bounded ingest, peer policy, counters, safe writes |
| `triage.mjs` | Full-batch deterministic accounting, pending backlog, outbox production; no direct ad-hoc alert sends |
| `triage-v2.mjs`, `jev-client.mjs` | Keep shadow/typed classification; correct all-failed/pending accounting; consolidate only after comparison |
| `rules.json` | Match canonical schema; fixture every selector and preserve safety precedence |
| `store.mjs` (new) | SQLite connection, migrations, transactions, retention/backup helpers |
| `outbox.mjs` (new) | Durable delivery state machine and compatibility export |
| `incidents.mjs` (new) | Incident fingerprint/lifecycle/correlation/CLI |
| `evidence.mjs` (new) | Typed read-only playbooks, artifacts, redaction, no arbitrary execution |
| `cards.mjs` | Presentation only; safe markup/chunking; no hidden authority to erase pending work |
| `notify.mjs` | Strict Telegram response contract, timeout/unknown semantics, rate-limit metadata, existing secret mount only |
| `digest.mjs` | Per-item acknowledgement, pagination/backlog, accurate delivered/auto-label state |
| `label.mjs` | Exact decision/delivery/incident join, idempotent labels, atomic/SQLite mutes |
| `history.mjs` | Durable compact baselines; visible write failures; 30-day aggregates |
| `health.mjs` (new) | Functional status and independent heartbeat payload; no model dependency |
| `ticker.sh` | Supervision, cycle timing, health updates, safe rotation; avoid overlapping writers |
| `Dockerfile`, `compose.yaml` | Healthcheck, non-root/runtime hardening, measured resource limits |
| `deploy.sh` | Correct ledger path, no credential scraping, functional smoke/rollback verification |
| `scripts/replay.mjs` (new) | Offline fixture/replay baseline and regression comparison |
| `scripts/migrate-state.mjs` (new) | Backed-up, dry-run-first JSONL/queue migration |
| `test/*` | Add ingest, recovery, delivery, incident, evidence, and end-to-end failure tests |
| `docs/*` | Live/proposed separation and evidence-backed operating instructions |

---

## 9. Rollout and rollback strategy

1. **One release per phase.** Do not combine parser semantics, Jev promotion, incident grouping, and investigation in one deployment.
2. **Offline replay first.** All safety/accounting/delivery tests use temporary state and injected send/model functions.
3. **Build candidate image.** No ports, no production volumes, no external network for fixture tests.
4. **Shadow beside the acting path.** Record proposed decisions without sending; compare against the same input and identical time range.
5. **Back up before migration.** Preserve original JSONL/config/data and verify a restore/read path. Database migration is explicit, versioned, and dry-run first.
6. **Canary only with Chris's approval.** A single marked synthetic incident verifies Telegram and feedback; no synthetic flood to the real chat.
7. **Soak and compare.** Review event accounting, stale sources, queue age, memory, card counts, and feedback. Do not declare success from `docker ps`.
8. **Rollback by release artifact.** Revert code/config while preserving the newer data. Provide backward-compatible exports/readers; never delete the new database during rollback.
9. **Stop conditions:** any unexplained event loss, P0/P1 fixture regression, uncontrolled duplicate alerts, dead feedback links, or growing unreported backlog.

---

## 10. Effort and priority

| Milestone | Focused effort | Observation |
|---|---:|---:|
| Phase 0: baseline/replay | 0.5–1 day | Immediate |
| Phase 1: ingestion/coverage | 2–3 days | 24-hour shadow |
| Phase 2: durable delivery/health | 3–4 days | 48-hour canary/soak |
| Phase 3: incidents/correlation | 3–5 days | 7-day comparison |
| Phase 4: evidence investigation | 4–6 days | Adapter-by-adapter |
| Phase 5: evaluation/learning | 2–3 days tooling | 1–2 weeks data |
| Phase 6: efficiency/operations | 1–2 days | 1-week filter review |

**Total:** roughly 16–24 focused engineering days plus observation, not one giant rewrite. Phases 0–3 are the highest-value first milestone: a trustworthy, low-noise incident system. Phase 4 is the next genuinely dramatic user-facing improvement. ML is optional and later.

If only three things are funded, choose:

1. Phases 1–2 integrity and delivery;
2. Phase 3 incident lifecycle;
3. Phase 4 evidence-backed investigation.

---

## 11. Decisions needed from Chris before implementation

1. **Plan approval:** approve the full roadmap or only Phases 0–2 initially. The earlier efficiency plan remains unstarted without his go.
2. **Working-tree baseline:** may the existing v3.1 changes be reviewed and committed as the baseline for this work? No unrelated workspace changes will be included.
3. **Quiet hours:** should deterministic P0 security emergencies and/or independent ops-watch-DOWN alerts be added to the explicit overnight exceptions? No policy change is assumed.
4. **Initial incident target:** suggested first target is model-lane degradation because it crosses proxy/backend/public-path boundaries; alternative is SSH/FortiGate auth incidents.
5. **Read-only investigation scope:** approve the first three adapter types and target hosts when Phase 4 starts; plan approval alone does not grant new host access.
6. **Attention target:** after the seven-day baseline, choose a desired actionable-incident budget (for example, a maximum expected number/day) rather than guessing from the current noisy backlog.

---

## 12. Reproduction notes from this audit

These are audit probes, not new regression tests yet. Phase 0 must turn them into permanent fixtures.

- **Backlog:** one synthetic event 30 minutes old, default `--window-min 5`, temporary state → zero clusters; saved offset equaled input bytes.
- **Mixed backlog:** one 35-minute-old and one fresh event → only one event classified.
- **Loki over-cap:** mocked 6,001 source lines → 5,000 appended; `truncated:false`; cursor at newest line.
- **Rules:** FortiGate auth fixture had `program:event`, selector `job:event`, `rule_match:null`; SSH fixture had `program:sshd`, selector `job:sshd`, `rule_match:null` against the current auth rule.
- **Digest overflow:** 16 queued entries with display cap 15 → 15 shown, zero remaining after rotation.
- **Digest production failure:** Telegram `400` unsupported HTML start tag `info`; zero digest rows in `pings.jsonl`; 4,864 queue rows at inspection.
- **Delivery contract:** mocked `{ok:false}` was counted as sent; a thrown send error correctly entered the failed-digest queue. Production `notify.mjs` normally throws on `{ok:false}`, but the callee should still enforce the contract.
- **Tests:** 43 enabled tests passed and one external contract test skipped. These passing tests do not cover the reproduced ingest/digest edge cases.

The audit's central conclusion is therefore evidence-based, not a criticism of the project's ambition:

> ops-watch already has useful ingestion, classification, and presentation pieces. Its dramatic improvement comes from connecting them with durable state, explicit failure behavior, incident context, and measurable evidence—not from adding another layer of AI on top of uncertain delivery.
