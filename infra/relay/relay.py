"""Unprivileged supervisor; only validated leased data reaches socat argv."""
import os
import signal
import subprocess
import threading

from relay_state import read_target, ipv4


def command(ip, binary="/usr/bin/socat"):
    ipv4(ip)
    return [binary, "-T", "30",
            "TCP4-LISTEN:18080,bind=127.0.0.1,reuseaddr,fork,max-children=32,backlog=32",
            f"TCP4:{ip}:8080,connect-timeout=3"]


class Relay:
    def __init__(self, binary="/usr/bin/socat"):
        self.binary = binary
        self.process = None
        self.target = None

    def stop(self):
        if self.process is None:
            return
        process = self.process
        try:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            # Kill forked children too, even if the socat parent already exited.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass
        process.wait(timeout=2)
        self.process = self.target = None

    def update(self, target):
        if self.process is not None and self.process.poll() is not None:
            self.stop()
            # Delegate abnormal exits to systemd's backoff/start limit.
            raise RuntimeError("socat exited unexpectedly")
        if target == self.target:
            return
        self.stop()
        if target is not None:
            self.process = subprocess.Popen(command(target["ip"], self.binary),
                                            stdin=subprocess.DEVNULL, start_new_session=True,
                                            env={"PATH": "/usr/bin:/bin", "LANG": "C"})
            self.target = target.copy()
            print("relay: forwarding 127.0.0.1:18080 to", target["ip"] + ":8080", flush=True)
        else:
            print("relay: target revoked; listener and connections closed", flush=True)


def reconcile(relay, reader=read_target):
    try:
        target = reader()
    except (OSError, ValueError, UnicodeError):
        target = None
    relay.update(target)


def main():
    if os.geteuid() == 0:
        raise SystemExit("relay must not run as root")
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stopping.set())
    relay = Relay()
    print("relay: waiting for a valid target lease", flush=True)
    try:
        while not stopping.is_set():
            reconcile(relay)
            stopping.wait(0.5)
    finally:
        relay.stop()


if __name__ == "__main__":
    main()
