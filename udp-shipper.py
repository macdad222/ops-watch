#!/usr/bin/env python3
"""udp-shipper.py — tail local log files and ship each line to ops-watch (UDP JSON).

Phase 2 of ops-watch (2026-10-22): fleet Macs (mini .56, M6 mini .135, M5Max) ship
launchd service logs to the ops-watch receiver on .110:15140 without touching app code.

Usage:
  python3 udp-shipper.py --target 192.168.5.110:15140 \
    --file /path/a.log --program svc-a \
    --file /path/b.err --program svc-b

Behavior:
  * starts at EOF (never replays history on first deploy)
  * polls every 2s, handles rotation (inode change) and truncation (size < offset)
  * wraps each line: {"source":"jarvon-fleet","host":<ip>,"program":<program>,
    "detected_level":info|warn|error,"timestamp":<iso>,"message":<line>}
    (fields map onto ops-watch rules: program→job, detected_level→level matching)
  * batches up to 20 lines per datagram, one JSON per \n (receiver splits)
  * UDP send failures are logged and dropped — the shipper must survive
    receiver restarts (EHOSTUNREACH/ECONNREFUSED are routine then).
"""
import argparse, json, os, socket, time, datetime, sys

POLL_SEC = 2.0
BATCH = 20
MAX_LINE = 2000

def detect_level(line: str) -> str:
    u = line.upper()
    if "TRACEBACK" in u or " CRITICAL" in u or "FATAL" in u or " EMERG" in u or "PANIC" in u:
        return "error"
    if "ERROR" in u or " ERR " in u or "EADDRINUSE" in u or "UNHANDLED" in u:
        return "error"
    if "WARN" in u:
        return "warn"
    return "info"

def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

class Tailed:
    def __init__(self, path):
        self.path = path
        self.inode = None
        self.offset = 0
        self.fh = None
        self._open(start_at_eof=True)

    def _open(self, start_at_eof=False):
        try:
            if self.fh:
                self.fh.close()
            self.fh = open(self.path, "r", errors="replace")
            self.inode = os.stat(self.path).st_ino
            if start_at_eof:
                self.offset = os.fstat(self.fh.fileno()).st_size
            else:
                self.offset = min(self.offset, os.path.getsize(self.path))
            self.fh.seek(self.offset)
        except FileNotFoundError:
            self.fh = None
            self.inode = None
            self.offset = 0

    def poll(self):
        """Return new lines since last poll, handling rotation/truncation."""
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            self.fh = None
            return []
        if self.fh is None or st.st_ino != self.inode:
            self._open(start_at_eof=(self.inode is None))
            return []
        if st.st_size < self.offset:  # truncated
            self._open()
            return []
        if st.st_size == self.offset:
            return []
        lines = []
        with open(self.path, "r", errors="replace") as f:
            f.seek(self.offset)
            data = f.read()
            self.offset += len(data.encode("utf-8", "replace"))
        for ln in data.splitlines():
            if ln.strip():
                lines.append(ln[:MAX_LINE])
        return lines

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="192.168.5.110:15140")
    ap.add_argument("--source", default="jarvon-fleet")
    ap.add_argument("--file", action="append", default=[], help="log file path")
    ap.add_argument("--program", action="append", default=[], help="program name, pairs with --file")
    args = ap.parse_args()
    if len(args.file) != len(args.program):
        print("each --file needs a --program", file=sys.stderr)
        sys.exit(2)
    thost, tport = args.target.split(":")
    tport = int(tport)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    # A UDP sendto can BLOCK forever when the socket holds a stale unresolved route
    # (observed on .135 after a receiver restart coincided with a network flap).
    # Timeout every send, and recreate the socket on failure so route state resets.
    sock.settimeout(2.0)
    host_ip = local_ip()
    tailers = [Tailed(p) for p in args.file]
    print(f"udp-shipper: {len(tailers)} file(s) -> udp://{args.target} (source={args.source}, host={host_ip})", flush=True)

    def send(batch):
        # UDP is best-effort: a temporarily unreachable receiver must NOT kill the
        # shipper (EHOSTUNREACH/ECONNREFUSED happen during receiver restarts).
        nonlocal sock
        try:
            sock.sendto(("\n".join(batch)).encode("utf-8"), (thost, tport))
        except OSError as e:
            print(f"send failed ({e}); dropping {len(batch)} line(s); recreating socket", flush=True)
            try:
                sock.close()
            except Exception:
                pass
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(2.0)

    while True:
        batch = []
        for t, prog in zip(tailers, args.program):
            for line in t.poll():
                env = {
                    "source": args.source,
                    "host": host_ip,
                    "program": prog,
                    "detected_level": detect_level(line),
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "message": line,
                }
                batch.append(json.dumps(env, ensure_ascii=False))
                if len(batch) >= BATCH:
                    send(batch)
                    batch = []
        if batch:
            send(batch)
        time.sleep(POLL_SEC)

if __name__ == "__main__":
    main()
