"""Root-only Docker reader. Writes data; never starts/stops services or relays."""
import argparse
import json
import os
import signal
import subprocess
import threading

from relay_state import (NETWORK, POLL_SECONDS, PROJECT, SERVICE, Rejected,
                         identifier, publish, select_target)

# Do not inspect Config.Env (API secrets), use a fixed local socket, no contexts,
# plugins, shell, container names or environment-controlled Docker endpoint.
DOCKER = ["/usr/bin/docker", "--host=unix:///run/docker.sock"]
ENV = {"PATH": "/usr/bin:/bin", "HOME": "/", "DOCKER_CONFIG": "/nonexistent",
       "LANG": "C", "GOMAXPROCS": "2", "GOMEMLIMIT": "64MiB"}
CONTAINER_FORMAT = ('{"Id":{{json .Id}},"Labels":{{json .Config.Labels}},'
                    '"State":{{json .State}},"NetworkMode":{{json .HostConfig.NetworkMode}},'
                    '"Networks":{{json .NetworkSettings.Networks}}}')
NETWORK_FORMAT = ('{"Id":{{json .Id}},"Name":{{json .Name}},"Driver":{{json .Driver}},'
                  '"Internal":{{json .Internal}},"EnableIPv6":{{json .EnableIPv6}},'
                  '"Labels":{{json .Labels}},"IPAM":{{json .IPAM}},'
                  '"Containers":{{json .Containers}}}')


def docker(*arguments):
    try:
        result = subprocess.run(DOCKER + list(arguments), env=ENV, timeout=2,
                                capture_output=True, text=True, check=True)
        if len(result.stdout) > 1024 * 1024:
            raise Rejected("Docker output exceeds limit")
        return result.stdout
    except (OSError, subprocess.SubprocessError, UnicodeError):
        raise Rejected("Docker query unavailable/timed out") from None


def resolve(query=docker):
    # Include stopped and one-off containers: any ambiguity revokes the relay.
    candidates = query("container", "ls", "--all", "--no-trunc", "--quiet",
                       "--filter", f"label=com.docker.compose.project={PROJECT}",
                       "--filter", f"label=com.docker.compose.service={SERVICE}").splitlines()
    if len(candidates) != 1:
        raise Rejected("expected exactly one web container (including stopped)")
    cid = identifier(candidates[0])
    try:
        container = json.loads(query("container", "inspect", "--format", CONTAINER_FORMAT, cid))
        network = json.loads(query("network", "inspect", "--format", NETWORK_FORMAT, NETWORK))
    except (ValueError, TypeError):
        raise Rejected("malformed Docker JSON") from None
    return select_target(container, network, cid)


def main():
    if os.geteuid() != 0:
        raise SystemExit("resolver requires root")
    stopping = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stopping.set())
    previous = object()
    try:
        publish(None)
        while not stopping.is_set():
            try:
                target = resolve()
                status = ("target", target["container"], target["network"], target["ip"])
            except Rejected as error:
                target = None
                status = ("revoked", str(error))
            # Never preserve the last successful target after a failed query.
            publish(target)
            if status != previous:
                print("resolver:", *status, flush=True)
                previous = status
            stopping.wait(POLL_SECONDS)
    finally:
        publish(None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate and print target JSON; do not publish")
    arguments = parser.parse_args()
    if arguments.check:
        if os.geteuid() != 0:
            raise SystemExit("resolver requires root")
        try:
            print(json.dumps(resolve()))
        except Rejected as error:
            raise SystemExit(str(error)) from None
    else:
        main()
