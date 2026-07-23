"""Local CA + server TLS for admin / agent HTTPS (LAN).

Modes (state.json ``mode``):
  - ``http`` — plain HTTP on the listen port (agents stamp http://)
  - ``local_ca`` — CORAX-generated CA + leaf (deploy ca.crt via GPO / install script)
  - ``enterprise`` — imported leaf+key from AD / corporate CA (machines already trust root)

Files under backend/data/tls/ (gitignored). Private keys never leave the server
except via controlled download of CA *certificate* (public) for local_ca mode.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.types import CertificatePublicKeyTypes
from cryptography.x509.oid import NameOID

from app.config import settings

_BACKEND_DIR = Path(__file__).resolve().parent.parent
_HOSTNAME_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.\-]{0,251}[A-Za-z0-9])?$")

TlsMode = Literal["http", "local_ca", "enterprise"]
VALID_MODES: frozenset[str] = frozenset({"http", "local_ca", "enterprise"})


def tls_dir() -> Path:
    raw = (getattr(settings, "tls_dir", None) or "data/tls").strip()
    p = Path(raw)
    if not p.is_absolute():
        p = _BACKEND_DIR / p
    return p


def _paths() -> dict[str, Path]:
    d = tls_dir()
    return {
        "dir": d,
        "state": d / "state.json",
        "ca_crt": d / "ca.crt",
        "ca_key": d / "ca.key",
        "server_crt": d / "server.crt",
        "server_key": d / "server.key",
    }


@dataclass(frozen=True)
class TlsRuntime:
    enabled: bool
    certfile: Path | None
    keyfile: Path | None


def _env_name() -> str:
    return (settings.environment or "").strip().lower()


def tls_force_env() -> bool:
    return (os.environ.get("CORAX_TLS_FORCE") or "").strip().lower() in ("1", "true", "yes")


def tls_blocked_in_dev() -> bool:
    """Panel TLS breaks Vite HTTP proxy (npm start). Require prod or CORAX_TLS_FORCE=1."""
    if tls_force_env():
        return False
    if (os.environ.get("CORAX_TLS_DISABLED") or "").strip().lower() in ("1", "true", "yes"):
        return True
    return _env_name() in ("development", "dev", "test")


def runtime_ssl() -> TlsRuntime:
    """Used by run.py — enable only when flag + files exist (and not blocked in dev)."""
    if tls_blocked_in_dev():
        return TlsRuntime(False, None, None)
    p = _paths()
    st = _read_state()
    mode = _infer_mode(st, p)
    enabled = bool(st.get("enabled")) and mode != "http"
    cert = p["server_crt"]
    key = p["server_key"]
    if not enabled or not cert.is_file() or not key.is_file():
        return TlsRuntime(False, None, None)
    return TlsRuntime(True, cert, key)


def process_listening_https() -> bool:
    return (os.environ.get("CORAX_TLS_LISTENING") or "").strip() in ("1", "true", "yes")


def mark_process_listening_https() -> None:
    os.environ["CORAX_TLS_LISTENING"] = "1"


def _read_state() -> dict[str, Any]:
    path = _paths()["state"]
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_state(data: dict[str, Any]) -> None:
    p = _paths()
    p["dir"].mkdir(parents=True, exist_ok=True)
    tmp = p["state"].with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p["state"])


def _chmod_private(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _parse_names(raw: list[str]) -> tuple[list[str], list[ipaddress.IPv4Address | ipaddress.IPv6Address]]:
    hosts: list[str] = []
    ips: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    seen: set[str] = set()
    for item in raw:
        s = (item or "").strip().lower()
        if not s or s in seen:
            continue
        seen.add(s)
        try:
            ips.append(ipaddress.ip_address(s))
            continue
        except ValueError:
            pass
        if s in ("localhost",) or _HOSTNAME_RE.match(s):
            hosts.append(s)
            continue
        raise ValueError(f"Некорректное имя/IP: {item!r}")
    if not hosts and not ips:
        raise ValueError("Укажите хотя бы один hostname или IP")
    # Always include loopback for local admin checks
    for loop in (ipaddress.ip_address("127.0.0.1"),):
        if loop not in ips:
            ips.append(loop)
    if "localhost" not in hosts:
        hosts.insert(0, "localhost")
    return hosts, ips


def _fingerprint_sha256(cert: x509.Certificate) -> str:
    dig = cert.fingerprint(hashes.SHA256())
    return ":".join(f"{b:02X}" for b in dig)


def _load_cert(path: Path) -> x509.Certificate | None:
    if not path.is_file():
        return None
    try:
        return x509.load_pem_x509_certificate(path.read_bytes())
    except Exception:
        return None


def _server_files_ok(p: dict[str, Path]) -> bool:
    return p["server_crt"].is_file() and p["server_key"].is_file()


def _infer_mode(st: dict[str, Any], p: dict[str, Path]) -> TlsMode:
    raw = str(st.get("mode") or "").strip().lower()
    if raw in VALID_MODES:
        return raw  # type: ignore[return-value]
    # Legacy state without mode
    if bool(st.get("enabled")) and _server_files_ok(p):
        if p["ca_crt"].is_file() and p["ca_key"].is_file():
            return "local_ca"
        return "enterprise"
    if _server_files_ok(p) and p["ca_crt"].is_file():
        return "local_ca"
    if _server_files_ok(p):
        return "enterprise"
    return "http"


def _names_from_cert(cert: x509.Certificate) -> list[str]:
    names: list[str] = []
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        for n in san:
            if isinstance(n, x509.DNSName):
                names.append(n.value)
            elif isinstance(n, x509.IPAddress):
                names.append(str(n.value))
    except x509.ExtensionNotFound:
        pass
    try:
        cn = cert.subject.get_attributes_for_oid(NameOID.COMMON_NAME)
        if cn:
            v = cn[0].value
            if isinstance(v, str) and v and v not in names:
                names.insert(0, v)
    except Exception:
        pass
    return names


def _public_keys_match(cert_key: CertificatePublicKeyTypes, priv: Any) -> bool:
    try:
        pub = priv.public_key()
        if type(pub) is not type(cert_key):
            return False
        # Compare encoded public numbers / SPKI
        a = pub.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        b = cert_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return a == b
    except Exception:
        return False


def status() -> dict[str, Any]:
    p = _paths()
    st = _read_state()
    leaf = _load_cert(p["server_crt"])
    files_ok = _server_files_ok(p)
    mode = _infer_mode(st, p)
    want_enabled = bool(st.get("enabled")) and files_ok and mode != "http"
    blocked = tls_blocked_in_dev()
    will_listen = want_enabled and not blocked
    active = process_listening_https()
    not_after = None
    fingerprint = None
    if leaf:
        not_after = leaf.not_valid_after_utc.isoformat().replace("+00:00", "Z")
        fingerprint = _fingerprint_sha256(leaf)
    # Restart needed when desired listen state != current process
    restart_required = (will_listen and not active) or (not will_listen and active)
    # Stamp https into agents when TLS is active or will be after restart
    agent_scheme = "https" if (will_listen or active) else "http"
    return {
        "enabled": want_enabled,
        "active": active,
        "mode": mode,
        "files_ready": files_ok,
        "ca_ready": p["ca_crt"].is_file(),
        "hostnames": list(st.get("hostnames") or []),
        "not_after": not_after or st.get("not_after"),
        "fingerprint_sha256": fingerprint or st.get("fingerprint_sha256"),
        "generated_at": st.get("generated_at"),
        "restart_required": restart_required,
        "dev_blocked": blocked and bool(st.get("enabled")) and files_ok,
        "tls_dir": str(p["dir"]),
        "agent_scheme": agent_scheme,
    }


def set_enabled(enabled: bool) -> dict[str, Any]:
    p = _paths()
    st = _read_state()
    mode = _infer_mode(st, p)
    if enabled:
        if not _server_files_ok(p):
            raise ValueError("Сначала создайте или импортируйте сертификат")
        if mode == "http":
            # Prefer local_ca when CA exists, else enterprise
            mode = "local_ca" if p["ca_crt"].is_file() else "enterprise"
        st["mode"] = mode
        st["enabled"] = True
    else:
        st["enabled"] = False
        st["mode"] = "http"
    st["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    _write_state(st)
    return status()


def set_mode(mode: str) -> dict[str, Any]:
    """Switch deployment profile. ``http`` disables TLS; other modes require cert files."""
    m = (mode or "").strip().lower()
    if m not in VALID_MODES:
        raise ValueError("Режим: http, local_ca или enterprise")
    p = _paths()
    st = _read_state()
    if m == "http":
        st["mode"] = "http"
        st["enabled"] = False
    else:
        if not _server_files_ok(p):
            raise ValueError("Сначала создайте (local_ca) или импортируйте (enterprise) сертификат")
        if m == "local_ca" and not p["ca_crt"].is_file():
            raise ValueError("Для режима local_ca сначала создайте сертификат CORAX Local CA")
        st["mode"] = m
        st["enabled"] = True
    st["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    _write_state(st)
    return status()


def ca_pem() -> bytes:
    path = _paths()["ca_crt"]
    if not path.is_file():
        raise FileNotFoundError("CA ещё не создан")
    return path.read_bytes()


def generate(hostnames: list[str], days: int = 825, rotate_ca: bool = False) -> dict[str, Any]:
    """Create (or reuse) local CA and issue a server certificate with SANs."""
    if days < 1 or days > 3650:
        raise ValueError("Срок сертификата: от 1 до 3650 дней")
    hosts, ips = _parse_names(hostnames)
    p = _paths()
    p["dir"].mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc)
    ca_path, ca_key_path = p["ca_crt"], p["ca_key"]

    if rotate_ca or not ca_path.is_file() or not ca_key_path.is_file():
        ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        ca_name = x509.Name(
            [
                x509.NameAttribute(NameOID.COUNTRY_NAME, "RU"),
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "CORAX"),
                x509.NameAttribute(NameOID.COMMON_NAME, "CORAX Local CA"),
            ]
        )
        ca_cert = (
            x509.CertificateBuilder()
            .subject_name(ca_name)
            .issuer_name(ca_name)
            .public_key(ca_key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=max(days, 3650)))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=True,
                    key_cert_sign=True,
                    crl_sign=True,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256())
        )
        ca_key_path.write_bytes(
            ca_key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        _chmod_private(ca_key_path)
        ca_path.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    else:
        ca_cert = x509.load_pem_x509_certificate(ca_path.read_bytes())
        ca_key = serialization.load_pem_private_key(ca_key_path.read_bytes(), password=None)

    server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # Prefer a real LAN name/IP for CN (localhost is always in SAN anyway).
    cn_candidates = [h for h in hosts if h not in ("localhost",)] + [str(ip) for ip in ips if str(ip) != "127.0.0.1"]
    cn = (cn_candidates[0] if cn_candidates else (hosts[0] if hosts else str(ips[0])))[:64]
    subject = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "RU"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "CORAX"),
            x509.NameAttribute(NameOID.COMMON_NAME, cn),
        ]
    )
    san: list[x509.GeneralName] = [x509.DNSName(h) for h in hosts]
    san.extend(x509.IPAddress(ip) for ip in ips)

    try:
        ca_ski = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value
    except x509.ExtensionNotFound:
        ca_ski = x509.SubjectKeyIdentifier.from_public_key(ca_cert.public_key())
    server_cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(ca_cert.subject)
        .public_key(server_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=days))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True,
                key_encipherment=True,
                key_cert_sign=False,
                crl_sign=False,
                content_commitment=False,
                data_encipherment=False,
                key_agreement=False,
                encipher_only=False,
                decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(
            x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),
            critical=False,
        )
        .add_extension(x509.SubjectAlternativeName(san), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(server_key.public_key()), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_subject_key_identifier(ca_ski),
            critical=False,
        )
        .sign(ca_key, hashes.SHA256())
    )

    # Chain: leaf + CA (browsers that don't have CA still see intermediate; with CA installed leaf is enough)
    chain_pem = (
        server_cert.public_bytes(serialization.Encoding.PEM)
        + ca_cert.public_bytes(serialization.Encoding.PEM)
    )
    p["server_crt"].write_bytes(chain_pem)
    p["server_key"].write_bytes(
        server_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    _chmod_private(p["server_key"])

    name_list = [*hosts, *[str(ip) for ip in ips]]
    st = _read_state()
    prev_enabled = bool(st.get("enabled"))
    st.update(
        {
            "mode": "local_ca",
            "enabled": prev_enabled,  # keep toggle; admin enables explicitly
            "hostnames": name_list,
            "generated_at": now.isoformat().replace("+00:00", "Z"),
            "not_after": server_cert.not_valid_after_utc.isoformat().replace("+00:00", "Z"),
            "fingerprint_sha256": _fingerprint_sha256(server_cert),
            "days": days,
        }
    )
    _write_state(st)
    return status()


def import_enterprise(cert_pem: str | bytes, key_pem: str | bytes) -> dict[str, Any]:
    """Install a leaf (+ optional chain) and private key from a corporate / AD CA."""
    cert_bytes = cert_pem.encode("utf-8") if isinstance(cert_pem, str) else cert_pem
    key_bytes = key_pem.encode("utf-8") if isinstance(key_pem, str) else key_pem
    if not cert_bytes.strip() or not key_bytes.strip():
        raise ValueError("Нужны PEM сертификата и закрытого ключа")

    try:
        certs = x509.load_pem_x509_certificates(cert_bytes)
    except Exception as e:
        raise ValueError(f"Не удалось разобрать сертификат PEM: {e}") from e
    if not certs:
        raise ValueError("В PEM нет сертификатов")
    leaf = certs[0]

    try:
        priv = serialization.load_pem_private_key(key_bytes, password=None)
    except TypeError as e:
        raise ValueError("Ключ защищён паролем — используйте незашифрованный PEM") from e
    except Exception as e:
        raise ValueError(f"Не удалось разобрать ключ PEM: {e}") from e

    if not _public_keys_match(leaf.public_key(), priv):
        raise ValueError("Закрытый ключ не соответствует сертификату")

    try:
        bc = leaf.extensions.get_extension_for_class(x509.BasicConstraints).value
        if bc.ca:
            raise ValueError("Это CA-сертификат; нужен серверный (leaf) сертификат")
    except x509.ExtensionNotFound:
        pass

    p = _paths()
    p["dir"].mkdir(parents=True, exist_ok=True)
    p["server_crt"].write_bytes(cert_bytes if cert_bytes.endswith(b"\n") else cert_bytes + b"\n")
    p["server_key"].write_bytes(
        priv.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    _chmod_private(p["server_key"])

    now = datetime.now(timezone.utc)
    names = _names_from_cert(leaf)
    st = _read_state()
    prev_enabled = bool(st.get("enabled"))
    st.update(
        {
            "mode": "enterprise",
            "enabled": prev_enabled,
            "hostnames": names or list(st.get("hostnames") or []),
            "generated_at": now.isoformat().replace("+00:00", "Z"),
            "not_after": leaf.not_valid_after_utc.isoformat().replace("+00:00", "Z"),
            "fingerprint_sha256": _fingerprint_sha256(leaf),
            "source": "enterprise_import",
        }
    )
    _write_state(st)
    return status()
