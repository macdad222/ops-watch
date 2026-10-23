#!/usr/bin/env node
// receiver.mjs — UDP syslog receiver. Appends raw lines to events.jsonl.
//   OPSWATCH_BIND=127.0.0.1:15140 OPSWATCH_OUT=./events.jsonl node receiver.mjs
// FortiGate: Log & Report → Log Settings → Remote Syslog, custom port 15140.
// Servers: syslog-ng/rsyslog forward @127.0.0.1 if local, or to this host's LAN IP.
// NOTE (TCC sandbox): on the Mac mini, bind LAN interfaces only after `openclaw` approval
// or run on .110 in Docker — README has the deploy path.
import { createSocket } from 'node:dgram';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const bind = (process.env.OPSWATCH_BIND || '127.0.0.1:15140').split(':');
const out = process.env.OPSWATCH_OUT || join(HERE, 'events.jsonl');

const sock = createSocket('udp4');
sock.on('error', e => console.error(`receiver socket error: ${e.message}`));
// 4MB rcvbuf — fortigate bursts (~200 datagrams/s batched) overflow the default buffer
try { sock.setRecvBufferSize(4 * 1024 * 1024); } catch {}
sock.on('message', (buf, rinfo) => {
  const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    appendFileSync(out, JSON.stringify({ received_at: new Date().toISOString(), peer: rinfo.address, line: line.slice(0, 2000) }) + '\n');
  }
});
sock.on('error', e => { console.error('receiver error:', e.message); process.exit(1); });
sock.bind(parseInt(bind[1], 10), bind[0], () => console.log(`ops-watch receiver listening udp://${bind[0]}:${bind[1]} → ${out}`));
