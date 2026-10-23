# ops-watch Feedback — how to tell ops-watch it got something wrong (or right)

*Live as of 2026-10-23. Every ops-watch ping carries an id (`#k3f9.1`) and feedback buttons.*

## Three ways to label (all land in the same ledger)

1. **Buttons (primary — works today).** Every ping has `👍 useful · 👎 noise · 🔕 mute 7d` buttons.
   A click labels **every item in that message**. OpenClaw routes the click to Jarvon, which records it.
2. **Reply command (item-level).** Reply to a ping (or DM the bot):
   - `ow noise k3f9` — everything in ping k3f9 was noise
   - `ow noise k3f9.2` — only item 2 was noise
   - `ow useful k3f9` · `ow mute k3f9` · `ow missed k3f9` ("should have pinged" — for digest items)
3. **Reactions (staged, needs one config change).** 👍/👎/🔕 on the message. Requires
   `channels.telegram.reactionNotifications: "all"` in OpenClaw config — STAGED, pending Chris's OK
   (default `own` mode drops reactions on messages sent outside OpenClaw; enabling may need a gateway restart).

## What each label does

- **useful** — ping was worth it. Feeds the weekly precision report and example refresh.
- **noise** — shouldn't have pinged. Feeds precision/recall + threshold suggestions (never auto-applied).
- **mute** — silence this exact signature for 7 days (P0 honeytokens are NEVER muted; P1 mutes are logged).
- **missed** — (digest items) this should have been a ping. Recall signal.

All labels go to `data/labels.jsonl` on .110 — local only, never sent to TypeSafe/Qwen/anywhere.
Weekly report (Sun 20:00 CT): `~/clawd/ops/reports/opswatch-labels-<date>.md`.

## One-line version

> See an ops-watch ping that's junk? Tap 👎 (or reply `ow noise <id>`). Missing something? `ow missed <id>` on the digest.
