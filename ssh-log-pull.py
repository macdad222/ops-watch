#!/usr/bin/env python3
"""ssh-log-pull.py — pull remote log files via SSH, ship to ops-watch (UDP JSON).

ops-watch Phase 2 (2026-10-22). macOS Local Network (TCC) restriction discovered on
the M6 mini (.135): launchd-spawned python gets EHOSTUNREACH sending UDP to LAN
targets, while ssh-launched processes work. The push shipper (udp-shipper.py) is
unusable there until Python gets a Local Network grant in the GUI.

This collector inverts the flow: it runs on the mini (whose launchd python IS
granted), SSHes OUT to remote hosts (inbound ssh there is allowed and key-based),
tails files by byte offset, and ships lines to the ops-watch receiver over UDP —
a path already proven working from the mini.

Usage:
  python3 ssh-log-pull.py \
    --host chrismacfarland@192.168.5.135 \
    --file /path/a.log --program omlx-serve \
    --file /path/b.log --program embed-proxy ...

State (per host:file byte offsets) persists in state/ssh-log-pull-state.json.
"""
import argparse, json, os, socket, subprocess, time, datetime, sys

POLL_SEC = 30
MAX_LINE = 2000
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "state", "ssh-log-pull-state.json")

def detect_level(line: str) -> str:
    u = line.upper()
    if "TRACEBACK" in u or " CRITICAL" in u or "FATAL" in u or "PANIC" in u:
        return "error"
    if "ERROR" in u or "EADDRINUSE" in u or "UNHANDLED" in u:
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

def ssh_out(host, cmd, timeout=15):
    """Run a command on host via ssh, return stdout bytes or None on failure."""
    try:
        r = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
             "-o", "StrictHostKeyChecking=accept-new", host, cmd],
            capture_output=True, timeout=timeout)
        if r.returncode != 0:
            return None
        return r.stdout
    except Exception:
        return None

def remote_size(host, path):
    """Return file size on host, or None if unreachable/missing."""
    out = ssh_out(host, f"stat -f %z '{path}' 2>/dev/null")
    if out is None:
        return None
    try:
        return int(out.strip())
    except ValueError:
        return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="192.168.5.110:15140")
    ap.add_argument("--source", required=True)
    ap.add_argument("--host", required=True, help="ssh target, e.g. user@192.168.5.135")
    ap.add_argument("--file", action="append", default=[])
    ap.add_argument("--program", action="append", default=[])
    args = ap.parse_args()
    if len(args.file) != len(args.program):
        print("each --file needs a --program", file=sys.stderr)
        sys.exit(2)
    thost, tport = args.target.split(":")
    tport = int(tport)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(2.0)
    host_ip = args.host.split("@")[-1]

    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    state = {}
    if os.path.exists(STATE_FILE):
        try:
            state = json.load(open(STATE_FILE))
        except Exception:
            state = {}

    def save_state():
        try:
            json.dump(state, open(STATE_FILE, "w"), indent=1)
        except Exception:
            pass

    def send(batch):
        if not batch:
            return
        try:
            sock.sendto(("\n".join(batch)).encode("utf-8"), (thost, tport))
        except OSError as e:
            print(f"send failed ({e}); dropping {len(batch)} line(s)", flush=True)

    # initialize offsets at EOF so we never replay old history
    for path in args.file:
        key = f"{args.host}:{path}"
        if key not in state:
            size = remote_size(args.host, path)
            state[key] = size if size is not None else 0
    save_state()
    print(f"ssh-log-pull: {len(args.file)} file(s) on {args.host} -> udp://{args.target} (source={args.source})", flush=True)

    while True:
        batch = []
        for path, program in zip(args.file, args.program):
            key = f"{args.host}:{path}"
            off = state.get(key, 0)
            data = ssh_out(args.host, f"tail -c +{off + 1} '{path}' 2>/dev/null")
            if data is None:
                continue  # ssh hiccup; retry next cycle, offset unchanged
            if not data:
                continue
            # hold back a trailing partial line (no newline yet)
            if not data.endswith(b"\n"):
                cut = data.rfind(b"\n")
                if cut < 0:
                    continue  # whole chunk is one partial line; wait for more
                data = data[: cut + 1]
            state[key] = off + len(data)
            for ln in data.decode("utf-8", errors="replace").splitlines():
                if not ln.strip():
                    continue
                env = {
                    "source": args.source,
                    "host": host_ip,
                    "program": program,
                    "detected_level": detect_level(ln),
                    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "message": ln[:MAX_LINE],
                }
                batch.append(json.dumps(env, ensure_ascii=False))
        send(batch)
        save_state()
        time.sleep(POLL_SEC)

if __name__ == "__main__":
    main()
