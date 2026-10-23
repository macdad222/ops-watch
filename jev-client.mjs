// jev-client.mjs — ops-watch-local wrapper over the SHARED jev() client (jev-gate.mjs).
// Does NOT modify shared behavior (selftest 36/36 after the additive Retry-After passthrough).
// Adds (plan §3.3): chunking (default 30/call), concurrency 3, model pin, 20s timeout,
// one retry w/ 2s ±50% jitter backoff (429/529 honor Retry-After ≤10s), and
// max_tokens_exceeded → split the chunk in half and retry each half once.
// Zero deps.
let _jev;
try { _jev = await import('../jev/jev-gate.mjs'); }        // repo layout (mini)
catch { _jev = await import('./jev/jev-gate.mjs'); }        // container layout (/app)
const { jev, logDecision } = _jev;

const OPTIONS = {
  routine_noise: 'Recurring known-good background: routine firewall allow/deny hum, cron/keepalive/backup jobs, health checks, expected repeats of a familiar low-severity message at ~its baseline rate. Nothing changed, nothing failing, nothing security-relevant.',
  expected_change: 'Planned or benign change: package updates, container restarts right after a deploy, DHCP lease churn after a reboot, launchd job reload, firmware update, a scheduled maintenance action. A change, but an explainable and benign one.',
  operational_fault: 'Something broken or degrading: crash loop, disk/IO errors, OOM kills, service failing or failing to bind, error rate far above this source\'s baseline, repeated connection refused/timeouts. Needs a human to look at soon.',
  security_relevant: 'Auth abuse or possible intrusion: failed logins across many users, new admin/user appearing, config or policy change not explained by maintenance, scans, blocked-then-allowed traffic, unusual external IP touching a sensitive port, botnet/C&C indicators.',
};

export function choiceQuestion(feature) {
  return {
    type: 'choice',
    instructions: `Classify clusters[${feature.id}] (source=${feature.source}, program=${feature.program || 'n/a'}). Use only this cluster's fields and samples in the state, plus state.examples for its source family. Judge what the events MEAN, not how many there are.`,
    criteria: OPTIONS,
  };
}

// source/program → example family key (examples.json families)
export function familyOf(source = '', program = '') {
  const s = `${source} ${program}`.toLowerCase();
  if (/fortigate|fortios/.test(s)) return 'fortigate';
  if (/sshd|ssh|pam|sudo|su\b|auth/.test(s)) return 'sshd';
  if (/docker|containerd|k8s|kube/.test(s)) return 'docker';
  if (/unifi|ubnt|wireless|wifi/.test(s)) return 'unifi';
  if (/launchd|loginwindow|mdm|finder|spotlight|timemachine|homebridge|voice|gateway|watchdog/.test(s)) return 'mac';
  if (/kernel|blk|ext4|oom/.test(s)) return 'kernel';
  if (/cron|crond|anacron/.test(s)) return 'cron';
  return 'other';
}

