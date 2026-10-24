// test/cards.test.mjs — v3 plain-English card layer (2026-10-23).
// Covers: grouping, no-action summary line, per-card buttons only on action cards,
// NO message-level keyboard anywhere, callback_data ≤64 bytes, digest question cap,
// auto-label source fields, label.mjs card_id resolution, Qwen-failure fallback,
// volume flag (P0 always pings, no_action → digest).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.OPSWATCH_DISABLE_QWEN = '1';   // tests never touch the network

const TMP = mkdtempSync(join(tmpdir(), 'opswatch-cards-test-'));
process.env.OPSWATCH_DATA_DIR = TMP;
const cards = await import('../cards.mjs');
const triage = await import('../triage.mjs');
const digest = await import('../digest.mjs');
const lib = await import('../lib.mjs');
const notify = await import('../notify.mjs');

const CFG = lib.loadOpsConfig(join(TMP, 'missing.json'));

function mkItem(i, { source = 'fortigate', program = 'utm', host = 'FGT90G', count = 5, level = 'P2', why = 'jev scored novel (benign 0.55 < 0.6)' } = {}) {
  return { cluster: { sig: `sig${i}`, count, source, program, host, distinct_users: 0, distinct_ips: 1,
    first_seen: '2026-10-23T12:40:00Z', last_seen: '2026-10-23T12:45:00Z', samples: [`sample line ${i}`] },
    verdict: { level, why } };
}
const worthFn = async groups => groups.map(g => ({ ...g, rating: 'worth_a_look', headline: 'Something happened.', next_step: '', confidence: 0.7, qwen: true, fallback: false }));
const noActionFn = async groups => groups.map(g => ({ ...g, rating: 'no_action', headline: 'Routine.', next_step: '', confidence: 0.9, qwen: true, fallback: false }));

