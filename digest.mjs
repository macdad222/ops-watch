#!/usr/bin/env node
// digest.mjs — daily ops-watch digest (plan §4.6; v3 card rework 2026-10-23).
// One message, plain-English cards (cards.mjs), ≤max_items + "+N more".
// Sources: data/digest-queue.jsonl (v1 jev-down / over-cap / send-failed / v2-digest /
//          routine-no-action items) + data/jev-v2-shadow.jsonl last 24h (would-ping + unsure).
// v3 (2026-10-23, Chris: "only ask about what I can judge"):
//   - NO message-level keyboard; per-card buttons ONLY on "question" cards, hard-capped at
//     cfg.digest.max_questions (default 5/day). Questions = most useful borderline cards:
//     v1/v2 disagreement, low v2 confidence, v2 would-ping.
//   - Everything else is auto-labeled (source:"auto", weight 0.3, auto_reason):
//       ignored_no_action — no-action digest item Chris didn't label by the next digest
//       qwen_prelabel     — Qwen confidently rated it routine (conf ≥ prelabel_confidence)
//       jev_prelabel      — shadow probs strongly routine (p ≥ 0.9, conf ≥ 0.6)
//     Human rows (label.mjs) get source:"chris", weight 1. Auto rows never inflate the
//     300-human-label gate (report-labels.mjs / build-examples.mjs / ml/train.py filter).
// NEVER sends during quiet hours (00:00–06:00 CT). Due at cfg.digest.send_at CT (08:00).
// Records to pings.jsonl (kind=digest, with cards[] mapping); rotates the queue after send.
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpsConfig, isQuietHoursCT, ctWallTime, scrub } from './lib.mjs';
import { sendTelegram } from './notify.mjs';
import { groupItems, rateGroups, renderDigest } from './cards.mjs';

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

// ── collect: shadow would-ping/unsure + queued items, deduped by sig, priority-sorted ──
export function collectDigestItems({ cfg, now = Date.now() } = {}) {
  const items = [];
  // 1) v2 shadow would-ping / unsure (latest row per sig, last 24h) — enriched for question ranking
  const cut = now - 24 * 3600000;
  const latest = new Map();
  for (const r of readJsonl('jev-v2-shadow.jsonl')) {
    if (!r.sig || !r.v2_decision || new Date(r.ts).getTime() < cut) continue;
    const prev = latest.get(r.sig);
    if (!prev || new Date(r.ts) > new Date(prev.ts)) latest.set(r.sig, r);
  }
  for (const r of latest.values()) {
    if (r.v2_decision === 'ping') items.push({ kind: 'shadow-ping', pri: 0, sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — WOULD have pinged (${r.v2_reason})`, v1_decision: r.v1_decision ?? null, v2_decision: r.v2_decision, confidence: r.confidence ?? null, probs: r.probs ?? null });
    else if (r.v2_decision === 'digest' && /uncertain/i.test(r.v2_reason || '')) items.push({ kind: 'shadow-unsure', pri: 1, sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — unsure (${r.v2_reason})`, v1_decision: r.v1_decision ?? null, v2_decision: r.v2_decision, confidence: r.confidence ?? null, probs: r.probs ?? null });
  }
  // 2) queued items (v1 jev-down / over-cap / send-failed / v2-digest / routine-no-action)
  //    dedupe by sig (keep latest), routine-no-action ranks last so real issues surface first
  const queued = new Map();
  for (const q of readJsonl('digest-queue.jsonl')) {
    const pri = /routine-no-action/i.test(q.reason || '') ? 2 : 1;
    const prev = queued.get(q.sig);
    if (!prev || pri < prev.pri || (pri === prev.pri && (!prev.ts || new Date(q.ts) > new Date(prev.ts)))) {
      queued.set(q.sig, { kind: 'queued', pri, sig: q.sig, source: q.source, program: q.program, count: q.count, sample: q.sample || '', reason: `${q.reason}`, ts: q.ts });
    }
  }
  items.push(...queued.values());
  return items.sort((a, b) => a.pri - b.pri);
}

