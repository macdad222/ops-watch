#!/usr/bin/env node
// label.mjs — ops-watch feedback ingestion (plan §4.3; v3 card rework 2026-10-23).
// Runs ON .110 inside the container:
//   docker exec ops-watch node label.mjs --msg <telegram_message_id> --label <useful|noise|mute|missed> --via <reaction|button|reply>
//   docker exec ops-watch node label.mjs --card <card_id> --label <label> --via button      # per-card button (ow:<label>:<card_id>)
//   docker exec ops-watch node label.mjs --msg <message_id> --label <label> --via reply     # human reply phrase → card(s)
//   docker exec ops-watch node label.mjs --ping <ping_id> --label noise --via reply [--item <item_id>]   # old alias, still works
// Resolution:
//   --card <card_id> → every sig in that card (pings.jsonl cards[] mapping).
//   reply without --card/--item → the single actionable card when there is exactly one;
//   multiple actionable cards → all of them (the reply referred to the whole message);
//   no cards (old messages) → every item in the message (old message-level behavior).
// Appends data/labels.jsonl (LOCAL ONLY — never sent anywhere):
//   human rows  source:"chris", weight 1
//   auto rows   source:"auto", weight 0.3, auto_reason (written by digest.mjs, not here)
// 'mute' → data/mutes.json {sig: until_ms} (now + feedback.mute_days, default 7).
// ops-watch NEVER polls Telegram (shared bot token with OpenClaw) — labels arrive via Jarvon.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');
const LABELS = ['useful', 'noise', 'mute', 'missed'];
const VIAS = ['reaction', 'button', 'reply'];

function readJsonl(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return [];
  const out = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip torn line */ }
  }
  return out;
}

function findPingAndCard({ msg, pingId, cardId }) {
  const pings = readJsonl('pings.jsonl');
  if (msg != null) {
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i];
      if (String(p.message_id) === String(msg)) return { ping: p, card: null };
      // v3.1: one card per message — a card-level message_id resolves EXACTLY one card
      const c = (p.cards || []).find(c => c.message_id != null && String(c.message_id) === String(msg));
      if (c) return { ping: p, card: c };
    }
    return null;
  }
  if (cardId) {
    for (let i = pings.length - 1; i >= 0; i--) if ((pings[i].cards || []).some(c => c.card_id === cardId)) return { ping: pings[i], card: null };
    return null;
  }
  for (let i = pings.length - 1; i >= 0; i--) if (pings[i].ping_id === pingId) return { ping: pings[i], card: null };
  return null;
}

// latest shadow row per sig (for probs/confidence/v2 decision enrichment)
function shadowBySig() {
  const m = new Map();
  for (const r of readJsonl('jev-v2-shadow.jsonl')) if (r.sig && r.probs) m.set(r.sig, r);
  return m;
}

function loadMutes() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'mutes.json'), 'utf8')) || {}; } catch { return {}; }
}
function saveMutes(m) { writeFileSync(join(DATA_DIR, 'mutes.json'), JSON.stringify(m)); }

function loadCfgDays() {
  try {
    const c = JSON.parse(readFileSync(join(HERE, 'config', 'opswatch.json'), 'utf8'));
    return c?.feedback?.mute_days ?? 7;
  } catch { return 7; }
}

const args = process.argv.slice(2);
const getArg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const label = getArg('--label');
const via = getArg('--via') || 'reply';
const msg = getArg('--msg');
const pingId = getArg('--ping');
const itemFilter = getArg('--item');
const cardFilter = getArg('--card');

if (!label || !LABELS.includes(label) || (!msg && !pingId && !cardFilter)) {
  console.error('usage: label.mjs --msg <message_id>|--ping <ping_id>|--card <card_id> --label <useful|noise|mute|missed> [--via reaction|button|reply] [--item <item_id>]');
  process.exit(2);
}
if (!VIAS.includes(via)) { console.error(`bad --via ${via}`); process.exit(2); }

