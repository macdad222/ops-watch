#!/usr/bin/env node
// digest.mjs — daily ops-watch digest (plan §4.6). One message, ≤max_items + "+N more".
// Sources: data/digest-queue.jsonl (v1 jev-down / over-cap / send-failed / v2-digest items)
//          + data/jev-v2-shadow.jsonl last 24h (v2 would-ping + unsure, clearly headed).
// NEVER sends during quiet hours (00:00–06:00 CT). Due at cfg.digest.send_at CT (08:00).
// Records to pings.jsonl (kind=digest); rotates the queue after a successful send.
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpsConfig, isQuietHoursCT, ctWallTime } from './lib.mjs';
import { sendTelegram, pingMessage, feedbackKeyboard } from './notify.mjs';
import { scrub } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');

function readJsonl(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return [];
  const out = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l) continue;
    try { out.push(JSON.parse(l)); } catch { /* torn line */ }
  }
  return out;
}
function todayCT() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()); }

export function collectDigestItems({ cfg, now = Date.now() } = {}) {
  const items = [];
  // 1) v2 shadow would-ping / unsure (latest row per sig, last 24h)
  const cut = now - 24 * 3600000;
  const latest = new Map();
  for (const r of readJsonl('jev-v2-shadow.jsonl')) {
    if (!r.sig || !r.v2_decision || new Date(r.ts).getTime() < cut) continue;
    const prev = latest.get(r.sig);
    if (!prev || new Date(r.ts) > new Date(prev.ts)) latest.set(r.sig, r);
  }
  for (const r of latest.values()) {
    if (r.v2_decision === 'ping') items.push({ kind: 'shadow-ping', sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — WOULD have pinged (${r.v2_reason})` });
    else if (r.v2_decision === 'digest' && /uncertain/i.test(r.v2_reason || '')) items.push({ kind: 'shadow-unsure', sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — unsure (${r.v2_reason})` });
  }
  // 2) queued items (v1 jev-down / over-cap / send-failed / v2-digest)
  for (const q of readJsonl('digest-queue.jsonl')) {
    items.push({ kind: 'queued', sig: q.sig, source: q.source, program: q.program, count: q.count, sample: q.sample || '', reason: `${q.reason}` });
  }
  return items;
}

export async function runDigest({ cfg, send = sendTelegram, now = Date.now(), force = false } = {}) {
  if (!cfg.digest?.enabled) return { sent: false, why: 'disabled' };
  if (!force && isQuietHoursCT(cfg, new Date(now))) return { sent: false, why: 'quiet-hours' };
  const stateP = join(DATA_DIR, 'digest-state.json');
  let lastSent = null;
  try { lastSent = JSON.parse(readFileSync(stateP, 'utf8')).last_sent_date; } catch { /* first run */ }
  const today = todayCT();
  if (!force) {
    const t = ctWallTime(new Date(now));
    if (t < (cfg.digest.send_at || '08:00')) return { sent: false, why: `not due (${t} < ${cfg.digest.send_at})` };
    if (lastSent === today) return { sent: false, why: 'already sent today' };
  }
  const all = collectDigestItems({ cfg, now });
  if (!all.length) { writeFileSync(stateP, JSON.stringify({ last_sent_date: today, ts: new Date(now).toISOString() })); return { sent: false, why: 'nothing to digest (state marked)' }; }
  const max = cfg.digest.max_items ?? 15;
  const shown = all.slice(0, max);
  const rest = all.length - shown.length;
  const pingId = Math.random().toString(36).slice(2, 6);
  const lines = [`📬 <b>ops-watch digest</b> — ${today} CT · ${all.length} item(s)`];
  shown.forEach((it, i) => {
    const icon = it.kind === 'shadow-ping' ? '🟠' : it.kind === 'shadow-unsure' ? '🟡' : '▫️';
    lines.push(`${icon} <code>#${pingId}.${i + 1}</code> ${it.source}/${it.program || '?'} ×${it.count} — <i>${it.reason}</i>\n   <code>${scrub(String(it.sample)).slice(0, 140)}</code>`);
  });
  if (rest > 0) lines.push(`➕ +${rest} more — full detail in held.jsonl / shadow ledger`);
  lines.push(`<i>Feedback: 👍 useful · 👎 noise · 🔕 mute 7d · ➕ should have pinged — or reply "ow missed ${pingId}.1"</i>`);
  const r = await send(lines.join('\n'), { replyMarkup: feedbackKeyboard(pingId, { withMissed: true }) });
  const messageId = r?.result?.message_id ?? null;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  appendFileSync(join(DATA_DIR, 'pings.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), ping_id: pingId, message_id: messageId, kind: 'digest', mode: cfg.triage_mode,
    items: shown.map((it, i) => ({ item_id: `${pingId}.${i + 1}`, sig: it.sig, source: it.source, program: it.program,
      decision: it.reason, mode: it.kind === 'queued' ? 'v1' : 'shadow', probs: null, confidence: null })),
  }) + '\n');
  writeFileSync(stateP, JSON.stringify({ last_sent_date: today, ts: new Date(now).toISOString() }));
  // rotate the queue (consumed)
  const q = join(DATA_DIR, 'digest-queue.jsonl');
  if (existsSync(q)) { try { mkdirSync(join(DATA_DIR, 'processed'), { recursive: true }); renameSync(q, join(DATA_DIR, 'processed', `digest-queue-${Date.now()}.jsonl`)); } catch { /* keep */ } }
  return { sent: true, ping_id: pingId, items: all.length, shown: shown.length, message_id: messageId };
}

// CLI: node digest.mjs --if-due   (ticker hook; exits silently unless due)
const args = process.argv.slice(2);
if (args.includes('--if-due') || args.includes('--force') || args.includes('--dry')) {
  const cfg = loadOpsConfig();
  if (args.includes('--dry')) {
    const items = collectDigestItems({ cfg });
    console.log(`digest dry: ${items.length} items`);
    for (const it of items.slice(0, 20)) console.log(`  [${it.kind}] ${it.source}/${it.program} ×${it.count} — ${it.reason}`);
  } else {
    const r = await runDigest({ cfg, force: args.includes('--force') }).catch(e => { console.error('digest FAILED:', e.message); process.exit(1); });
    console.log(JSON.stringify(r));
  }
}
