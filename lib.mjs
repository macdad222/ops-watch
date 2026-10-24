// lib.mjs — ops-watch shared core: normalize, cluster, deterministic severity, scrub, config.
// Zero deps. Deterministic work only (parsing/IDs/counts/dates) — Jev does semantic judgment.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Scrub for egress (Jev rule: no keys/tokens/private contact data to third party) ──
const SCRUBBERS = [
  [/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA<redacted>'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
  [/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b/g, '<phone>'],
  [/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
];
export function scrub(s) {
  let out = String(s);
  for (const [re, rep] of SCRUBBERS) out = out.replace(re, rep);
  return out;
}

// ── Normalize one raw syslog line into an event ─────────────────────────────
// Handles: FortiGate KV style, RFC3164-ish "<pri>Mmm dd hh:mm:ss host proc[pid]: msg", bare JSON, bare msg.
const MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
export function normalizeLine(raw, receivedAt = new Date()) {
  let line = String(raw).trim();
  if (!line) return null;
  const ev = { received_at: receivedAt.toISOString(), raw: line.slice(0, 2000), source: 'unknown', host: '', program: '', fields: {} };

  // JSON passthrough
  if (line.startsWith('{')) {
    try {
      const j = JSON.parse(line);
      ev.source = j.source || j.source_ip || 'json';
      ev.host = j.host || j.hostname || j.devid || '';
      ev.program = j.program || j.type || '';
      ev.fields = j;
      ev.ts = j.timestamp || j.time || j['@timestamp'] || ev.received_at;
      ev.message = j.message || j.msg || JSON.stringify(j).slice(0, 500);
      return finish(ev);
    } catch { /* fall through */ }
  }

  // FortiGate KV (date=... time=... devid=... type=... subtype=... level=...)
  if (/\b(devid|type|subtype|level|vd|logid)=/.test(line)) {
    ev.source = 'fortigate';
    const kv = {};
    for (const m of line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) kv[m[1]] = m[3] ?? m[2];
    ev.fields = kv;
    ev.host = kv.devid || kv.hostname || '';
    ev.program = kv.type || '';
    ev.ts = kv.date && kv.time ? (kv.date.includes('-')
      ? `${kv.date}T${kv.time}`
      : `${kv.date.slice(0,4)}-${kv.date.slice(4,6)}-${kv.date.slice(6,8)}T${kv.time}`) : ev.received_at;
    ev.message = kv.msg || kv.action || '';
    ev.fg = {
      type: kv.type, subtype: kv.subtype, level: kv.level, action: kv.action,
      logid: kv.logid, srcip: kv.srcip, dstip: kv.dstip, dstport: kv.dstport,
      user: kv.user, ui: kv.ui, status: kv.status, service: kv.service,
    };
    return finish(ev);
  }

  // RFC3164-ish
  const m = line.match(/^(?:<(\d{1,3})>)?([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([\w./-]+)(?:\[(\d+)\])?:?\s*(.*)$/);
  if (m) {
    const [, pri, tstamp, host, program, pid, msg] = m;
    ev.source = 'syslog';
    ev.host = host; ev.program = program.replace(/\/.*/, '');
    ev.fields.pid = pid || '';
    const now = new Date();
    const mm = MONTHS[tstamp.slice(0, 3)] ?? now.getMonth();
    const dd = parseInt(tstamp.slice(4, 6), 10) || now.getDate();
    const hhmmss = tstamp.slice(7);
    ev.ts = new Date(`${now.getFullYear()}-${String(mm + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${hhmmss}`).toISOString();
    ev.fields.pri = pri ? parseInt(pri, 10) : null;
    ev.message = msg;
    // auth user extraction (sshd/login/su) so cross-cluster user counting works
    const um = msg.match(/\b(?:failed|invalid)\b.*?\bfor (?:invalid user )?(\S+) from/i) || msg.match(/\bsession (?:opened|closed) for user (\S+)/i);
    if (um) ev.fields.user = um[1];
    return finish(ev);
  }

  // Bare message / app log line
  ev.source = 'app'; ev.message = line; return finish(ev);

  function finish(e) {
    if (!e.ts) e.ts = e.received_at;   // never leave ts undefined — NaN would poison window math
    e.message = String(e.message || '').slice(0, 500);
    e.sig = signature(e);
    return e;
  }
}

// ── Signature: what makes two events "the same thing" ───────────────────────
export function signature(e) {
  const parts = [e.source, e.host, e.program];
  const f = e.fields || {};
  if (e.source === 'fortigate') {
    parts.push(f.subtype || '', f.action || '', f.level || '', f.dstport || '', f.service || '');
    if (f.srcip) parts.push(maskIp(f.srcip));   // mask last octet: same subnet+behavior clusters together
    if (f.dstip) parts.push(maskIp(f.dstip));
    if (f.user) parts.push('user=' + f.user);
  } else {
    const msg = e.message || '';
    parts.push(msg.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
                  .replace(/\bfor (?:invalid user )?\S+ from\b/i, 'for <user> from') // auth sig ignores username → all failed logins cluster
                  .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
                  .replace(/\b\d+\b/g, '<n>')
                  .slice(0, 90));
  }
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}
function maskIp(ip) { const o = ip.split('.'); return o.length === 4 ? `${o[0]}.${o[1]}.${o[2]}.x` : ip; }

// ── Cluster events by signature within a time window ────────────────────────
export function clusterEvents(events, windowMin = 5, { mode = 'window' } = {}) {
  const sorted = [...events].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const tEnd = new Date(sorted.at(-1)?.ts ?? Date.now()).getTime();
  // v2 (2026-10-23 drop-bug fix): mode 'batch' clusters the WHOLE unread batch — the old
  // window filter silently discarded every event older than (newest − windowMin), so a
  // backlog (Loki outage, restart, flood) was dropped without a trace. --window-min is
  // a label only in batch mode; window = actual span of the batch.
  const batch = mode === 'batch';
  const win = batch
    ? { start: new Date(sorted[0]?.ts ?? tEnd).toISOString(), end: new Date(tEnd).toISOString(), label_min: windowMin }
    : { start: new Date(tEnd - windowMin * 60000).toISOString(), end: new Date(tEnd).toISOString() };
  const cutoff = batch ? -Infinity : tEnd - windowMin * 60000;
  const bySig = new Map();
  for (const e of sorted) {
    if (new Date(e.ts).getTime() < cutoff) continue; // window mode only
    if (!bySig.has(e.sig)) bySig.set(e.sig, []);
    bySig.get(e.sig).push(e);
  }
  const clusters = [];
  for (const [sig, evs] of bySig) {
    const first = evs[0];
    clusters.push({
      sig, count: evs.length,
      source: first.source, host: first.host, program: first.program,
      fg: first.fg || null,
      distinct_users: new Set(evs.map(e => e.fg?.user || e.fields?.user).filter(Boolean)).size,
      distinct_ips: new Set(evs.flatMap(e => [e.fg?.srcip, e.fg?.dstip]).filter(Boolean)).size,
      first_seen: evs[0].ts, last_seen: evs.at(-1).ts,
      samples: evs.slice(0, 3).map(e => e.message),
      events: evs,
    });
  }
  return { window: win, clusters: clusters.sort((a, b) => b.count - a.count) };
}

// ── ops-watch v2 config (config/opswatch.json) — re-read every cycle ─────────
const LIB_HERE = dirname(fileURLToPath(import.meta.url));
const OPS_CFG_DEFAULTS = {
  triage_mode: 'v1',
  v1_cluster_mode: 'window',   // 2026-10-23 flood hotfix: decision-path clustering for v1/shadow — 'window' (pre-deploy behavior) | 'batch' (interim whole-batch). v2 mode always batches.
  v1_cap: 150,
  v2: { chunk_size: 12,   // measured 2026-10-23: ~12-13 Choice answers fit Jev's output limit (~700 tok); 30 → max_tokens_exceeded
    concurrency: 3, timeout_ms: 20000, retries: 1, backoff_ms: 2000,
        max_clusters_per_cycle: 300, model: 'jev-1.13.0',
        bands: { security_ping_p: 0.40, security_min_conf: 0.30, fault_ping_p: 0.60, fault_min_conf: 0.50,
                 routine_hold_p: 0.75, routine_min_conf: 0.60, expected_change_p: 0.60 },
        thresholds_by_source: {},
        prestep: { enabled: true, min_held_7d: 3, max_rate_vs_baseline: 3 } },
  pings: { max_per_cycle: 10, repeat_hours: 4 },
  quiet_hours_ct: { start: '00:00', end: '06:00' },
  digest: { enabled: true, send_at_ct: '08:00', max_items: 15, max_questions: 5, prelabel_confidence: 0.8 },
  feedback: { method: 'reply', mute_days: 7 },
  ml: { min_labels: 300, shadow: true },
  // v3 plain-English cards (2026-10-23): live pings only for cards rated ≥ worth_a_look
  // (P0/P1 rule hits ALWAYS ping). Set live_ping_min_rating to "none" to ping everything again.
  live_ping_min_rating: 'worth_a_look',
  cards: { enabled: true, model: 'Qwen3.8-27B', timeout_ms: 25000, max_tokens: 900, max_groups: 12 },
  friendly_names: {
    fortigate: 'FortiGate firewall',
    'vllm-qwen36': 'Qwen 3.6 model server (.120)',
    'vllm-glm53-flash': 'GLM 5.3 model server (.120)',
    'litellm-linux-test': 'LiteLLM test proxy',
    'litellm-agentic-gateway': 'LiteLLM agent gateway',
    'openclaw-gateway': 'Jarvon\u2019s OpenClaw gateway',
    sshd: 'SSH logins',
    syslog: 'System logs',
    kernel: 'Linux kernel',
    docker: 'Docker containers',
    cron: 'Scheduled jobs',
    postgres: 'Postgres database',
    cloudflared: 'Cloudflare tunnel',
    'omlx-serve': 'Local model server (M6 mini)',
    'omlx-embed-adapter': 'Embedding adapter (M6 mini)',
    'embed-proxy': 'Embedding proxy',
    'vllm-mlx-embed': 'Embedding model server',
    homebridge: 'HomeKit bridge',
    'm5max-watchdog': 'M5Max watchdog',
    'sonos-watchdog': 'Sonos watchdog',
    'voice-bridge': 'Voice bridge',
    'voice-v3': 'Voice bridge v3',
    unifi: 'UniFi network',
    'ops-watch': 'ops-watch itself',
  },
};
function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}
export function loadOpsConfig(path) {
  const p = path || process.env.OPSWATCH_CONFIG || join(LIB_HERE, 'config', 'opswatch.json');
  try {
    if (!existsSync(p)) return deepMerge(OPS_CFG_DEFAULTS, {});
    return deepMerge(OPS_CFG_DEFAULTS, JSON.parse(readFileSync(p, 'utf8')));
  } catch { return deepMerge(OPS_CFG_DEFAULTS, {}); } // unreadable config → defaults, never crash a cycle
}

// ── Quiet hours (CT) — container clock is UTC, compute CT wall time properly ──
export function ctWallTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = t => parts.find(p => p.type === t)?.value || '00';
  const h = get('hour');
  return `${h === '24' ? '00' : h}:${get('minute')}`;
}
export function isQuietHoursCT(cfg, date = new Date()) {
  const { start = '00:00', end = '06:00' } = cfg?.quiet_hours_ct || {};
  const t = ctWallTime(date);
  return t >= start && t < end; // start inclusive, end exclusive
}

// ── Buzz relay known-hum (2026-10-24, Chris-approved) ────────────────────────
// buzz-prod-relay-1 (ghcr.io/block/buzz on .110) logs per-connection lifecycle/success
// lines that each carry a unique conn_id/event_id/pubkey — they NEVER repeat verbatim,
// so the generic repeat-hum detector never fires and Jev rates every line "novel"
// → endless P2 pings (19 on 2026-10-24 alone). Treat the observed lifecycle set as
// deterministic hum. Safety: triage.mjs runs appRulesVerdict FIRST, so any buzz error
// burst (rules.json detected-error-burst → P1) still pings; and any ERROR-level,
// failed-status, or non-2xx line disqualifies its whole cluster from hum here.
// Matched strings are the exact messages observed in events.jsonl on 2026-10-24
// (inner-JSON form; \\? tolerates both raw and re-escaped encodings).
const BUZZ_PROGRAM_RE = /^buzz-prod-relay/;
const BUZZ_HUM_LINE_RE =
  /\\?"message\\?":\\?"(?:WebSocket connection closed|WebSocket connection established|NIP-42 auth successful|Event ingested via pipeline)|[0-9]+ missed pongs[^"\\]*closing connection/;
const BUZZ_BRIDGE_OK_RE = /\\?"message\\?":\\?"HTTP bridge request\\?"/;
const BUZZ_BRIDGE_2XX_RE = /\\?"status\\?":2/;
const BUZZ_ERROR_GUARD_RE = /level\\?":\\?"(?:ERROR|error)|panic|fatal|traceback|\\?"accepted\\?":false/i;
function buzzHumLine(raw) {
  if (!raw || BUZZ_ERROR_GUARD_RE.test(raw)) return false;
  if (BUZZ_HUM_LINE_RE.test(raw)) return true;
  // HTTP bridge access log: hum only successful (2xx, accepted) requests
  return BUZZ_BRIDGE_OK_RE.test(raw) && BUZZ_BRIDGE_2XX_RE.test(raw);
}

// ── Deterministic severity layer — ALWAYS overrides Jev ─────────────────────
// P0 EMERGENCY (honeytoken/IOC) and P1 DETERMINISTIC-PING beats any Jev verdict.
// Jev blocking only ever applies to events this layer scored low.
export function deterministicVerdict(cluster, honey) {
  const text = cluster.events.map(e => e.raw).join(' ');
  const lowText = text.toLowerCase();
  for (const s of honey.strings || []) if (lowText.includes(String(s).toLowerCase()))
    return { level: 'P0', why: `honeytoken string match: ${s}` };
  for (const u of honey.users || []) if (lowText.includes(String(u).toLowerCase()))
    return { level: 'P0', why: `canary account mentioned in event text: ${u}` };
  for (const d of honey.domains || []) if (lowText.includes(String(d).toLowerCase()))
    return { level: 'P0', why: `canary domain lookup: ${d}` };
  for (const ioc of honey.iocs || []) if (lowText.includes(String(ioc).toLowerCase()))
    return { level: 'P0', why: `IOC match: ${ioc}` };

  // Buzz relay lifecycle churn → known hum (held, digest-visible, never pinged).
  // Any error-level/failed line in the cluster disqualifies it (see BUZZ comment above).
  if (BUZZ_PROGRAM_RE.test(cluster.program || '') &&
      (cluster.events || []).length > 0 &&
      cluster.events.every(ev => buzzHumLine(ev.raw || '')))
    return { level: 'P3', why: 'buzz relay lifecycle churn (known hum)' };

  if (cluster.fg && /config|update/.test(cluster.fg.action || '') ) 
    return { level: 'P1', why: `firewall config change (action=${cluster.fg.action})` };
  if (cluster.program === 'sudo' || cluster.program === 'su' && /session/i.test(cluster.samples[0] || ''))
    return { level: 'P1', why: 'privilege escalation event' };
  if (cluster.distinct_users >= 3 && /fail|invalid|denied/i.test((cluster.samples.join(' '))))
    return { level: 'P1', why: `auth failures across ${cluster.distinct_users} distinct users` };
  // Level-based hum: debug spam always; info floods (scrapes, engine stats) at volume
  const lvl0 = String(cluster.events[0]?.fields?.detected_level || '').toLowerCase();
  if (lvl0 === 'debug')
    return { level: 'P3', why: 'debug-level log volume (always background)' };
  if (lvl0 === 'info' && cluster.count >= 15)
    return { level: 'P3', why: `info-level volume (×${cluster.count}) — background` };
  if (cluster.count >= 50)
    return { level: 'P1', why: `volume burst: ${cluster.count} events in window` };
  if (/level=(alert|emergency|critical)|<0>|<1>|<2>/.test(text))
    return { level: 'P1', why: 'critical-severity event by syslog level' };
  // Health/metrics scrape hum — always digest regardless of count (promtail-era noise)
  if (/["']?(GET|POST) \/(health|metrics|ready|livez|status)[^"']*HTTP\/1\.[01]"? 200 |GET \/ HTTP\/1\.[01]" 200 /.test(cluster.samples.join(' ')))
    return { level: 'P3', why: 'health/metrics scrape traffic (always background)' };
  // P3 — deterministic background hum: high repetition, zero danger keywords.
  // Code-level suppression (not Jev) — standard SIEM known-pattern handling; held items stay visible.
  if (cluster.count >= 8 && !/error|warn|fail|denied|invalid|alert|critical|refused|timeout/i.test(cluster.samples.join(' ')))
    return { level: 'P3', why: `recurring background pattern (×${cluster.count}, no danger keywords)` };
  return { level: 'P2', why: 'no deterministic signal' };
}

// ── Loki-tail event builder (pre-shaped {source,host,program,level,ts,message}) ──
export function buildLokiEvent(j) {
  const e = {
    received_at: new Date().toISOString(),
    raw: String(j.message || '').slice(0, 2000),
    source: j.source || 'loki',
    host: j.host || '',
    program: j.program || '',
    ts: j.ts || new Date().toISOString(),
    message: String(j.message || ''),
    fields: { detected_level: j.level || null, job: j.program || '' },
  };
  e.sig = signature(e);
  return e;
}

// ── App rules layer (rules.json) — deterministic, code-level, sits above Jev ──
// match: {job, detected_level, host} regexes against event fields; patterns: any-match against samples.
// Verdict P1 when cluster.count >= minCount.
export function appRulesVerdict(cluster, rules) {
  const first = cluster.events[0] || {};
  const job = first.fields?.job || first.program || '';
  const lvl = first.fields?.detected_level || '';
  const host = cluster.host || '';
  const samples = cluster.samples.join(' ');
  for (const r of rules || []) {
    const m = r.match || {};
    if (m.job && !new RegExp(m.job, 'i').test(job)) continue;
    if (m.detected_level && !new RegExp(m.detected_level, 'i').test(lvl)) continue;
    if (m.host && !new RegExp(m.host, 'i').test(host)) continue;
    if (cluster.count < (r.minCount ?? 1)) continue;
    if (r.patterns && r.patterns.length) {
      if (!r.patterns.some(p => new RegExp(p, 'i').test(samples))) continue;
    }
    return { level: r.level || 'P1', why: `rule ${r.name}: ${r.why}` };
  }
  return null;
}