function isRetryable(e) {
  if (e?.status === 429 || e?.status === 529) return true;
  const m = String(e?.message || '');
  return /fetch failed|timeout|aborted|ECONNRESET|ENOTFOUND|socket hang up/i.test(m);
}
function isTokenLimit(e) {
  return /max_tokens|too long|token limit|context length/i.test(String(e?.message || '') + String(e?.body || ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Main entry. state: JSON-serializable; clusters: feature objects (each with unique .id).
// Returns { results: Map(id → {probs, confidence, choice} | null), calls: [row] }.
export async function jevClassifyClusters(state, clusters, { cfg, gate = null, examples = null, log = null, jevFn = jev } = {}) {
  const v2 = cfg?.v2 || {};
  const chunkSize = v2.chunk_size ?? 30;
  const concurrency = v2.concurrency ?? 3;
  const timeoutMs = v2.timeout_ms ?? 20000;
  const retries = v2.retries ?? 1;
  const backoffMs = v2.backoff_ms ?? 2000;
  const model = v2.model || 'jev-1.13.0';
  const results = new Map();
  const calls = [];

  const chunks = [];
  for (let i = 0; i < clusters.length; i += chunkSize) chunks.push({ items: clusters.slice(i, i + chunkSize), index: chunks.length });

  async function runChunk(chunk, depth = 0) {
    // examples: attached ONCE per source family present in the chunk (plan §3.4 — keeps tokens down)
    const fams = new Set(chunk.items.map(c => familyOf(c.source, c.program)));
    const stateEx = {};
    for (const f of fams) {
      const fam = examples?.families?.[f] || examples?.families?.other;
      if (fam) stateEx[f] = fam;
    }
    const callState = stateEx && Object.keys(stateEx).length ? { ...state, examples: stateEx } : state;
    const questions = {};
    chunk.items.forEach((c, i) => { questions[`q${i}`] = choiceQuestion(c); });
    const t0 = Date.now();
    let attempt = 0;
    for (;;) {
      try {
        const r = await jevFn(callState, questions, { gate, action: 'v2-triage', model, timeoutMs });
        const latency = Date.now() - t0;
        let okCount = 0;
        chunk.items.forEach((c, i) => {
          const a = r.answers?.[`q${i}`];
          if (a?.type === 'choice' && a.probabilities && Object.keys(a.probabilities).length) {
            results.set(c.id, { probs: a.probabilities, confidence: typeof a.confidence === 'number' ? a.confidence : 0, choice: a.choice, chunk: chunk.index });
            okCount++;
          } else results.set(c.id, null);   // unparsed → caller escalates (never dropped)
        });
        const row = { type: 'call', chunk: chunk.index, attempt, ok: true, split: depth > 0, clusters: chunk.items.length,
          parsed: okCount, tokens_in: r.usage?.input_tokens ?? 0, tokens_out: r.usage?.output_tokens ?? 0,
          jev_model: r.model ?? model, latency_ms: latency };
        calls.push(row); log?.(row);
        return;
      } catch (e) {
        attempt++;
        const raMs = e?.retryAfterMs && e.retryAfterMs > 0 && e.retryAfterMs <= 10000 ? e.retryAfterMs : null;
        if (attempt <= retries && isRetryable(e)) {
          const wait = raMs ?? Math.round(backoffMs * (0.5 + Math.random()));
          calls.push({ type: 'call', chunk: chunk.index, attempt, ok: false, retry: true, error: String(e.message).slice(0, 120), wait_ms: wait });
          await sleep(wait);
          continue;
        }
        if (isTokenLimit(e) && depth < 4 && chunk.items.length > 1) {
          // measured 2026-10-23: Jev output limit ≈ 700-750 tokens ≈ 12-13 Choice answers
          // (~55 out-tokens each). Split recursively down to pairs so a half that still
          // overflows splits again instead of failing whole (v1 chunk 30 → 15s all failed).
          const mid = Math.ceil(chunk.items.length / 2);
          calls.push({ type: 'call', chunk: chunk.index, attempt, ok: false, split: true, error: String(e.message).slice(0, 120) });
          await runChunk({ items: chunk.items.slice(0, mid), index: chunk.index }, depth + 1);
          await runChunk({ items: chunk.items.slice(mid), index: chunk.index }, depth + 1);
          return;
        }
        chunk.items.forEach(c => results.set(c.id, null));
        const row = { type: 'call', chunk: chunk.index, attempt, ok: false, split: depth > 0, clusters: chunk.items.length,
          error: String(e.message || e).slice(0, 160), latency_ms: Date.now() - t0 };
        calls.push(row); log?.(row);
        if (gate) logDecision({ gate, action: 'v2-triage:error', pass: null, chunk: chunk.index, error: String(e.message).slice(0, 120) });
        return;
      }
    }
  }

  let next = 0;
  async function worker() {
    while (next < chunks.length) {
      const mine = chunks[next++];
      await runChunk(mine);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length || 1) }, worker));
  return { results, calls };
}
