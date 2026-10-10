"""Local-only tests: no Docker daemon, systemd activation or remote access."""
import ast
import copy
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/relay"))
import relay  # noqa: E402
import relay_state as state  # noqa: E402
import resolve  # noqa: E402

CID, NID, EID = "a" * 64, "b" * 64, "c" * 64
SOCAT = os.environ.get("SOCAT_BINARY") or shutil.which("socat")


def fixtures(ip="172.19.0.3"):
    container = {
        "Id": CID, "Labels": {"com.docker.compose.project": "tadami-web",
        "com.docker.compose.service": "web", "com.docker.compose.oneoff": "False"},
        "State": {"Running": True, "Paused": False, "Restarting": False},
        "NetworkMode": state.NETWORK,
        "Networks": {state.NETWORK: {"NetworkID": NID, "EndpointID": EID, "IPAddress": ip}},
    }
    network = {
        "Id": NID, "Name": state.NETWORK, "Driver": "bridge", "Internal": True,
        "EnableIPv6": False, "Labels": {"com.docker.compose.project": "tadami-web",
        "com.docker.compose.network": "frontend"},
        "IPAM": {"Config": [{"Subnet": "172.19.0.0/16", "Gateway": "172.19.0.1"}]},
        "Containers": {CID: {"EndpointID": EID, "IPv4Address": ip + "/16"}},
    }
    return container, network


def target(ip="172.19.0.3"):
    return {"ip": ip, "container": CID, "network": NID}


