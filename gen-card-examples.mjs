#!/usr/bin/env node
// gen-card-examples.mjs — build example rendered cards from REAL recent clusters (2026-10-23).
// Pulls the latest ping items + shadow samples from .110, runs them through the ACTUAL new
// render path (groupItems → rateGroups with live Qwen unless OPSWATCH_DISABLE_QWEN=1 →
// renderPing/renderDigest), and writes a markdown report Chris can read.
// Scrubbing for the FILE: secrets scrub() + RFC1918 LAN-IP masking (the live Telegram path
// keeps LAN IPs since it's Chris's own egress; the committed file masks them).
//   node gen-card-examples.mjs [--out ~/clawd/ops/reports/opswatch-card-examples.md] [--no-qwen]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, loadOpsConfig } from './lib.mjs';
import { groupItems, rateGroups, renderPing, renderDigest } from './cards.mjs';
import { pickQuestions } from './digest.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null;
const noQwen = args.includes('--no-qwen') || process.env.OPSWATCH_DISABLE_QWEN === '1';
if (noQwen) process.env.OPSWATCH_DISABLE_QWEN = '1';
const HOST = 'chris@192.168.5.110';

function sshCat(file) {
  try {
    return execFileSync('ssh', ['-o', 'ConnectTimeout=8', HOST,
      `docker exec ops-watch sh -c 'cat data/${file} 2>/dev/null'`], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { console.error(`ssh cat ${file} failed: ${e.message}`); return ''; }
}
function jsonl(s) {
  const out = [];
  for (const l of String(s).split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}
// committed-file scrub: secrets + LAN IPs (build-examples pattern)
const fileScrub = s => scrub(String(s))
  .replace(/\b(?:192\.168|10)(?:\.\d+){2}\b/g, '<lan-ip>')
  .replace(/\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}\b/g, '<lan-ip>');

const cfg = loadOpsConfig();

// ── pull real data ───────────────────────────────────────────────────────────
const pings = jsonl(sshCat('pings.jsonl')).filter(p => p.kind === 'ping');
const shadowRows = jsonl(sshCat('jev-v2-shadow.jsonl'));
const shadowBySig = new Map();
for (const r of shadowRows) if (r.sig && r.features?.samples?.length) shadowBySig.set(r.sig, r);

// pick the latest real ping with ≥3 items
const ping = [...pings].reverse().find(p => (p.items || []).length >= 3);
if (!ping) { console.error('no recent ping found'); process.exit(1); }
const items = (ping.items || []).slice(0, 8).map(it => {
  const sh = shadowBySig.get(it.sig);
  const f = sh?.features || {};
  return {
    cluster: { sig: it.sig, source: it.source, program: it.program || '', host: f.host || 'n/a',
      count: it.level ? (sh?.count ?? 3) : 3, distinct_users: f.distinct_users ?? 0, distinct_ips: f.distinct_ips ?? 1,
      first_seen: f.first_seen || sh?.ts || new Date().toISOString(), last_seen: f.last_seen || sh?.ts || new Date().toISOString(),
      samples: (f.samples || [it.decision]).slice(0, 3) },
    verdict: { level: it.level || 'P2', why: it.decision || 'no deterministic signal' },
  };
});

console.error(`building ping cards from ping ${ping.ping_id} (${items.length} items)...`);
const t0 = Date.now();
const groups = groupItems(items, { cfg, windowMin: 5 });
const rated = await rateGroups(groups, { cfg, windowMin: 5 });
const qwenMs = Date.now() - t0;
const rendered = renderPing({ groups: rated, pingId: 'ex01', overCap: [], includeRoutine: true });

// action-card example: a REAL P1 rule-hit from recent pings + one jev-novel P2, same pipeline
const p1item = [...pings].reverse().flatMap(p => p.items || []).find(it => it.level === 'P1');
let actionPart = '(no recent P1 item found)';
let actionCards = [];
if (p1item) {
  const sh = shadowBySig.get(p1item.sig);
  const f = sh?.features || {};
  const aItems = [
    { cluster: { sig: p1item.sig, source: p1item.source, program: p1item.program || '', host: f.host || 'n/a',
      count: sh?.count ?? 12, distinct_users: f.distinct_users ?? 0, distinct_ips: f.distinct_ips ?? 1,
      first_seen: f.first_seen || new Date().toISOString(), last_seen: f.last_seen || new Date().toISOString(),
      samples: (f.samples || [p1item.decision]).slice(0, 3) },
      verdict: { level: 'P1', why: p1item.decision || 'rule hit' } },
    ...items.filter(x => x.verdict.level === 'P2').slice(0, 2),
  ];
  const aGroups = groupItems(aItems, { cfg, windowMin: 5 });
  const aRated = await rateGroups(aGroups, { cfg, windowMin: 5 });
  const aRendered = renderPing({ groups: aRated, pingId: 'ex02', overCap: [], includeRoutine: true });
  actionPart = aRendered.body;
  actionCards = aRendered.cards;
}

// ── digest example: real shadow would-ping/unsure rows ──────────────────────
const cut = Date.now() - 24 * 3600000;
const latest = new Map();
for (const r of shadowRows) {
  if (!r.sig || !r.v2_decision || new Date(r.ts).getTime() < cut) continue;
  const prev = latest.get(r.sig);
  if (!prev || new Date(r.ts) > new Date(prev.ts)) latest.set(r.sig, r);
}
const dItems = [];
for (const r of latest.values()) {
  if (r.v2_decision === 'ping') dItems.push({ kind: 'shadow-ping', pri: 0, sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — WOULD have pinged (${r.v2_reason})`, v1_decision: r.v1_decision, v2_decision: r.v2_decision, confidence: r.confidence, probs: r.probs });
  else if (r.v2_decision === 'digest' && /uncertain/i.test(r.v2_reason || '')) dItems.push({ kind: 'shadow-unsure', pri: 1, sig: r.sig, source: r.source, program: r.program, count: r.count, sample: r.features?.samples?.[0] || '', reason: `v2 shadow — unsure (${r.v2_reason})`, v1_decision: r.v1_decision, v2_decision: r.v2_decision, confidence: r.confidence, probs: r.probs });
}
dItems.sort((a, b) => a.pri - b.pri);
const dShown = dItems.slice(0, 10).map((it, i) => ({ ...it, item_id: `dex01.${i + 1}` }));
let digestPart = '(no shadow items in last 24h)';
if (dShown.length) {
  const dGroups0 = groupItems(dShown, { cfg });
  const dRated = await rateGroups(dGroups0, { cfg, windowMin: 5 });
  for (const g of dRated) if (g.rating === 'no_action' && g.meta.some(m => m.kind === 'shadow-ping')) g.rating = 'worth_a_look';
  const qKeys = pickQuestions(dRated, { cfg });
  const dr = renderDigest({ groups: dRated, pingId: 'dex01', questionKeys: qKeys, dateLabel: '2026-10-24', overCount: Math.max(0, dItems.length - dShown.length) });
  digestPart = dr.body;
}

// ── render markdown (scrub for the committed file) ──────────────────────────
const clean = s => fileScrub(s);
const cbLens = [...rendered.cards, ...actionCards].flatMap(c => ['useful', 'noise', 'mute'].map(l => `ow:${l}:${c.card_id}`.length));
const cbRange = cbLens.length ? `${Math.min(...cbLens)}–${Math.max(...cbLens)} bytes` : 'n/a';
const today = new Date().toISOString().slice(0, 10);
const md = `# ops-watch plain-English cards — examples (generated ${today})

Built from REAL clusters on .110 (ping \`${ping.ping_id}\` + last-24h v2 shadow rows), run through the actual
new render path (cards.mjs: groupItems → rateGroups → renderPing/renderDigest).
Qwen: ${noQwen ? 'DISABLED (--no-qwen → template fallback shown)' : `LIVE via LiteLLM .120:4010 (batch call took ${qwenMs}ms per card set)`}.
IPs/secret-shaped strings scrubbed for this file (live Telegram path keeps LAN IPs; secrets always scrubbed).

---

## 1) A routine cycle — what the volume flag does (ping \`${ping.ping_id}\`, 8 jev-novel items)

With \`live_ping_min_rating: "worth_a_look"\` (default ON) this ENTIRE cycle is rated routine → **nothing is sent to
Telegram**; the groups below collapse into the digest's one summary line. Rendered here with \`includeRoutine\` so you
can see the collapse:

\`\`\`text
${clean(rendered.body)}
\`\`\`

(In production this message is never sent when zero cards rate action-worthy — the items go to the 8am digest instead.)

---

## 2) A ping with an action card — real P1 rule hit + borderline items

\`\`\`text
${clean(actionPart)}
\`\`\`

Buttons (per card, only on action cards): \`[Glad you told me] [Didn't need this] [Stop telling me about this (7 days)]\`
→ callback_data \`ow:useful:<card_id>\` / \`ow:noise:<card_id>\` / \`ow:mute:<card_id>\` (${cbRange}, all ≤64).

### Card data (pings.jsonl \`cards[]\` mapping)
${JSON.stringify(actionCards.map(c => ({ card_id: c.card_id, title: clean(c.title), rating: c.rating, sigs: c.sigs, question: c.question, qwen: c.qwen })), null, 2)}

---

## 3) No-action summary line (groups rated routine collapse into ONE line — shown in digest, or in pings when \`live_ping_min_rating\` is off)

From example 1, the routine groups collapse to:

\`\`\`text
${clean(rendered.body.split('\n\n').find(l => l.startsWith('✅')) || '(no routine groups in this example)')}
\`\`\`

---

## 4) 8am digest with capped questions (same generator)

\`\`\`text
${clean(digestPart)}
\`\`\`

Only the question cards carry buttons (hard cap: \`digest.max_questions\` = ${cfg.digest?.max_questions ?? 5}/day).
Everything else is auto-labeled: \`source:"auto"\`, \`weight:0.3\`, \`auto_reason\` ∈ ignored_no_action / qwen_prelabel / jev_prelabel.
Chris's own labels: \`source:"chris"\`, \`weight:1\`.

---

## Ratings glossary (the only three words Chris sees)
- **needs attention** — act soon (every P0/P1 rule hit lands here, Qwen can never downgrade it)
- **worth a look** — minor, glance when convenient
- **no action needed** — routine; digest-only, no buttons, no card
`;
const outPath = outArg || '/Users/chrismacfarland/clawd/ops/reports/opswatch-card-examples.md';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(`examples written: ${outPath} (qwen ${noQwen ? 'off' : `on, ${qwenMs}ms`}, ping groups ${rated.length}, digest items ${dShown.length})`);
