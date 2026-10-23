#!/usr/bin/env node
// label.mjs — ops-watch feedback ingestion (plan §4.3). Runs ON .110 inside the container:
//   docker exec ops-watch node label.mjs --msg <telegram_message_id> --label <useful|noise|mute|missed> --via <reaction|button|reply> [--item <item_id>]
//   docker exec ops-watch node label.mjs --ping <ping_id> --label noise --via reply
// Reads data/pings.jsonl for the message → items; enriches from data/jev-v2-shadow.jsonl;
// appends data/labels.jsonl (LOCAL ONLY — never sent to TypeSafe/Qwen/anywhere);
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

function findPing({ msg, pingId }) {
  const pings = readJsonl('pings.jsonl');
  if (msg != null) {
    for (let i = pings.length - 1; i >= 0; i--) if (String(pings[i].message_id) === String(msg)) return pings[i];
    return null;
  }
  for (let i = pings.length - 1; i >= 0; i--) if (pings[i].ping_id === pingId) return pings[i];
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

if (!label || !LABELS.includes(label) || (!msg && !pingId)) {
  console.error('usage: label.mjs --msg <message_id>|--ping <ping_id> --label <useful|noise|mute|missed> [--via reaction|button|reply] [--item <item_id>]');
  process.exit(2);
}
if (!VIAS.includes(via)) { console.error(`bad --via ${via}`); process.exit(2); }

const ping = findPing({ msg, pingId });
if (!ping) { console.error(`no pings.jsonl row for ${msg ? 'message ' + msg : 'ping ' + pingId}`); process.exit(1); }
const shadow = shadowBySig();
const items = (ping.items || []).filter(it => !itemFilter || it.item_id === itemFilter);
if (!items.length) { console.error(`no matching items${itemFilter ? ' for ' + itemFilter : ''}`); process.exit(1); }

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
    ping_id: ping.ping_id,
    item_id: it.item_id,
    message_id: ping.message_id ?? null,
    sig: it.sig, source: it.source, program: it.program,
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
console.log(`labeled ${rows.length} item(s): ${label} via ${via} (ping ${ping.ping_id})${mutesChanged ? ' · mutes updated' : ''}`);
for (const r of rows) console.log(`  ${r.item_id} ${r.sig} ${r.source}/${r.program}`);
