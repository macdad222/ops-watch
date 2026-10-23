#!/usr/bin/env node
// build-examples.mjs — mine real per-family example situations for v2 Choice criteria (§3.4/§4.4).
// Runs on .110 inside the container (data lives there). Writes data/examples-next.json;
// Jarvon pulls it into the repo, reviews the scrub, and git-commits.
//   node build-examples.mjs [--from-labels]
// routine_noise   ← most-repeated held clusters (held ≥10 cycles in 7d) per family
// operational_fault / security_relevant ← past pinged items (P1/P2 pings + useful labels)
// expected_change ← hand-seeded (deploys, updates, reboots) — never mined
// All samples pass scrub() and are truncated to 140 chars; max 3 per option per family.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from './lib.mjs';
import { familyOf } from './jev-client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OPSWATCH_DATA_DIR || join(HERE, 'data');
const MAX_PER = 3;
const HELD_MIN_7D = 10;

function readJsonl(name) {
  const p = join(DATA_DIR, name);
  if (!existsSync(p)) return [];
  const out = [];
  for (const l of readFileSync(p, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } }
  return out;
}

const fromLabels = process.argv.slice(2).includes('--from-labels');
const fams = {};
const fam = f => fams[f] = fams[f] || { routine_noise: [], operational_fault: [], security_relevant: [] };
const push = (f, opt, sample) => {
  if (!sample) return;
  const s = scrub(String(sample))
    .replace(/\b(?:192\.168|10)(?:\.\d+){2}\b/g, '<lan-ip>')
    .replace(/\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}\b/g, '<lan-ip>')
    .slice(0, 140);
  const arr = fam(f)[opt];
  if (!arr.includes(s) && arr.length < MAX_PER) arr.push(s);
};

// routine_noise: held.jsonl — sigs held ≥HELD_MIN_7D times, most recent sample
const heldCount = new Map(), heldSample = new Map();
for (const h of readJsonl('held.jsonl')) {
  if (!h.sig || !h.source) continue;
  heldCount.set(h.sig, (heldCount.get(h.sig) || 0) + 1);
  heldSample.set(h.sig, { source: h.source, program: h.program, sample: h.why ? null : null }); // samples not stored in held rows
}
// held rows don't carry samples → use the shadow ledger's feature samples for held sigs
const shadowBySig = new Map();
for (const r of readJsonl('jev-v2-shadow.jsonl')) if (r.sig && r.features?.samples?.length) shadowBySig.set(r.sig, r);
for (const [sig, n] of heldCount) {
  if (n < HELD_MIN_7D) continue;
  const sh = shadowBySig.get(sig);
  const src = sh?.source || heldSample.get(sig)?.source;
  if (!src) continue;
  push(familyOf(src, sh?.program || ''), 'routine_noise', sh?.features?.samples?.[0]);
}

// fault/security: pinged items (pings.jsonl kind ping|digest, level P1/P2) + useful labels
const pingedBySig = new Map();
for (const p of readJsonl('pings.jsonl')) {
  if (p.kind === 'test') continue;
  for (const it of p.items || []) {
    if (it.level === 'P0') continue;   // never put real P0 details in examples
    pingedBySig.set(it.sig, it);
  }
}
for (const [, it] of pingedBySig) {
  const opt = it.level === 'P1' ? 'operational_fault' : /auth|brute|admin|login/i.test(`${it.source} ${it.program} ${it.decision}`) ? 'security_relevant' : 'operational_fault';
  push(familyOf(it.source, it.program), opt, it.decision ? `${it.decision}` : null);
}

// labels refine: useful → fault/security pools; noise → routine pool
// v3: HUMAN labels only (source:"chris"; pre-v3 rows have source = event source).
// Auto rows (source:"auto") never refine example pools.
if (fromLabels) {
  for (const l of readJsonl('labels.jsonl')) {
    if (l.source === 'auto') continue;
    const src = l.event_source ?? ((l.source === 'chris' || l.source === 'auto') ? '' : l.source);
    const sh = shadowBySig.get(l.sig);
    const sample = sh?.features?.samples?.[0] || l.decision;
    if (!sample) continue;
    if (l.label === 'useful') push(familyOf(src, l.program), 'security_relevant', sample);
    if (l.label === 'noise') push(familyOf(src, l.program), 'routine_noise', sample);
  }
}

const out = {
  generated_at: new Date().toISOString(),
  generated_by: `build-examples.mjs${fromLabels ? ' --from-labels' : ''}`,
  note: 'Mined from local ledgers. Scrubbed (sk/AKIA/Bearer/JWT/email/phone), ≤140 chars, ≤3 per option per family. Review before git commit.',
  families: {},
};
for (const [f, v] of Object.entries(fams)) {
  out.families[f] = {
    routine_noise: v.routine_noise,
    expected_change: [],   // hand-seeded only (never mined)
    operational_fault: v.operational_fault,
    security_relevant: v.security_relevant,
  };
}
// keep hand-seeded expected_change from the current examples.json if present
try {
  const cur = JSON.parse(readFileSync(join(HERE, 'examples.json'), 'utf8'));
  for (const [f, v] of Object.entries(cur.families || {})) {
    out.families[f] = out.families[f] || { routine_noise: [], expected_change: [], operational_fault: [], security_relevant: [] };
    out.families[f].expected_change = v.expected_change || [];
  }
} catch { /* no current file */ }

writeFileSync(join(DATA_DIR, 'examples-next.json'), JSON.stringify(out, null, 2));
const n = Object.values(out.families).reduce((s, v) => s + v.routine_noise.length + v.expected_change.length + v.operational_fault.length + v.security_relevant.length, 0);
console.log(`examples-next.json written: ${Object.keys(out.families).length} families, ${n} examples`);
