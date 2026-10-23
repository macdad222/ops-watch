#!/usr/bin/env node
// report-labels.mjs — weekly ops-watch label report (plan §4.4). Runs on JARVON (mini);
// reads .110 data over SSH (docker exec ops-watch cat …). Output: markdown file ONLY by default
// (~/clawd/ops/reports/opswatch-labels-<date>.md) — Telegram summary only if Chris asks.
// NEVER auto-applies threshold changes — suggestions only.
//   node report-labels.mjs [--days 7] [--out <path>]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const days = parseInt(args[(args.indexOf('--days') ?? -2) + 1]) || 7;
const outArg = args.indexOf('--out') >= 0 ? args[args.indexOf('--out') + 1] : null;
const HOST = 'chris@192.168.5.110';

function sshCat(file) {
  try {
    return execFileSync('ssh', ['-o', 'ConnectTimeout=8', HOST,
      `docker exec ops-watch sh -c 'cat data/${file} 2>/dev/null'`], { encoding: 'utf8', timeout: 30000 });
  } catch { return ''; }
}
function jsonl(s) {
  const out = [];
  for (const l of String(s).split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

const cut = Date.now() - days * 86400000;
const labels = jsonl(sshCat('labels.jsonl')).filter(r => new Date(r.ts).getTime() >= cut);
const pings = jsonl(sshCat('pings.jsonl')).filter(r => new Date(r.ts).getTime() >= cut && r.kind !== 'test');
const shadow = jsonl(sshCat('jev-v2-shadow.jsonl')).filter(r => r.sig && r.probs);
const shadowBySig = new Map();
for (const r of shadow) if (!shadowBySig.has(r.sig)) shadowBySig.set(r.sig, r); // first = latest? file is append-ordered → keep LAST
for (const r of shadow) shadowBySig.set(r.sig, r);

// item-level join: label × ping item × shadow verdict
// v3: labels carry an origin — human rows source:"chris" (weight 1), auto rows source:"auto"
// (weight 0.3, auto_reason). Pre-v3 rows have source = event source → treated as human.
// All gate/precision numbers count HUMAN labels only; auto rows are reported separately.
const pingById = new Map();
for (const p of pings) for (const it of p.items || []) pingById.set(it.item_id, { ping: p, item: it });

const originOf = r => (r.source === 'chris' || r.source === 'auto') ? r.source : 'chris';
const eventSourceOf = r => r.event_source ?? ((r.source === 'chris' || r.source === 'auto') ? '' : r.source);
const rows = [];
for (const l of labels) {
  const j = pingById.get(l.item_id);
  const sh = shadowBySig.get(l.sig);
  rows.push({ ...l, origin: originOf(l), event_source: eventSourceOf(l), pinged: !!j, level: j?.item?.level || null, argmax: sh ? Object.entries(sh.probs).sort((a, b) => b[1] - a[1])[0][0] : null, conf: sh?.confidence ?? null });
}
const autoRows = rows.filter(r => r.origin === 'auto');
const humanRows = rows.filter(r => r.origin === 'chris');
const total = humanRows.length;
const byLabel = {};
for (const r of humanRows) byLabel[r.label] = (byLabel[r.label] || 0) + 1;
const pingedRows = humanRows.filter(r => r.pinged);
const useful = pingedRows.filter(r => r.label === 'useful').length;
const noise = pingedRows.filter(r => r.label === 'noise').length;
const missed = rows.filter(r => r.label === 'missed').length;
const precision = (useful + noise) ? useful / (useful + noise) : null;
const recallProxy = (useful + missed) ? useful / (useful + missed) : null;

function groupBy(arr, key) {
  const m = new Map();
  for (const r of arr) { const k = key(r) || '?'; if (!m.has(k)) m.set(k, { useful: 0, noise: 0, mute: 0, missed: 0, total: 0 }); m.get(k).total++; m.get(k)[r.label] = (m.get(k)[r.label] || 0) + 1; }
  return m;
}
const perSource = groupBy(pingedRows, r => r.event_source);
const perArgmax = groupBy(pingedRows, r => r.argmax);
const missedBySource = groupBy(humanRows.filter(r => r.label === 'missed'), r => r.event_source);

// threshold suggestions (report-only)
const suggestions = [];
for (const [src, s] of perSource) {
  if (s.noise >= 3 && s.noise > s.useful) suggestions.push(`• ${src}: noise ${s.noise} > useful ${s.useful} — consider raising routine_hold_p / lowering security_ping_p for this source (thresholds_by_source).`);
}
for (const [src, s] of missedBySource) {
  if (s.missed >= 2) suggestions.push(`• ${src}: ${s.missed} missed — consider lowering routine_hold_p for this source.`);
}
if (!suggestions.length) suggestions.push('• none yet (need more labels)');

const date = new Date().toISOString().slice(0, 10);
const md = `# ops-watch label report — ${date} (last ${days}d)

**Totals:** ${total} HUMAN labels — useful ${byLabel.useful || 0} · noise ${byLabel.noise || 0} · mute ${byLabel.mute || 0} · missed ${byLabel.missed || 0} (+${autoRows.length} auto-labeled, weight 0.3, excluded from the gate)
**Precision (useful / pinged-labeled):** ${precision === null ? 'n/a' : (precision * 100).toFixed(0) + '%'} (useful ${useful} vs noise ${noise})
**Recall proxy (pinged-useful / (useful+missed)):** ${recallProxy === null ? 'n/a' : (recallProxy * 100).toFixed(0) + '%'} (missed ${missed})

## Per source (pinged items labeled)
| source | useful | noise | mute |
|---|---|---|---|
${[...perSource].map(([s, v]) => `| ${s} | ${v.useful} | ${v.noise} | ${v.mute} |`).join('\n') || '| (none) | | | |'}

## Per Jev argmax option (pinged items labeled)
| argmax | useful | noise | mute |
|---|---|---|---|
${[...perArgmax].map(([s, v]) => `| ${s} | ${v.useful} | ${v.noise} | ${v.mute} |`).join('\n') || '| (none) | | | |'}

## Threshold suggestions (NEVER auto-applied — Chris decides)
${suggestions.join('\n')}

## Notes
- Labels come from per-card buttons / replies / reactions via label.mjs (docs/FEEDBACK.md).
- HUMAN labels only (source:"chris", weight 1). Auto-labels (source:"auto", weight 0.3 — ignored_no_action / qwen_prelabel / jev_prelabel) are shown in the total line but NEVER counted toward precision/recall or the ml gate.
- Test-ping labels (kind=test) are excluded.
- ml gate: ${total} human labels collected — model training unlocks at 300 (config ml.min_labels).
`;
const outPath = outArg || join(HERE, '..', '..', 'ops', 'reports', `opswatch-labels-${date}.md`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, md);
console.log(`report written: ${outPath} (${total} labels)`);