// ── grouping ─────────────────────────────────────────────────────────────────
test('grouping: same service (program variants + blank) merges into one card with friendly name', () => {
  const items = [
    mkItem(1, { program: 'utm' }),
    mkItem(2, { program: 'traffic', count: 3 }),
    mkItem(3, { source: 'fortigate', program: '', count: 2 }),
    mkItem(4, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server', count: 4 }),
    mkItem(5, { source: 'app', program: '', host: '', count: 1 }),
  ];
  const groups = cards.groupItems(items, { cfg: CFG });
  assert.equal(groups.length, 3);
  const fg = groups.find(g => g.title.startsWith('FortiGate'));
  assert.ok(fg, 'fortigate friendly name used');
  assert.equal(fg.totalCount, 10, 'utm 5 + traffic 3 + blank 2 merged');
  assert.equal(fg.sigs.length, 3);
  const lt = groups.find(g => g.title.includes('LiteLLM'));
  assert.ok(lt && lt.totalCount === 4);
  const app = groups.find(g => g.title.startsWith('App'));
  assert.ok(app, 'blank app fallback name');
});

test('friendly names: titles carry NO host/serial — friendly name only (host lives in the blockquote)', () => {
  const titleOf = (source, program, host) => cards.groupItems([mkItem(9, { source, program, host })], { cfg: CFG })[0].title;
  assert.equal(titleOf('fortigate', 'utm', 'FGT90GTK23011178'), 'FortiGate firewall');
  assert.equal(titleOf('loki', 'vllm-qwen36', 'tr-server'), 'Qwen 3.6 model server (.120)'); // map value may embed the host hint
  assert.equal(titleOf('app', '', 'aiagent'), 'App on aiagent');
  assert.equal(titleOf('app', '', ''), 'App logs');
  // same friendly name on two hosts → two cards (key separates hosts), same title
  const g2 = cards.groupItems([mkItem(1, { program: 'utm', host: 'FGT-A' }), mkItem(2, { program: 'utm', host: 'FGT-B' })], { cfg: CFG });
  assert.equal(g2.length, 2);
  assert.equal(g2[0].title, g2[1].title);
});

// ── rating fallback (Qwen failure) ───────────────────────────────────────────
test('Qwen failure → template fallback: P0/P1 needs_attention, jev-novel no_action', async () => {
  const groups = cards.groupItems([
    mkItem(1, { level: 'P1', why: 'rule litellm-error-burst: LiteLLM error burst' }),
    mkItem(2, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server', why: 'jev scored novel (benign 0.49 < 0.6)' }),
    mkItem(3, { source: 'app', program: '', host: 'aiagent', why: 'no deterministic signal' }),
  ], { cfg: CFG });
  const boom = async () => { throw new Error('qwen down'); };
  const rated = await cards.rateGroups(groups, { cfg: CFG, qwenFn: boom });
  const byTitle = Object.fromEntries(rated.map(g => [g.title, g]));
  const fg = rated.find(g => g.title.startsWith('FortiGate'));
  assert.equal(fg.rating, 'needs_attention', 'P1 rule hit forced needs_attention even on fallback');
  assert.ok(fg.headline && !/jev|benign|P1|sig/i.test(fg.headline), 'lead line has no jargon');
  assert.equal(rated.filter(g => g.rating === 'no_action').length, 2, 'jev-novel items → no_action on fallback');
  assert.ok(rated.filter(g => !g.hasP0P1).every(g => g.fallback), 'fallback flagged on template-rated groups');
});

test('Qwen success: P0 floor + Qwen writes rule-hit lead lines; Qwen never lowers below the floor', async () => {
  const groups = cards.groupItems([
    mkItem(1, { level: 'P0', why: 'honeytoken string match: CANARY' }),
    mkItem(2, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server', level: 'P1', why: 'rule auth-failures: auth failures across 4 distinct users' }),
    mkItem(3, { source: 'app', program: '', host: 'x', why: 'jev scored novel (benign 0.49 < 0.6)' }),
  ], { cfg: CFG });
  const rated = await cards.rateGroups(groups, { cfg: CFG, qwenFn: async gs => gs.map(g => ({ rating: 'no_action', headline: `qwen says: ${g.title} looks routine`, next_step: 'glance at it', confidence: 0.9 })) });
  const p0 = rated.find(g => g.maxLevel === 'P0');
  assert.equal(p0.rating, 'needs_attention', 'P0 floor: Qwen cannot downgrade');
  assert.equal(p0.qwen, true, 'Qwen still writes the P0 lead line');
  assert.match(p0.headline, /qwen says/);
  const p1 = rated.find(g => g.maxLevel === 'P1');
  assert.equal(p1.rating, 'worth_a_look', 'P1 floor: Qwen no_action raised to worth_a_look');
  assert.match(p1.headline, /qwen says/);
  const other = rated.find(g => !g.hasP0P1);
  assert.equal(other.rating, 'no_action');
});

test('template count consistency: headline uses the signal\'s count, not the group\'s', () => {
  const g = cards.groupItems([mkItem(1, { count: 4, why: 'volume burst: 314 events in window' })], { cfg: CFG })[0];
  assert.match(cards.plainWhy(g.why, { count: g.totalCount, windowMin: 5 }), /314 events/);
});

// ── rendering ────────────────────────────────────────────────────────────────
test('render: ONE card per message, each with its own 3-button row; routine summary only on the last; no header', () => {
  const groups = [
    { ...cards.groupItems([mkItem(1)], { cfg: CFG })[0], rating: 'worth_a_look', headline: 'Burst of blocked web traffic.', next_step: '', qwen: true },
    { ...cards.groupItems([mkItem(2, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server' })], { cfg: CFG })[0], rating: 'needs_attention', headline: 'Errors are piling up.', next_step: 'Check the service.', qwen: true },
    { ...cards.groupItems([mkItem(3, { source: 'app', program: '', host: 'aiagent' })], { cfg: CFG })[0], rating: 'no_action', headline: 'Routine.', next_step: '', qwen: false },
  ];
  const routine = [cards.groupItems([mkItem(3, { source: 'app', program: '', host: 'aiagent' })], { cfg: CFG })[0]];
  const r = cards.renderCardMessages({ groups, pingId: 'test1', overflowCount: 2, routineGroups: routine });
  assert.equal(r.messages.length, 2, 'one message per action card; no_action group has no message');
  for (const m of r.messages) {
    assert.equal(m.keyboard.inline_keyboard.length, 1, 'exactly one button row per message');
    assert.equal(m.keyboard.inline_keyboard[0].length, 3);
    for (const b of m.keyboard.inline_keyboard[0]) {
      assert.ok(b.callback_data.length <= 64, `callback_data ≤64 bytes (got ${b.callback_data.length})`);
      assert.match(b.callback_data, /^ow:(useful|noise|mute):test1\.g\d+$/);
    }
    assert.deepEqual(m.keyboard.inline_keyboard[0].map(b => b.text), ['Glad you told me', "Didn't need this", 'Stop telling me about this (7 days)']);
    assert.ok(!m.body.includes('ops-watch —'), 'no header — the card is the message');
  }
  for (const m of r.messages.slice(0, -1)) {
    assert.ok(!m.body.includes('Routine, no action needed'), 'routine summary NOT on earlier cards');
    assert.ok(!m.body.includes('Tap a button'), 'hint not repeated on earlier cards');
  }
  const last = r.messages.at(-1).body;
  assert.ok(last.includes('+2 more to check — in the 8am digest'), 'overflow line on last card');
  assert.ok(last.includes('Routine, no action needed: App on aiagent (5)'), 'routine summary ONCE, on the last card');
  assert.ok(last.includes('Tap a button under a card'), 'hint on last card');
  const lead = r.messages[0].body.slice(0, r.messages[0].body.indexOf('<blockquote'));
  assert.ok(!/benign|jev|P2|\bsig\b|FGT|host/i.test(lead), 'no raw jargon or host in the lead lines');
  assert.ok(r.messages[0].body.includes('<blockquote expandable>'), 'raw detail in expandable blockquote');
  assert.ok(r.messages[0].body.includes('host FGT90G'), 'host lives in the blockquote');
});

test('notify: message-level feedbackKeyboard is GONE', () => {
  assert.equal(notify.feedbackKeyboard, undefined, 'feedbackKeyboard export removed');
});

// ── deliver: volume flag ─────────────────────────────────────────────────────
test('volume flag: ALL-diverted cycle still queues routine items (no silent drop on early return)', async () => {
  rmSync(join(TMP, 'digest-queue.jsonl'), { force: true });
  const pingState = { lastP1: {} };
  const pings = [mkItem(1), mkItem(2, { program: 'traffic' }), mkItem(3, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server' })];
  let sent = 0;
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c4', rateFn: noActionFn,
    send: async () => { sent++; return { result: { message_id: 45 } }; } });
  assert.equal(d.sent.length, 0, 'nothing pinged');
  assert.equal(sent, 0, 'no telegram send at all');
  assert.equal(d.diverted.length, 2, 'both groups diverted');
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(q.length, 3, 'all diverted items queued — even with zero ping candidates');
  assert.ok(q.every(r => r.reason === 'routine-no-action'));
});

test('volume flag: no_action groups diverted to digest queue, not sent, not marked; P0 always pings', async () => {
  rmSync(join(TMP, 'digest-queue.jsonl'), { force: true });
  const pingState = { lastP1: {} };
  const pings = [
    mkItem(1, { level: 'P2', why: 'jev scored novel (benign 0.49 < 0.6)' }),
    mkItem(2, { level: 'P2', why: 'jev scored novel (benign 0.50 < 0.6)' }),
    mkItem(3, { source: 'app', program: '', host: 'x', level: 'P0', why: 'honeytoken string match: CANARY' }),
  ];
  let sends = [];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c1',
    rateFn: noActionFn,   // even if the rater says no_action, the P0 must ping
    send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 42 + sends.length } }; } });
  assert.equal(d.sent.length, 1, 'only the P0 item pinged');
  assert.equal(d.sent[0].verdict.level, 'P0');
  assert.deepEqual(Object.keys(pingState.lastP1), ['sig3'], 'only the pinged sig marked');
  assert.equal(d.diverted.length, 1, 'one routine group diverted');
  assert.equal(sends.length, 1, 'one card = one message');
  assert.ok(sends[0].body.includes('needs attention'), 'P0 card rendered');
  assert.ok(sends[0].markup && sends[0].markup.inline_keyboard.length === 1, 'per-card keyboard only');
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(q.filter(r => r.reason === 'routine-no-action').length, 2, 'routine items queued to digest');
});

test('deliver: multiple action cards → one Telegram message EACH, one button row per message (no ambiguity)', async () => {
  rmSync(join(TMP, 'pings.jsonl'), { force: true });
  rmSync(join(TMP, 'digest-queue.jsonl'), { force: true });
  const pingState = { lastP1: {} };
  const pings = [
    mkItem(1, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server' }),
    mkItem(2, { source: 'loki', program: 'openclaw-gateway', host: 'm5max' }),
    mkItem(3, { source: 'app', program: '', host: 'aiagent', level: 'P1', why: 'rule auth-failures: auth failures across 3 distinct users' }),
  ];
  const sends = [];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c5', rateFn: worthFn,
    send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 100 + sends.length } }; } });
  assert.equal(d.sent.length, 3);
  assert.equal(sends.length, 3, '3 cards = 3 separate messages');
  for (const s of sends) {
    assert.equal(s.markup.inline_keyboard.length, 1, 'each message carries exactly ONE card\'s buttons');
    assert.equal(s.markup.inline_keyboard[0].length, 3);
  }
  const ids = new Set(sends.map(s => s.markup.inline_keyboard[0][0].callback_data));
  assert.equal(ids.size, 3, 'each message targets a different card_id');
  assert.ok(new Set(sends.map(s => s.body)).size === 3, 'bodies distinct');
  const row = JSON.parse(readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(row.cards.length, 3);
  assert.deepEqual(row.cards.map(c => c.message_id), [101, 102, 103], 'per-card message_ids recorded');
  assert.equal(row.message_id, 101, 'row-level message_id = first card (back-compat)');
});

