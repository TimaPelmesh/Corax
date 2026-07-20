from __future__ import annotations

from pathlib import Path

from cryptography import x509

from app import tls_certs


def test_generate_local_ca_and_server(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(tls_certs, "tls_dir", lambda: tmp_path)
    monkeypatch.setenv("CORAX_TLS_FORCE", "1")

    st = tls_certs.generate(["10.0.0.5", "corax.test"], days=90)
    assert st["files_ready"] is True
    assert st["ca_ready"] is True
    assert st["enabled"] is False
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
    assert st2["restart_required"] is True

    rt = tls_certs.runtime_ssl()
    assert rt.enabled is True
    assert rt.certfile and rt.keyfile