class PolicyTests(unittest.TestCase):
    def test_valid_identity_without_container_name(self):
        self.assertEqual(state.select_target(*fixtures(), CID), target())
        values = [CID + "\n", *(json.dumps(item) for item in fixtures())]
        query = Mock(side_effect=values)
        self.assertEqual(resolve.resolve(query), target())
        self.assertIn("--all", query.call_args_list[0].args)
        self.assertIn("label=com.docker.compose.service=web", query.call_args_list[0].args)

    def test_missing_multiple_duplicate_and_injected_container_ids(self):
        for value in ("", CID + "\n" + "d" * 64, CID + "\n" + CID,
                      "--help", "$(touch /tmp/never)", "name-only"):
            with self.subTest(value=value), self.assertRaises(state.Rejected):
                resolve.resolve(Mock(return_value=value))

    def test_bad_ipv4(self):
        for value in (None, "", "172.19.0.3,exec=sh", "172.19.0.3;id", "$(id)",
                      "172.19.0.3:8080", "172.19.0.3/16", "172.019.0.3", "172.19.0.3\n",
                      "localhost", "::1", "::ffff:172.19.0.3", "127.0.0.1", "0.0.0.0",
                      "169.254.1.1", "8.8.8.8", "224.0.0.1", "255.255.255.255"):
            with self.subTest(value=value), self.assertRaises(state.Rejected):
                state.select_target(*fixtures(value or ""), CID)

    def test_wrong_identity_state_network_and_endpoint(self):
        mutations = [
            lambda c, n: c.update(Id="d" * 64),
            lambda c, n: c["Labels"].update({"com.docker.compose.project": "other"}),
            lambda c, n: c["Labels"].update({"com.docker.compose.service": "monitoring-api"}),
            lambda c, n: c["Labels"].update({"com.docker.compose.oneoff": "True"}),
            lambda c, n: c["State"].update(Running=False),
            lambda c, n: c["State"].update(Paused=True),
            lambda c, n: c["State"].update(Restarting=True),
            lambda c, n: c.update(NetworkMode="host"),
            lambda c, n: c["Networks"].update(other={}),
            lambda c, n: c["Networks"][state.NETWORK].update(NetworkID="d" * 64),
            lambda c, n: n.update(Name="other"),
            lambda c, n: n.update(Internal=False),
            lambda c, n: n.update(Driver="overlay"),
            lambda c, n: n.update(EnableIPv6=True),
            lambda c, n: n["Labels"].update({"com.docker.compose.network": "other"}),
            lambda c, n: n["Labels"].update({"com.docker.compose.project": "other"}),
            lambda c, n: n["Containers"].clear(),
            lambda c, n: n["Containers"][CID].update(EndpointID="d" * 64),
            lambda c, n: n["Containers"][CID].update(IPv4Address="172.19.0.4/16"),
            lambda c, n: n["Containers"][CID].update(IPv4Address="172.19.0.3/24"),
            lambda c, n: n["Containers"].update({"d" * 64: copy.deepcopy(n["Containers"][CID])}),
            lambda c, n: n["IPAM"].update(Config=[]),
            lambda c, n: n["IPAM"]["Config"][0].update(Subnet="0.0.0.0/0"),
        ]
        for mutation in mutations:
            with self.subTest(mutation=mutations.index(mutation)):
                container, network = fixtures()
                mutation(container, network)
                with self.assertRaises(state.Rejected):
                    state.select_target(container, network, CID)
        for ip in ("172.19.0.0", "172.19.255.255", "172.19.0.1", "172.20.0.3"):
            with self.subTest(ip=ip), self.assertRaises(state.Rejected):
                state.select_target(*fixtures(ip), CID)

    def test_malformed_inspect(self):
        for bad in (None, [], {}, "", 2):
            with self.subTest(bad=bad), self.assertRaises(state.Rejected):
                state.select_target(bad, fixtures()[1], CID)
        with self.assertRaises(state.Rejected):
            resolve.resolve(Mock(side_effect=[CID, "not json"]))

    def test_docker_failure_and_timeout_are_redacted(self):
        for error in (FileNotFoundError(), subprocess.TimeoutExpired("docker", 2),
                      subprocess.CalledProcessError(1, "docker", stderr="PRIVATE-SENTINEL")):
            with self.subTest(error=type(error)), patch.object(subprocess, "run", side_effect=error):
                with self.assertRaisesRegex(state.Rejected, "unavailable/timed out"):
                    resolve.docker("container", "ls")
        with patch.object(subprocess, "run", return_value=Mock(stdout=CID)) as run:
            self.assertEqual(resolve.docker("container", "ls"), CID)
            self.assertEqual(run.call_args.args[0][:2], resolve.DOCKER)
            self.assertEqual(run.call_args.kwargs["timeout"], 2)
            self.assertNotIn("DOCKER_HOST", run.call_args.kwargs["env"])
            self.assertNotIn("shell", run.call_args.kwargs)
        self.assertNotIn(".Env", resolve.CONTAINER_FORMAT)

    def test_lease_valid_expired_future_nan_and_malformed(self):
        document = {"observed": 100, "target": target()}
        self.assertEqual(state.validate_state(document, 112), target())
        self.assertIsNone(state.validate_state({"observed": 100, "target": None}, 100))
        for timestamp in (87, 101, float("nan"), float("inf"), "100", True, None):
            with self.subTest(timestamp=timestamp), self.assertRaises(state.Rejected):
                state.validate_state({"observed": timestamp, "target": target()}, 100)
        for bad in ({}, {"observed": 100}, {"observed": 100, "target": {"ip": "172.19.0.3"}},
                    {"observed": 100, "target": target(), "command": "sh"}):
            with self.subTest(bad=bad), self.assertRaises(state.Rejected):
                state.validate_state(bad, 100)

    def test_atomic_publication_and_file_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "target.json"
            state.publish(target(), path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(state.read_target(path, os.getuid()), target())
            state.publish(None, path)
            self.assertIsNone(state.read_target(path, os.getuid()))
            self.assertEqual(list(Path(directory).iterdir()), [path])
            with self.assertRaises(state.Rejected):
                state.read_target(path, os.getuid() + 1)
            path.chmod(0o660)
            with self.assertRaises(state.Rejected):
                state.read_target(path, os.getuid())
            path.unlink()
            path.symlink_to("missing")
            with self.assertRaises(OSError):
                state.read_target(path, os.getuid())

    def test_same_ip_new_container_or_network_restarts_and_revocation_stops(self):
        process = Mock(pid=99999999)
        process.poll.return_value = None
        with patch.object(subprocess, "Popen", return_value=process) as spawn, \
                patch.object(os, "killpg") as kill:
            worker = relay.Relay()
            worker.update(target())
            worker.update(target())
            self.assertEqual(spawn.call_count, 1)
            changed = target()
            changed["container"] = "d" * 64
            worker.update(changed)
            self.assertEqual(spawn.call_count, 2)
            changed = {**changed, "network": "e" * 64}
            worker.update(changed)
            self.assertEqual(spawn.call_count, 3)
            worker.update(target("172.19.0.4"))
            self.assertIn("TCP4:172.19.0.4:8080", spawn.call_args.args[0][-1])
            relay.reconcile(worker, Mock(side_effect=state.Rejected("Docker down")))
            self.assertIsNone(worker.process)
            kill.assert_any_call(process.pid, signal.SIGKILL)

    def test_crashed_socat_is_delegated_to_systemd_not_busy_retried(self):
        worker = relay.Relay()
        worker.process = Mock(pid=99999999)
        worker.process.poll.return_value = 1
        with patch.object(os, "killpg"), self.assertRaises(RuntimeError):
            worker.update(target())
        self.assertIsNone(worker.process)

    def test_daemon_stop_and_web_stop_revoke_previous_lease(self):
        for failure in (state.Rejected("Docker unavailable"), state.Rejected("web stopped")):
            stopping = Mock()
            stopping.is_set.side_effect = [False, False, True]
            with patch.object(resolve.os, "geteuid", return_value=0), \
                    patch.object(resolve.threading, "Event", return_value=stopping), \
                    patch.object(resolve.signal, "signal"), \
                    patch.object(resolve, "resolve", side_effect=[target(), failure]), \
                    patch.object(resolve, "publish") as publish:
                resolve.main()
                self.assertEqual([call.args[0] for call in publish.call_args_list],
                                 [None, target(), None, None])

    def test_privilege_guards_and_script_imports(self):
        with patch.object(relay.os, "geteuid", return_value=0), self.assertRaises(SystemExit):
            relay.main()
        with patch.object(resolve.os, "geteuid", return_value=1000), self.assertRaises(SystemExit):
            resolve.main()
        for script in (ROOT / "infra/relay").glob("*.py"):
            ast.parse(script.read_text(), filename=str(script))
        # The unit's Python flags must allow the adjacent root-owned policy module.
        if os.getuid() != 0:
            for arguments in ([], ["--check"]):
                result = subprocess.run([sys.executable, "-E", "-s", "-B",
                                         str(ROOT / "infra/relay/resolve.py"), *arguments],
                                        capture_output=True, text=True, timeout=5)
                self.assertEqual(result.stderr.strip(), "resolver requires root")

    def test_unit_security_and_syntax(self):
        directory = ROOT / "infra/relay"
        proxy = (directory / "tadami-web-relay.service").read_text()
        resolver = (directory / "tadami-web-relay-resolver.service").read_text()
        for line in ("User=tadami-web-relay", "Group=tadami-web-relay", "SupplementaryGroups=\n",
                     "RestrictAddressFamilies=AF_INET", "ReadOnlyPaths=/run",
                     "InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock", "PrivateNetwork=no"):
            self.assertIn(line, proxy)
        for unit in (proxy, resolver):
            for line in ("NoNewPrivileges=yes", "CapabilityBoundingSet=\n", "ProtectSystem=strict",
                         "KillMode=control-group", "RestartSec=5s", "RestartSteps=4",
                         "RestartMaxDelaySec=60s", "StartLimitBurst=5", "StartLimitIntervalSec=300"):
                self.assertIn(line, unit)
        self.assertIn("RestrictAddressFamilies=AF_UNIX", resolver)
        self.assertNotIn("[Install]", resolver)
        self.assertNotIn("docker", (directory / "tadami-web-relay.sysusers.conf").read_text().lower().splitlines()[-1])
        if shutil.which("systemd-analyze"):
            result = subprocess.run(["systemd-analyze", "verify", str(directory / "tadami-web-relay.service"),
                                     str(directory / "tadami-web-relay-resolver.service")],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("Unknown", result.stderr)


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            while data := self.request.recv(1024):
                self.request.sendall(self.server.marker + data)
        except (ConnectionError, OSError):
            pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


@unittest.skipUnless(SOCAT, "set SOCAT_BINARY or install socat for real TCP tests")
class RealSocatTests(unittest.TestCase):
    """Keep production bind/options; map only bridge destinations to local fixtures."""
    def setUp(self):
        self.servers = []
        for host, marker in (("127.0.0.2", b"A:"), ("127.0.0.3", b"B:")):
            server = Server((host, 0), Echo)
            server.marker = marker
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.servers.append(server)
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
        # Refuse to disturb an existing listener; all fixture binds are loopback.
        with socket.socket() as check:
            check.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            check.bind(("127.0.0.1", 18080))
        real_popen = subprocess.Popen

        def local_popen(argv, **kwargs):
            index = {"172.19.0.3": 0, "172.19.0.4": 1}[argv[-1].split(":")[1]]
            host, port = self.servers[index].server_address
            argv = [*argv[:-1], f"TCP4:{host}:{port},connect-timeout=3"]
            return real_popen(argv, **kwargs)

        self.patcher = patch.object(relay.subprocess, "Popen", side_effect=local_popen)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.worker = relay.Relay(SOCAT)
        self.addCleanup(self.worker.stop)

    def connect(self):
        deadline = time.monotonic() + 3
        while True:
            try:
                connection = socket.create_connection(("127.0.0.1", 18080), timeout=1)
                self.addCleanup(connection.close)
                return connection
            except ConnectionRefusedError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.02)

    def test_tcp_bind_ip_change_child_cleanup_and_revocation(self):
        self.worker.update(target())
        first = self.connect()
        first.sendall(b"one")
        self.assertEqual(first.recv(100), b"A:one")
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.2", 18080), timeout=0.5)
        with self.assertRaises(OSError):
            socket.create_connection(("::1", 18080), timeout=0.5)
        listeners = [line.split()[1] for line in Path("/proc/net/tcp").read_text().splitlines()[1:]
                     if line.split()[3] == "0A" and line.split()[1].endswith(":46A0")]
        self.assertEqual(listeners, ["0100007F:46A0"])
        self.worker.update(target("172.19.0.4"))
        self.assertEqual(first.recv(100), b"")
        second = self.connect()
        second.sendall(b"two")
        self.assertEqual(second.recv(100), b"B:two")
        relay.reconcile(self.worker, Mock(side_effect=state.Rejected("expired lease")))
        self.assertEqual(second.recv(100), b"")
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", 18080), timeout=0.5)
        self.worker.update(target())
        recovered = self.connect()
        recovered.sendall(b"recovered")
        self.assertEqual(recovered.recv(100), b"A:recovered")

    def test_unexpected_exit_stops_children_and_reports_failure(self):
        self.worker.update(target())
        connection = self.connect()
        connection.sendall(b"alive")
        self.assertEqual(connection.recv(100), b"A:alive")
        self.worker.process.kill()
        self.worker.process.wait(timeout=2)
        with self.assertRaises(RuntimeError):
            self.worker.update(target())
        self.assertEqual(connection.recv(100), b"")


if __name__ == "__main__":
    unittest.main()
