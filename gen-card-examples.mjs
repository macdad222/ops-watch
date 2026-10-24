#!/usr/bin/env node
// gen-card-examples.mjs — build example rendered cards from REAL recent clusters (2026-10-23, v3.1).
// Pulls the latest ping items + shadow samples from .110, runs them through the ACTUAL new
// render path (groupItems → rateGroups with live Qwen unless OPSWATCH_DISABLE_QWEN=1 →
// renderCardMessages/renderDigestMessages), and writes a markdown report Chris can read.
// Scrubbing for the FILE: secrets scrub() + RFC1918 LAN-IP masking (the live Telegram path
// keeps LAN IPs since it's Chris's own egress; the committed file masks them).
//   node gen-card-examples.mjs [--out ~/clawd/ops/reports/opswatch-card-examples.md] [--no-qwen]
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub, loadOpsConfig } from './lib.mjs';
import { groupItems, rateGroups, renderCardMessages, renderDigestMessages } from './cards.mjs';
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

const mkClusterItem = (it, sh) => ({
  cluster: { sig: it.sig, source: it.source, program: it.program || '', host: sh?.features?.host || 'n/a',
    count: sh?.count ?? 3, distinct_users: sh?.features?.distinct_users ?? 0, distinct_ips: sh?.features?.distinct_ips ?? 1,
    first_seen: sh?.features?.first_seen || sh?.ts || new Date().toISOString(), last_seen: sh?.features?.last_seen || sh?.ts || new Date().toISOString(),
    samples: (sh?.features?.samples || [it.decision]).slice(0, 3) },
  verdict: { level: it.level || 'P2', why: it.decision || 'no deterministic signal' },
});

// Example A: a real P1 rule-hit cluster (Qwen now writes its lead line, floor keeps the rating)
const p1item = [...pings].reverse().flatMap(p => p.items || []).find(it => it.level === 'P1');
// Example B: real borderline (jev-novel) clusters from the latest ping
const ping = [...pings].reverse().find(p => (p.items || []).length >= 3);
if (!ping && !p1item) { console.error('no recent ping/P1 found'); process.exit(1); }
const novelItems = ping ? (ping.items || []).filter(it => it.level === 'P2').slice(0, 4).map(it => mkClusterItem(it, shadowBySig.get(it.sig))) : [];

const t0 = Date.now();
let routineGroups = [], actionMessages = [];
{
  const items = [];
  if (p1item) items.push(mkClusterItem(p1item, shadowBySig.get(p1item.sig)));
  items.push(...novelItems);
  const groups = groupItems(items, { cfg, windowMin: 5 });
  const rated = await rateGroups(groups, { cfg, windowMin: 5 });
  routineGroups = rated.filter(g => g.rating === 'no_action');
  const r = renderCardMessages({ groups: rated, pingId: 'ex01', overflowCount: 0, routineGroups });
  actionMessages = r.messages;
}
const qwenMs = Date.now() - t0;

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
let digestBody = '(no shadow items in last 24h)', digestQuestion = '(no question in this example)';
if (dShown.length) {
  const dGroups = groupItems(dShown, { cfg });
  const dRated = await rateGroups(dGroups, { cfg, windowMin: 5 });
  for (const g of dRated) if (g.rating === 'no_action' && g.meta.some(m => m.kind === 'shadow-ping')) g.rating = 'worth_a_look';
  const qKeys = pickQuestions(dRated, { cfg });
  const dr = renderDigestMessages({ groups: dRated, pingId: 'dex01', questionKeys: qKeys, dateLabel: '2026-10-24', overCount: Math.max(0, dItems.length - dShown.length) });
  digestBody = dr.body.body;
  if (dr.questions.length) digestQuestion = dr.questions[0].body + '\n\n[buttons: Glad you told me | Didn\'t need this | Stop telling me about this (7 days)]';
}

// ── render markdown (scrub for the committed file) ──────────────────────────
const clean = s => fileScrub(s);
const today = new Date().toISOString().slice(0, 10);
const msgText = (m) => `${m.body}\n\n[buttons: ${m.keyboard.inline_keyboard[0].map(b => b.text).join(' | ')}]`;
const md = `# ops-watch plain-English cards — examples (generated ${today}, v3.1 one-card-per-message)

Built from REAL clusters on .110 (latest ping + last-24h v2 shadow rows), run through the actual
new render path (cards.mjs: groupItems → rateGroups → renderCardMessages/renderDigestMessages).
Qwen: ${noQwen ? 'DISABLED (--no-qwen → template fallback shown)' : `LIVE via LiteLLM .120:4010 (batch call took ${qwenMs}ms per card set)`}.
IPs/serials/secret-shaped strings scrubbed for this file (live Telegram path keeps LAN IPs; secrets always scrubbed).
v3.1: each action card is its OWN Telegram message with its own 3 buttons — a reply resolves to exactly that card.

---

## 1) A "needs attention" card (real P1 rule hit; Qwen writes the lead, floor keeps the rating)

${p1item && actionMessages.length ? clean(msgText(actionMessages.find(m => m.card.rating === 'needs_attention') || actionMessages[0])) : '(no recent P1 item found)'}

---

## 2) A "worth a look" card (real borderline cluster, Qwen-written lead line)

${actionMessages.find(m => m.card.rating === 'worth_a_look') ? clean(msgText(actionMessages.find(m => m.card.rating === 'worth_a_look'))) : '(no worth-a-look card in this batch — all rated routine this cycle)'}

---

## 3) Routine summary line (no_action groups collapse into ONE line — rides on the LAST card, never a message of its own)

\`\`\`text
${clean(routineGroups.length ? \`✅ <i>Routine, no action needed: \${routineGroups.map(g => \`\${g.title} (\${g.totalCount})\`).join(', ')}</i>\` : '(no routine groups in this example batch)')}
\`\`\`

---

## 4) 8am digest — body message (no buttons) + one question message (own buttons, ≤5/day)

**Body message:**

\`\`\`text
${clean(digestBody)}
\`\`\`

**Question message (each question is its own message with its own 3 buttons):**

\`\`\`text
${clean(digestQuestion)}
\`\`\`

Everything non-question is auto-labeled: \`source:"auto"\`, \`weight:0.3\`, \`auto_reason\` ∈ ignored_no_action / qwen_prelabel / jev_prelabel.
Chris's own labels: \`source:"chris"\`, \`weight:1\`. Replies resolve 1:1 (one card per message); legacy multi-card messages are AMBIGUOUS → Jarvon asks.

---

## Ratings glossary (the only three words Chris sees)
- **needs attention** — act soon (every P0/P1 rule hit lands here or above its floor; Qwen can never lower it)
- **worth a look** — minor, glance when convenient
- **no action needed** — routine; digest-only, no buttons, no card
`;
const outPath = outArg || '/Users/chrismacfarland/clawd/ops/reports/opswatch-card-examples.md';
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(`examples written: ${outPath} (qwen ${noQwen ? 'off' : `on, ${qwenMs}ms`}, action messages ${actionMessages.length}, routine groups ${routineGroups.length})`);
