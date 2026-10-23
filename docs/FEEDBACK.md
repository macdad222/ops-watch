# ops-watch Feedback — how to tell ops-watch it got something wrong (or right)

*Live as of 2026-10-23 (v3 cards). Alerts are plain-English cards — one per machine/service —
and Chris is only asked about things he can actually judge.*

## What a card looks like

    🟡 FortiGate firewall (FGT90G…) — worth a look
    An unusual burst of activity — 314 events in 5 minutes, more than usual.
    Suggested next step: Glance at what the traffic was; if it's your own gear, ignore it.
    ▸ expandable: counts, hosts, raw signal, sig ids, log samples
    [Glad you told me] [Didn't need this] [Stop telling me about this (7 days)]

Ratings: **needs attention** (act soon — every P0/P1 rule hit lands here) · **worth a look**
(minor, glance when convenient) · **no action needed** (routine — no card, no buttons; collapses
into one summary line and goes to the 8am digest only).

## Three ways to label (all land in the same ledger)

1. **Per-card buttons (primary).** Only "worth a look" / "needs attention" cards carry buttons.
   A click labels **every signature in that card** (callback `ow:<label>:<card_id>`).
2. **Reply to a card in words.** "didn't need this" / "not needed" / "noise" → noise ·
   "glad you told me" / "useful" / "thanks" → useful · "stop" / "mute" → mute 7 days.
   One actionable card in the message → that card; several → all of them.
3. **Old aliases still work.** `ow noise <ping_id>` / `ow noise <ping_id>.2` / `ow useful` /
   `ow mute` / `ow missed <id>` (digest items). Reactions 👍/👎/🔕 label the whole message
   (needs `channels.telegram.reactionNotifications: "all"` — staged, pending Chris).

## What each label does

- **useful** — card was worth it. Feeds the weekly precision report and example refresh.
- **noise** — shouldn't have pinged. Feeds precision/recall + threshold suggestions (never auto-applied).
- **mute** — silence every signature in the card for 7 days (P0 honeytokens are NEVER muted).
- **missed** — (digest) this should have been a ping. Recall signal.

## Auto-labels (v3) — clearly separated from Chris's

`data/labels.jsonl` rows carry an origin: **`source:"chris"`, weight 1** for human labels;
**`source:"auto"`, weight 0.3** with `auto_reason` for:
- `ignored_no_action` — a no-action digest item Chris didn't label by the next digest (weak noise vote; NEVER applied to worth-a-look/needs-attention cards)
- `qwen_prelabel` — the card model confidently rated it routine (conf ≥ 0.8)
- `jev_prelabel` — v2 shadow probs strongly routine (p ≥ 0.9, conf ≥ 0.6)

Auto rows never inflate the 300-human-label ml gate (report-labels.mjs / build-examples.mjs /
ml/train.py all filter to human rows).

## Daily question cap

The 8am digest asks at most **5 questions/day** (`digest.max_questions`) — the most useful
borderline cards (v1/v2 disagreement, low v2 confidence, v2 would-ping). Everything else is
shown plain (no buttons) or as the routine summary line.

All labels go to `data/labels.jsonl` on .110 — local only, never sent to TypeSafe/Qwen/anywhere.
Weekly report (Sun 20:00 CT): `~/clawd/ops/reports/opswatch-labels-<date>.md`.

## One-line version

> See a junk card? Tap **Didn't need this** (or reply "didn't need this" / "stop" to it).
> Missing something? `ow missed <id>` on the digest.
