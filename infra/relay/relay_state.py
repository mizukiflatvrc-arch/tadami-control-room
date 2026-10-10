"""Fixed policy shared by the privileged resolver and unprivileged supervisor."""
import ipaddress
import json
import math
import os
import re
import stat
import tempfile
import time
from pathlib import Path

PROJECT = "tadami-web"
SERVICE = "web"
NETWORK = "tadami-web_frontend"
STATE = Path("/run/tadami-web-relay/target.json")
LEASE_SECONDS = 12
POLL_SECONDS = 3
ID = re.compile(r"[0-9a-f]{64}\Z")
PRIVATE_RANGES = tuple(ipaddress.IPv4Network(cidr) for cidr in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


class Rejected(ValueError):
    """Invalid or unavailable Docker target; never includes raw Docker output."""


def clock():
    # Includes suspend time; /run is cleared on reboot. No wall-clock/NTP dependency.
    return time.clock_gettime(time.CLOCK_BOOTTIME)


def ipv4(value):
    if not isinstance(value, str):
        raise Rejected("invalid IPv4")
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError:
        raise Rejected("invalid IPv4") from None
    if str(address) != value or not any(address in network for network in PRIVATE_RANGES):
        raise Rejected("IPv4 must be canonical RFC1918")
    return address


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise Rejected("invalid Docker ID")
    return value


def select_target(container, network, expected_id):
    """Recheck identity, isolation, subnet and endpoint from two inspect snapshots."""
    try:
        cid = identifier(container["Id"])
        nid = identifier(network["Id"])
        labels = container["Labels"]
        if cid != expected_id or labels.get("com.docker.compose.project") != PROJECT \
                or labels.get("com.docker.compose.service") != SERVICE \
                or labels.get("com.docker.compose.oneoff") != "False":
            raise Rejected("container identity mismatch")
        if container["State"]["Running"] is not True \
                or container["State"].get("Paused") is not False \
                or container["State"].get("Restarting") is not False:
            raise Rejected("web is not running normally")
        if container["NetworkMode"] in ("host", "none", "default") \
                or container["NetworkMode"].startswith("container:"):
            raise Rejected("unexpected network mode")
        if network["Name"] != NETWORK or network["Driver"] != "bridge" \
                or network["Internal"] is not True or network["EnableIPv6"] is not False \
                or network["Labels"].get("com.docker.compose.project") != PROJECT \
                or network["Labels"].get("com.docker.compose.network") != "frontend":
            raise Rejected("frontend network identity/isolation mismatch")
        networks = container["Networks"]
        if set(networks) != {NETWORK} or networks[NETWORK]["NetworkID"] != nid:
            raise Rejected("web network membership mismatch")
        address = ipv4(networks[NETWORK]["IPAddress"])
        configs = network["IPAM"]["Config"]
        if len(configs) != 1:
            raise Rejected("expected one IPv4 subnet")
        subnet = ipaddress.IPv4Network(configs[0]["Subnet"], strict=True)
        gateway = ipv4(configs[0]["Gateway"])
        if not any(subnet.subnet_of(private) for private in PRIVATE_RANGES) \
                or address not in subnet or gateway not in subnet \
                or address in (subnet.network_address, subnet.broadcast_address, gateway):
            raise Rejected("IPv4 outside usable frontend subnet")
        peers = network["Containers"]
        endpoint = peers[cid]
        if endpoint["EndpointID"] != networks[NETWORK]["EndpointID"] \
                or not ID.fullmatch(endpoint["EndpointID"]):
            raise Rejected("endpoint mismatch")
        addresses = [ipaddress.IPv4Interface(peer["IPv4Address"]) for peer in peers.values()]
        own = ipaddress.IPv4Interface(endpoint["IPv4Address"])
        if own.ip != address or own.network != subnet \
                or sum(peer.ip == address for peer in addresses) != 1:
            raise Rejected("missing or duplicate IPv4 endpoint")
        return {"ip": str(address), "container": cid, "network": nid}
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        if isinstance(error, Rejected):
            raise
        raise Rejected("malformed inspect data") from None


def publish(target, destination=STATE):
    document = {"observed": clock(), "target": target}
    fd, name = tempfile.mkstemp(prefix=".target-", dir=destination.parent)
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            os.fchmod(stream.fileno(), 0o640)
            json.dump(document, stream, allow_nan=False)
            stream.write("\n")
        os.replace(name, destination)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def validate_state(document, now):
    try:
        if set(document) != {"observed", "target"}:
            raise Rejected("invalid state fields")
        observed = document["observed"]
        if type(observed) not in (int, float) or not math.isfinite(observed) \
                or not 0 <= now - observed <= LEASE_SECONDS:
            raise Rejected("target lease expired or invalid")
        target = document["target"]
        if target is None:
            return None
        if set(target) != {"ip", "container", "network"}:
            raise Rejected("invalid target fields")
        ipv4(target["ip"])
        identifier(target["container"])
        identifier(target["network"])
        return target
    except (TypeError, KeyError) as error:
        raise Rejected("malformed target state") from error


def read_target(source=STATE, owner=0):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r", encoding="ascii") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner \
                or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > 1024:
            raise Rejected("unsafe target file")
        return validate_state(json.loads(stream.read(1025)), clock())
