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

test('friendly names: program match beats source; host suffix appended when not embedded', () => {
  const titleOf = (source, program, host) => cards.groupItems([mkItem(9, { source, program, host })], { cfg: CFG })[0].title;
  assert.equal(titleOf('fortigate', 'utm', 'FGT90G'), 'FortiGate firewall (FGT90G)');
  assert.equal(titleOf('loki', 'vllm-qwen36', 'tr-server'), 'Qwen 3.6 model server (.120)'); // host embedded in map value
  assert.equal(titleOf('app', '', 'aiagent'), 'App on aiagent');
  assert.equal(titleOf('app', '', ''), 'App logs');
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

test('Qwen success: ratings/headlines used; deterministic P0/P1 never downgraded by Qwen', async () => {
  const groups = cards.groupItems([
    mkItem(1, { level: 'P0', why: 'honeytoken string match: CANARY' }),
    mkItem(2, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server', why: 'jev scored novel (benign 0.49 < 0.6)' }),
  ], { cfg: CFG });
  const rated = await cards.rateGroups(groups, { cfg: CFG, qwenFn: async gs => gs.map(() => ({ rating: 'no_action', headline: 'all fine', next_step: '', confidence: 0.99 })) });
  const p0 = rated.find(g => g.hasP0P1);
  assert.equal(p0.rating, 'needs_attention', 'Qwen cannot downgrade P0');
  const other = rated.find(g => !g.hasP0P1);
  assert.equal(other.rating, 'no_action');
  assert.equal(other.qwen, true);
});

// ── rendering ────────────────────────────────────────────────────────────────
test('render: per-card buttons only on action cards; routine groups = ONE summary line; no message-level keyboard', () => {
  const groups = [
    { ...cards.groupItems([mkItem(1)], { cfg: CFG })[0], rating: 'worth_a_look', headline: 'Burst of blocked web traffic.', next_step: '', qwen: true },
    { ...cards.groupItems([mkItem(2, { source: 'loki', program: 'litellm-linux-test', host: 'tr-server' })], { cfg: CFG })[0], rating: 'no_action', headline: 'Routine requests.', next_step: '', qwen: true },
    { ...cards.groupItems([mkItem(3, { source: 'app', program: '', host: 'aiagent' })], { cfg: CFG })[0], rating: 'no_action', headline: 'Routine.', next_step: '', qwen: false },
  ];
  const r = cards.renderPing({ groups, pingId: 'test1', overCap: [], includeRoutine: true });
  assert.ok(r.body.includes('Routine, no action needed: LiteLLM test proxy (tr-server) (5), App on aiagent (5)'), 'single summary line with counts');
  assert.equal(r.cards.length, 1, 'no cards for no_action groups');
  assert.equal(r.keyboard.inline_keyboard.length, 1, 'buttons only under the action card');
  for (const row of r.keyboard.inline_keyboard) {
    for (const b of row) {
      assert.ok(b.callback_data.length <= 64, `callback_data ≤64 bytes (got ${b.callback_data.length})`);
      assert.match(b.callback_data, /^ow:(useful|noise|mute):test1\.g\d+$/);
    }
  }
  assert.deepEqual(r.keyboard.inline_keyboard[0].map(b => b.text), ['Glad you told me', "Didn't need this", 'Stop telling me about this (7 days)']);
  assert.ok(r.body.includes('Tap a button under a card'), 'short feedback hint');
  assert.ok(!r.body.includes('ow noise'), 'old long footer gone');
  const lead = r.body.slice(0, r.body.indexOf('<blockquote'));
  assert.ok(!/benign|jev|P2|\bsig\b/i.test(lead), 'no raw jargon in the lead lines');
  assert.ok(r.body.includes('<blockquote expandable>'), 'raw detail in expandable blockquote');
  assert.ok(r.body.includes('sig'), 'sig ids only in details');
});

test('notify: message-level feedbackKeyboard is GONE', () => {
  assert.equal(notify.feedbackKeyboard, undefined, 'feedbackKeyboard export removed');
});

// ── deliver: volume flag ─────────────────────────────────────────────────────
test('volume flag: no_action groups diverted to digest queue, not sent, not marked; P0 always pings', async () => {
  const pingState = { lastP1: {} };
  const pings = [
    mkItem(1, { level: 'P2', why: 'jev scored novel (benign 0.49 < 0.6)' }),
    mkItem(2, { level: 'P2', why: 'jev scored novel (benign 0.50 < 0.6)' }),
    mkItem(3, { source: 'app', program: '', host: 'x', level: 'P0', why: 'honeytoken string match: CANARY' }),
  ];
  let sentBody = '', sentMarkup = null;
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c1',
    rateFn: noActionFn,   // even if the rater says no_action, the P0 must ping
    send: async (body, opts) => { sentBody = body; sentMarkup = opts?.replyMarkup ?? null; return { result: { message_id: 42 } }; } });
  assert.equal(d.sent.length, 1, 'only the P0 item pinged');
  assert.equal(d.sent[0].verdict.level, 'P0');
  assert.deepEqual(Object.keys(pingState.lastP1), ['sig3'], 'only the pinged sig marked');
  assert.equal(d.diverted.length, 1, 'one routine group diverted');
  assert.ok(sentBody.includes('needs attention'), 'P0 card rendered');
  assert.ok(sentMarkup && sentMarkup.inline_keyboard.length === 1, 'per-card keyboard only');
  const q = readFileSync(join(TMP, 'digest-queue.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(q.filter(r => r.reason === 'routine-no-action').length, 2, 'routine items queued to digest');
});

test('volume flag off ("none"): no_action groups still ping as one summary line', async () => {
  const pingState = { lastP1: {} };
  const cfg = { ...CFG, live_ping_min_rating: 'none' };
  const pings = [mkItem(1), mkItem(2, { program: 'traffic' })];
  let sentBody = '';
  const d = await triage.deliver(pings, { cfg, pingState, live: true, cycleId: 'c2', rateFn: noActionFn,
    send: async (body) => { sentBody = body; return { result: { message_id: 43 } }; } });
  assert.equal(d.sent.length, 2);
  assert.ok(sentBody.includes('Routine, no action needed:'), 'summary line present when flag off');
  assert.ok(sentBody.includes('(10)'), 'grouped counts');
  assert.equal(d.diverted.length, 0);
});

test('deliver: pings.jsonl row carries cards[] mapping (card_id ↔ sigs/item_ids); over-cap line plain', async () => {
  const pingState = { lastP1: {} };
  const pings = Array.from({ length: 14 }, (_, i) => mkItem(i, { program: i % 2 ? 'utm' : 'traffic' }));
  let sentBody = '';
  const d = await triage.deliver(pings, { cfg: CFG, pingState, live: true, cycleId: 'c3', rateFn: worthFn,
    send: async (body) => { sentBody = body; return { result: { message_id: 44 } }; } });
  assert.equal(d.sent.length, 10);
  assert.ok(sentBody.includes('+4 more minor items'), 'plain over-cap line');
  const row = JSON.parse(readFileSync(join(TMP, 'pings.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.equal(row.kind, 'ping');
  assert.ok(Array.isArray(row.cards) && row.cards.length >= 1, 'cards mapping recorded');
  for (const c of row.cards) {
    assert.match(c.card_id, /^\w+\.g\d+$/);
    assert.ok(c.sigs.length >= 1);
    assert.equal(c.item_ids.length, c.sigs.length, 'every sig mapped to an item_id');
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
  let sentBody = '', sentMarkup = null;
  const r = await digest.runDigest({ cfg: CFG, force: true, rateFn: worthFn,
    send: async (body, opts) => { sentBody = body; sentMarkup = opts?.replyMarkup ?? null; return { result: { message_id: 55 } }; } });
  assert.equal(r.sent, true);
  assert.equal(r.questions, 5, 'hard cap 5 questions');
  assert.equal(sentMarkup.inline_keyboard.length, 5, 'buttons only on question cards');
  for (const row of sentMarkup.inline_keyboard) for (const b of row) assert.ok(b.callback_data.length <= 64);
  assert.ok(sentBody.includes('Tap a button under a card'));
  assert.ok(!sentBody.includes('ow missed'), 'old digest footer gone');
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
  // reply phrase → single actionable card resolution
  rmSync(join(TMP, 'labels.jsonl'), { force: true });
  const out2 = runLabel(['--msg', '555', '--label', 'mute', '--via', 'reply']);
  assert.ok(out2.includes('labeled 3 item(s)'), 'reply to a 2-card message labels all actionable cards');
  const mutes = JSON.parse(readFileSync(join(TMP, 'mutes.json'), 'utf8'));
  assert.ok(mutes.sigA && mutes.sigB && mutes.sigC, 'mute applied to every sig in the actionable cards');
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
