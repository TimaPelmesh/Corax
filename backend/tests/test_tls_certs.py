from __future__ import annotations

import ipaddress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app import tls_certs


def test_generate_local_ca_and_server(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tls_certs, "tls_dir", lambda: tmp_path)
    monkeypatch.setenv("CORAX_TLS_FORCE", "1")

    st = tls_certs.generate(["10.0.0.5", "corax.test"], days=90)
    assert st["files_ready"] is True
    assert st["ca_ready"] is True
    assert st["enabled"] is False
    assert st["mode"] == "local_ca"
    assert st["agent_scheme"] == "http"
    assert "10.0.0.5" in st["hostnames"]
    assert (tmp_path / "ca.crt").is_file()
    assert (tmp_path / "server.key").is_file()

    pem = tls_certs.ca_pem()
    assert b"BEGIN CERTIFICATE" in pem

    leaf = x509.load_pem_x509_certificate((tmp_path / "server.crt").read_bytes())
    sans = leaf.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    dns = {n.value for n in sans if isinstance(n, x509.DNSName)}
    assert "corax.test" in dns
    assert "localhost" in dns

    st2 = tls_certs.set_enabled(True)
    assert st2["enabled"] is True
    assert st2["mode"] == "local_ca"
    assert st2["agent_scheme"] == "https"
    assert st2["restart_required"] is True

    rt = tls_certs.runtime_ssl()
    assert rt.enabled is True
    assert rt.certfile and rt.keyfile

    st3 = tls_certs.set_mode("http")
    assert st3["enabled"] is False
    assert st3["mode"] == "http"
    assert st3["agent_scheme"] == "http"


def test_import_enterprise_cert(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tls_certs, "tls_dir", lambda: tmp_path)
    monkeypatch.setenv("CORAX_TLS_FORCE", "1")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = datetime.now(timezone.utc)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "corax.ad.example")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.SubjectAlternativeName(
                [
                    x509.DNSName("corax.ad.example"),
                    x509.IPAddress(ipaddress.ip_address("10.1.2.3")),
                ]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()

    st = tls_certs.import_enterprise(cert_pem, key_pem)
    assert st["files_ready"] is True
    assert st["mode"] == "enterprise"
    assert "corax.ad.example" in st["hostnames"]
    assert "10.1.2.3" in st["hostnames"]

    st2 = tls_certs.set_mode("enterprise")
    assert st2["enabled"] is True
    assert st2["agent_scheme"] == "https"
    assert st2["ca_ready"] is False