const pingCard = findPingAndCard({ msg, pingId, cardId: cardFilter });
const ping = pingCard?.ping;
if (!ping) { console.error(`no pings.jsonl row for ${msg ? 'message ' + msg : cardFilter ? 'card ' + cardFilter : 'ping ' + pingId}`); process.exit(1); }
const shadow = shadowBySig();

// ── resolve which items the label applies to ─────────────────────────────────
let targetCardIds = null;   // null = whole message (legacy), array = specific card(s)
let items = (ping.items || []);
if (cardFilter) {
  const card = (ping.cards || []).find(c => c.card_id === cardFilter);
  if (!card) { console.error(`no card ${cardFilter} in ping ${ping.ping_id}`); process.exit(1); }
  targetCardIds = [card.card_id];
  items = items.filter(it => card.sigs?.includes(it.sig));
} else if (pingCard.card) {
  // v3.1: the message_id matched ONE card directly (one card per message) — clean resolution
  targetCardIds = [pingCard.card.card_id];
  items = items.filter(it => pingCard.card.sigs?.includes(it.sig));
} else if (itemFilter) {
  items = items.filter(it => it.item_id === itemFilter);
} else if (via === 'reply' && Array.isArray(ping.cards) && ping.cards.length) {
  // reply without a card-level message_id: exactly one actionable card → that card;
  // several → AMBIGUOUS, do NOT guess (Jarvon asks Chris which card)
  const actionable = ping.cards.filter(c => c.rating && c.rating !== 'no_action');
  if (actionable.length === 1) {
    targetCardIds = [actionable[0].card_id];
    items = items.filter(it => actionable[0].sigs?.includes(it.sig));
  } else if (actionable.length > 1) {
    console.error(`AMBIGUOUS: ${actionable.length} actionable cards on this message (${actionable.map(c => c.card_id + ' ' + c.title).join(' | ')}). Ask Chris which one — do not guess.`);
    process.exit(3);
  }
  // no actionable cards → fall through: whole message (all items)
}
if (!items.length) { console.error(`no matching items${itemFilter ? ' for ' + itemFilter : ''}${cardFilter ? ' for card ' + cardFilter : ''}`); process.exit(1); }

const now = Date.now();
const rows = [];
const mutes = loadMutes();
const muteDays = loadCfgDays();
let mutesChanged = false;
for (const it of items) {
  const sh = shadow.get(it.sig);
  rows.push({
    ts: new Date().toISOString(),
    label, via,
    source: 'chris',          // label origin (auto rows from digest.mjs carry source:"auto")
    weight: 1,
    auto_reason: null,
    ping_id: ping.ping_id,
    item_id: it.item_id ?? null,
    card_id: targetCardIds && targetCardIds.length === 1 ? targetCardIds[0] : (targetCardIds ? targetCardIds.join(',') : null),
    message_id: ping.message_id ?? null,
    sig: it.sig, event_source: it.event_source ?? it.source ?? null, program: it.program,
    decision: it.decision ?? null,
    mode: it.mode ?? ping.mode ?? null,
    jev: sh ? { probs: sh.probs, confidence: sh.confidence } : null,
    v2_shadow_decision: sh?.v2_decision ?? null,
    features: sh?.features ?? null,
  });
  if (label === 'mute') {
    mutes[it.sig] = now + muteDays * 86400000;
    mutesChanged = true;
  }
}
appendFileSync(join(DATA_DIR, 'labels.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
if (mutesChanged) saveMutes(mutes);
const scope = targetCardIds ? `card(s) ${targetCardIds.join(',')}` : 'whole message';
console.log(`labeled ${rows.length} item(s): ${label} via ${via} (${scope}, ping ${ping.ping_id})${mutesChanged ? ' · mutes updated' : ''}`);
for (const r of rows) console.log(`  ${r.item_id ?? '-'} ${r.sig} ${r.event_source}/${r.program}`);