// ── auto-labels (source:"auto") ──────────────────────────────────────────────
function labelOrigin(r) { return r.source === 'chris' || r.source === 'auto' ? r.source : 'chris'; } // pre-v3 rows: source = event source → human
function chrisLabeledSigs() {
  const s = new Set();
  for (const r of readJsonl('labels.jsonl')) if (labelOrigin(r) === 'chris' && r.sig) s.add(r.sig);
  return s;
}
function appendAutoLabelRows(rows) {
  if (!rows.length) return;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  appendFileSync(join(DATA_DIR, 'labels.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}
// A no-action digest item Chris ignored counts as a weak "didn't need this".
// Only no-action items get this treatment — never infer from silence on action cards.
export function sweepIgnoredNoAction({ now = Date.now(), cutHours = 12 } = {}) {
  const labeled = new Set();
  for (const l of readJsonl('labels.jsonl')) if (l.item_id) labeled.add(l.item_id);
  const rows = [];
  for (const p of readJsonl('pings.jsonl')) {
    if (p.kind !== 'digest' || !Array.isArray(p.cards) || !p.cards.length) continue;   // v3-format rows only
    if (now - new Date(p.ts).getTime() < cutHours * 3600000) continue;
    for (const c of p.cards) {
      if (c.rating !== 'no_action' || c.question) continue;
      for (const it of (p.items || [])) {
        if (!c.sigs?.includes(it.sig) || labeled.has(it.item_id)) continue;
        labeled.add(it.item_id);
        rows.push({ ts: new Date().toISOString(), label: 'noise', via: 'auto', source: 'auto', weight: 0.3,
          auto_reason: 'ignored_no_action', ping_id: p.ping_id, item_id: it.item_id, card_id: c.card_id,
          message_id: p.message_id ?? null, sig: it.sig, event_source: it.source, program: it.program,
          decision: it.decision ?? null, mode: it.mode ?? null, jev: null, features: null });
      }
    }
  }
  appendAutoLabelRows(rows);
  return rows.length;
}

// ── question selection: most useful borderline cards, hard cap ───────────────
export function pickQuestions(groups, { cfg, maxQuestions } = {}) {
  const cap = maxQuestions ?? cfg?.digest?.max_questions ?? 5;
  const actionable = groups.filter(g => g.rating !== 'no_action');
  const scored = actionable.map(g => {
    let score = g.rating === 'needs_attention' ? 100 : 0;
    if (g.meta.some(m => m.v1_decision && m.v2_decision && m.v1_decision !== m.v2_decision)) score += 30;   // v1/v2 disagreement
    const confs = g.meta.map(m => m.confidence).filter(c => typeof c === 'number');
    if (confs.length && Math.max(...confs) < 0.5) score += 20;   // low v2 confidence
    if (g.meta.some(m => m.kind === 'shadow-ping')) score += 10;
    return { g, score };
  });
  scored.sort((a, b) => b.score - a.score || b.g.totalCount - a.g.totalCount);
  return new Set(scored.slice(0, cap).map(s => s.g.key));
}

export async function runDigest({ cfg, send = sendTelegram, now = Date.now(), force = false, rateFn = null } = {}) {
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
  const autoIgnored = sweepIgnoredNoAction({ now });   // yesterday's ignored no-action items → weak auto-labels
  const all = collectDigestItems({ cfg, now });
  if (!all.length) { writeFileSync(stateP, JSON.stringify({ last_sent_date: today, ts: new Date(now).toISOString() })); return { sent: false, why: 'nothing to digest (state marked)', autoIgnored }; }
  const max = cfg.digest.max_items ?? 15;
  const shown = all.slice(0, max);
  const rest = all.length - shown.length;
  const pingId = Math.random().toString(36).slice(2, 6);
  const withIds = shown.map((it, i) => ({ ...it, item_id: `${pingId}.${i + 1}` }));

  // group → rate (Qwen once for the whole digest; template fallback never floods)
  let groups = groupItems(withIds, { cfg });
  for (const g of groups) for (const m of g.meta) if (m.x) m.x.__gkey = g.key;   // item → card mapping for the ledger row
  const rate = rateFn || rateGroups;
  groups = await rate(groups, { cfg });
  // v2-flagged items (would-ping / v1-v2 disagreement) never sink below worth_a_look
  for (const g of groups) {
    if (g.rating === 'no_action' && g.meta.some(m => m.kind === 'shadow-ping' || (m.v1_decision && m.v2_decision && m.v1_decision !== m.v2_decision))) {
      g.rating = 'worth_a_look';
      if (!g.qwen) g.headline = g.headline || 'Activity worth a quick glance — the classifier flagged it as notable.';
    }
  }
  const questionKeys = pickQuestions(groups, { cfg });

  // auto pre-labels for non-question cards (clearly-routine only; never on action cards)
  const chrisSigs = chrisLabeledSigs();
  const preRows = [];
  const keyToGroup = new Map(groups.map(g => [g.key, g]));
  for (const g of groups) {
    if (g.rating !== 'no_action') continue;   // never pre-label worth-a-look / needs-attention cards
    const qOk = g.qwen && g.confidence >= (cfg.digest.prelabel_confidence ?? 0.8);
    for (const m of g.meta) {
      if (chrisSigs.has(m.sig)) continue;
      let reason = null;
      if (qOk) reason = 'qwen_prelabel';
      else if (m.probs && (m.probs.routine_noise ?? 0) >= 0.9 && (m.confidence ?? 0) >= 0.6) reason = 'jev_prelabel';
      if (!reason) continue;
      preRows.push({ ts: new Date().toISOString(), label: 'noise', via: 'auto', source: 'auto', weight: 0.3,
        auto_reason: reason, ping_id: pingId, item_id: m.item_id ?? null, card_id: null,
        message_id: null, sig: m.sig, event_source: m.source, program: m.program,
        decision: m.why ?? null, mode: 'digest-auto', jev: m.probs ? { probs: m.probs, confidence: m.confidence } : null, features: null });
    }
  }
  appendAutoLabelRows(preRows);

  const rendered = renderDigest({ groups, pingId, questionKeys, dateLabel: today, overCount: rest });
  const r = await send(rendered.body, { replyMarkup: rendered.keyboard });
  const messageId = r?.result?.message_id ?? null;
  try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }
  const cardByKey = new Map(rendered.cards.map(c => [c.key, c]));
  appendFileSync(join(DATA_DIR, 'pings.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), ping_id: pingId, message_id: messageId, kind: 'digest', mode: cfg.triage_mode,
    items: withIds.map(it => {
      const g = keyToGroup.get(it.__gkey);
      return { item_id: it.item_id, sig: it.sig, event_source: it.source, source: it.source, program: it.program,
        decision: it.reason, mode: it.kind === 'queued' ? 'v1' : 'shadow', probs: null, confidence: null,
        rating: g?.rating ?? null };
    }),
    cards: rendered.cards.map(c => ({ card_id: c.card_id, key: c.key, title: c.title, rating: c.rating, sigs: c.sigs, item_ids: c.item_ids, question: c.question, qwen: c.qwen })),
    auto_labels: { ignored: autoIgnored, pre: preRows.length },
  }) + '\n');
  writeFileSync(stateP, JSON.stringify({ last_sent_date: today, ts: new Date(now).toISOString() }));
  // rotate the queue (consumed)
  const q = join(DATA_DIR, 'digest-queue.jsonl');
  if (existsSync(q)) { try { mkdirSync(join(DATA_DIR, 'processed'), { recursive: true }); renameSync(q, join(DATA_DIR, 'processed', `digest-queue-${Date.now()}.jsonl`)); } catch { /* keep */ } }
  return { sent: true, ping_id: pingId, items: all.length, shown: shown.length, questions: questionKeys.size, message_id: messageId, autoIgnored, preLabeled: preRows.length };
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