test('deliver: card overflow → queued to digest, +N more line on last message only', async () => {
  rmSync(join(TMP, 'pings.jsonl'), { force: true });
  rmSync(join(TMP, 'digest-queue.jsonl'), { force: true });
  const pingState = { lastP1: {} };
  const pings = Array.from({ length: 14 }, (_, i) => mkItem(i, { source: `src${i}`, program: `prog${i}` }));   // 14 distinct services → 14 cards
  const sends = [];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c6', rateFn: worthFn,
    send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 200 + sends.length } }; } });
  assert.equal(sends.length, 10, 'capped at pings.max_per_cycle card messages');
  assert.equal(d.sent.length, 10);
  assert.equal(d.overCap.length, 4, 'overflow cards go to digest');
  assert.ok(sends.at(-1).body.includes('+4 more to check — in the 8am digest'), 'overflow line on last message');
  assert.ok(!sends.slice(0, -1).some(s => s.body.includes('more to check')), 'overflow line not repeated');
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(q.filter(r => r.reason === 'over-cap').length, 4);
});

test('volume flag off ("none"): no diversion — routine groups ping as full cards (escape hatch)', async () => {
  const pingState = { lastP1: {} };
  const cfg = { ...CFG, live_ping_min_rating: 'none' };
  const pings = [mkItem(1), mkItem(2, { program: 'traffic' }), mkItem(3, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server' })];
  const sends = [];
  const d = await triage.deliver(pings, { cfg, pingState, live: true, cycleId: 'c2', rateFn: noActionFn,
    send: async (body) => { sends.push(body); return { result: { message_id: 43 } }; } });
  assert.equal(d.sent.length, 3);
  assert.equal(sends.length, 2, 'two cards (fortigate merged, litellm)');
  assert.ok(sends.every(b => b.includes('worth a look')), 'flag off upgrades routine groups to pingable cards');
  assert.equal(d.diverted.length, 0, 'no diversion when flag off');
});

test('deliver: pings.jsonl row carries cards[] mapping (card_id ↔ sigs/item_ids); overflow line plain', async () => {
  rmSync(join(TMP, 'pings.jsonl'), { force: true });
  const pingState = { lastP1: {} };
  const pings = Array.from({ length: 12 }, (_, i) => mkItem(i, { source: `src${i}`, program: `svc${i}` }));
  const sends = [];
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c3', rateFn: worthFn,
    send: async (body) => { sends.push(body); return { result: { message_id: 44 } }; } });
  assert.equal(d.sent.length, 10);
  assert.ok(sends.at(-1).includes('+2 more to check'), 'plain over-cap line');
  const row = JSON.parse(readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(row.kind, 'ping');
  assert.ok(Array.isArray(row.cards) && row.cards.length === 10, 'cards mapping recorded');
  for (const c of row.cards) {
    assert.match(c.card_id, /^\w+\.g\d+$/);
    assert.ok(c.sigs.length >= 1);
    assert.equal(c.item_ids.length, c.sigs.length, 'every sig mapped to an item_id');
    assert.ok(c.message_id != null, 'per-card message_id recorded');
  }
  const allSigs = row.cards.flatMap(c => c.sigs);
  assert.equal(new Set(allSigs).size, 10, 'cards cover all sent items');
});

// ── digest: question cap + auto-labels ───────────────────────────────────────
function seedDigest({ queue = [], shadow = [], labels = [], digestPings = [] } = {}) {
  writeFileSync(join(TMP, 'digest-queue.jsonl'), queue.map(q => JSON.stringify(q)).join('\n') + (queue.length ? '\n' : ''));
  writeFileSync(join(TMP, 'jev-v2-shadow.jsonl'), shadow.map(s => JSON.stringify(s)).join('\n') + (shadow.length ? '\n' : ''));
  writeFileSync(join(TMP, 'labels.jsonl'), labels.map(l => JSON.stringify(l)).join('\n') + (labels.length ? '\n' : ''));
  writeFileSync(join(TMP, 'pings.jsonl'), digestPings.map(p => JSON.stringify(p)).join('\n') + (digestPings.length ? '\n' : ''));
}

test('digest: question cap = 5 (config knob), buttons only on questions, routine summary line, no message keyboard', async () => {
  // 8 borderline shadow-ping items across 8 distinct services → only 5 questions
  const shadow = Array.from({ length: 8 }, (_, i) => ({
    ts: new Date(Date.now() - 3600000).toISOString(), cycle_id: 'c', mode: 'shadow', sig: `s${i}`,
    source: 'svc' + i, program: '', count: 3, v2_decision: 'ping', v2_reason: 'operational_fault p=0.7 (conf 0.6)',
    v1_decision: 'hold', probs: { routine_noise: 0.1, operational_fault: 0.7 }, confidence: 0.6,
    features: { samples: [`sample ${i}`] },
  }));
  seedDigest({ shadow });
  const sends = [];
  const r = await digest.runDigest({ cfg: CFG, force: true, rateFn: worthFn,
    send: async (body, opts) => { sends.push({ body, markup: opts?.replyMarkup ?? null }); return { result: { message_id: 55 + sends.length } }; } });
  assert.equal(r.sent, true);
  assert.equal(r.questions, 5, 'hard cap 5 questions');
  assert.equal(sends.length, 6, '1 body + 5 question messages');
  assert.equal(sends[0].markup, null, 'body message has NO buttons');
  const qSends = sends.slice(1);
  assert.equal(qSends.length, 5, 'buttons only on question messages');
  for (const s of qSends) {
    assert.equal(s.markup.inline_keyboard.length, 1, 'one card per question message');
    for (const b of s.markup.inline_keyboard[0]) assert.ok(b.callback_data.length <= 64);
  }
  assert.ok(sends[0].body.includes('Tap a button under a card'));
  assert.ok(!sends[0].body.includes('ow missed'), 'old digest footer gone');
  const row = JSON.parse(readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim());
  assert.equal(row.kind, 'digest');
  assert.equal(row.cards.filter(c => c.question).length, 5);
  assert.equal(row.items.length, 8);
});

test('digest: pre-labels (qwen/jev) + ignored_no_action sweep → source:"auto", weight 0.3, human rows source:"chris"', async () => {
  const now = Date.now();
  // one clearly-routine digest card (qwen high conf) + one old digest row with unlabeled no-action card
  const shadow = [{ ts: new Date(now - 3600000).toISOString(), cycle_id: 'c', mode: 'shadow', sig: 'q1', source: 'app', program: '', count: 2,
    v2_decision: 'digest', v2_reason: 'uncertain', v1_decision: 'digest', probs: { routine_noise: 0.95 }, confidence: 0.7, features: { samples: ['x'] } }];
  const oldDigestPing = { ts: new Date(now - 26 * 3600000).toISOString(), ping_id: 'old1', message_id: 999, kind: 'digest', mode: 'shadow',
    items: [{ item_id: 'old1.1', sig: 'q1', source: 'app', program: '', decision: 'r', mode: 'shadow' },
            { item_id: 'old1.2', sig: 'act1', source: 'loki', program: 'litellm-linux-test', decision: 'r', mode: 'shadow' }],
    cards: [{ card_id: 'old1.g1', title: 'App', rating: 'no_action', sigs: ['q1'], item_ids: ['old1.1'], question: false },
            { card_id: 'old1.g2', title: 'LiteLLM test proxy', rating: 'worth_a_look', sigs: ['act1'], item_ids: ['old1.2'], question: true }] };
  seedDigest({ shadow, digestPings: [oldDigestPing] });
  let sentBody = '';
  const r = await digest.runDigest({ cfg: CFG, force: true, rateFn: async gs => gs.map(g => ({ ...g, rating: 'no_action', headline: 'routine', next_step: '', confidence: 0.9, qwen: true, fallback: false })),
    send: async (body) => { sentBody = body; return { result: { message_id: 56 } }; } });
  assert.equal(r.sent, true);
  assert.ok(sentBody.includes('Routine, no action needed:'), 'routine summary line in digest');
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ignored = rows.find(x => x.auto_reason === 'ignored_no_action');
  assert.ok(ignored, 'old no-action digest item swept as ignored');
  assert.equal(ignored.source, 'auto');
  assert.equal(ignored.weight, 0.3);
  assert.equal(ignored.item_id, 'old1.1');
  assert.equal(ignored.label, 'noise');
  // act1 was on a QUESTION card (worth_a_look) — silence must NEVER auto-label it
  assert.ok(!rows.some(x => x.item_id === 'old1.2'), 'no ignored-treatment for action cards');
  const pre = rows.filter(x => x.auto_reason === 'qwen_prelabel' || x.auto_reason === 'jev_prelabel');
  assert.ok(pre.length >= 1, 'qwen/jev prelabel applied');
  assert.ok(pre.every(x => x.source === 'auto' && x.weight === 0.3));
});

test('digest: pre-labels skipped when Chris already labeled the sig; question cards never pre-labeled', async () => {
  const now = Date.now();
  const shadow = [{ ts: new Date(now - 3600000).toISOString(), cycle_id: 'c', mode: 'shadow', sig: 'q2', source: 'app', program: '', count: 2,
    v2_decision: 'digest', v2_reason: 'uncertain', v1_decision: 'ping', probs: { routine_noise: 0.95 }, confidence: 0.7, features: { samples: ['x'] } }];
  seedDigest({ shadow, labels: [{ ts: new Date(now - 7200000).toISOString(), label: 'useful', via: 'button', source: 'chris', weight: 1, sig: 'q2' }] });
  const r = await digest.runDigest({ cfg: CFG, force: true, rateFn: async gs => gs.map(g => ({ ...g, rating: 'no_action', headline: 'routine', next_step: '', confidence: 0.95, qwen: true, fallback: false })),
    send: async () => ({ result: { message_id: 57 } }) });
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(!rows.some(x => x.sig === 'q2' && x.source === 'auto'), 'chris label wins — no auto row for q2');
  assert.equal(r.preLabeled, 0);
});

// ── label.mjs: card resolution + origin fields ───────────────────────────────
const LABEL = new URL('../label.mjs', import.meta.url).pathname;
function runLabel(args) {
  return execFileSync(process.execPath, [LABEL, ...args], { env: { ...process.env, OPSWATCH_DATA_DIR: TMP }, encoding: 'utf8' });
}
test('label.mjs --card resolves every sig in the card; mute writes mutes for all of them; rows are source:"chris"', () => {
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  rmSync(join(TMP, 'mutes.json'), { force: true });
  const PING = { ts: '2026-10-23T18:00:00Z', ping_id: 'kk01', message_id: 555, kind: 'ping', mode: 'v1',
    items: [
      { item_id: 'kk01.1', sig: 'sigA', source: 'fortigate', program: 'utm', level: 'P2', decision: 'why-a', mode: 'v1' },
      { item_id: 'kk01.2', sig: 'sigB', source: 'fortigate', program: 'traffic', level: 'P2', decision: 'why-b', mode: 'v1' },
      { item_id: 'kk01.3', sig: 'sigC', source: 'loki', program: 'litellm-linux-test', level: 'P2', decision: 'why-c', mode: 'v1' },
    ],
    cards: [
      { card_id: 'kk01.g1', title: 'FortiGate firewall', rating: 'worth_a_look', sigs: ['sigA', 'sigB'], item_ids: ['kk01.1', 'kk01.2'], question: true },
      { card_id: 'kk01.g2', title: 'LiteLLM test proxy', rating: 'worth_a_look', sigs: ['sigC'], item_ids: ['kk01.3'], question: true },
    ] };
  writeFileSync(join(TMP, 'pings.jsonl'), JSON.stringify(PING) + '\n');
  const out = runLabel(['--card', 'kk01.g1', '--label', 'noise', '--via', 'button']);
  assert.ok(out.includes('card(s) kk01.g1'));
  assert.ok(out.includes('labeled 2 item(s)'));
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.source === 'chris' && r.weight === 1 && r.card_id === 'kk01.g1' && r.label === 'noise'));
  assert.ok(rows.every(r => r.event_source === 'fortigate'), 'event source preserved in event_source field');
  // reply phrase on a message with 2 actionable cards → AMBIGUOUS, exit 3 (Jarvon asks, never guesses)
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  let code = 0, err = '';
  try { runLabel(['--msg', '555', '--label', 'mute', '--via', 'reply']); } catch (e) { code = e.status; err = e.stderr; }
  assert.equal(code, 3, 'ambiguous reply exits 3');
  assert.match(err, /AMBIGUOUS/);
  assert.ok(!existsSync(join(TMP, 'labels.jsonl')), 'nothing labeled on ambiguous reply');
  // v3.1: per-card message_ids → reply to a card's OWN message resolves exactly that card
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  const PING2 = { ...PING, cards: [
    { card_id: 'kk01.g1', title: 'FortiGate firewall', rating: 'worth_a_look', sigs: ['sigA', 'sigB'], item_ids: ['kk01.1', 'kk01.2'], question: true, message_id: 900 },
    { card_id: 'kk01.g2', title: 'LiteLLM test proxy', rating: 'worth_a_look', sigs: ['sigC'], item_ids: ['kk01.3'], question: true, message_id: 901 },
  ] };
  writeFileSync(join(TMP, 'pings.jsonl'), JSON.stringify(PING2) + '\n');
  const out2 = runLabel(['--msg', '901', '--label', 'useful', '--via', 'reply']);
  assert.ok(out2.includes('labeled 1 item(s)') && out2.includes('kk01.g2'), 'reply to card message → that card only');
  const rows2 = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows2[0].card_id, 'kk01.g2');
  assert.equal(rows2[0].sig, 'sigC');
  // mute via --card writes mutes for all card sigs
  rmSync(join(TMP, 'labels.jsonl'), { force: true }); rmSync(join(TMP, 'mutes.json'), { force: true });
  runLabel(['--card', 'kk01.g1', '--label', 'mute', '--via', 'button']);
  const mutes = JSON.parse(readFileSync(join(TMP, 'mutes.json'), 'utf8'));
  assert.ok(mutes.sigA && mutes.sigB, 'mute applied to every sig in the card');
  // old alias still works: --ping + --item
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  const out3 = runLabel(['--ping', 'kk01', '--item', 'kk01.3', '--label', 'useful', '--via', 'reply']);
  assert.ok(out3.includes('labeled 1 item(s)'));
  const rows3 = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows3[0].item_id, 'kk01.3');
  assert.equal(rows3[0].card_id, null, 'item-level alias has no card scope');
});

test('label.mjs: reply on a no-action-only message labels whole message (legacy behavior preserved)', () => {
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  const PING = { ts: '2026-10-23T18:00:00Z', ping_id: 'kk02', message_id: 556, kind: 'ping', mode: 'v1',
    items: [{ item_id: 'kk02.1', sig: 'sigD', source: 'app', program: '', level: 'P2', decision: 'why', mode: 'v1' }],
    cards: [{ card_id: 'kk02.g1', title: 'App', rating: 'no_action', sigs: ['sigD'], item_ids: ['kk02.1'], question: false }] };
  writeFileSync(join(TMP, 'pings.jsonl'), JSON.stringify(PING) + '\n');
  const out = runLabel(['--msg', '556', '--label', 'noise', '--via', 'reply']);
  assert.ok(out.includes('whole message'));
  const rows = readFileSync(join(TMP, 'labels.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
});
