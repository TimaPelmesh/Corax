"""One-command Linux agent install, and the same install over SSH.

The remote command is this installer only. The password is not stored and is
not placed on the remote command line.
"""

from __future__ import annotations

import json
import re
import shlex
import time
from contextlib import contextmanager
from urllib.parse import quote

_INTERVALS = {0, 15, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400}
_SERVER = re.compile(r"^https?://[A-Za-z0-9._:-]{3,200}$")
_TOKEN = re.compile(r"^[A-Za-z0-9._-]{8,256}$")
_HOST = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$"
    r"|^(?:\d{1,3}\.){3}\d{1,3}$"
)
_USER = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}$")

_INSTALLER = r"""
import io
import os
import sys
import urllib.request
import zipfile

CFG = __PAYLOAD__
ROOT = "/opt/corax-agent"
SERVER = str(CFG["server"]).rstrip("/")
TOKEN = str(CFG["token"])
INTERVAL = int(CFG["interval"])


def die(msg):
    sys.stderr.write(str(msg) + "\n")
    raise SystemExit(1)


try:
    path = globals().get("__file__") or ""
    if path:
        os.remove(path)
except OSError:
    pass

if hasattr(os, "geteuid") and os.geteuid() != 0:
    die("run as root")

os.makedirs(ROOT, exist_ok=True)
req = urllib.request.Request(
    SERVER + "/api/v1/agent/linux-scripts",
    headers={"Authorization": "Bearer " + TOKEN},
)
try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        blob = resp.read()
except Exception as exc:
    die("scripts: " + str(exc))

with zipfile.ZipFile(io.BytesIO(blob)) as zf:
    for info in zf.infolist():
        name = info.filename
        if not name or name.startswith("/") or ".." in name.split("/"):
            die("bad path")
        target = os.path.join(ROOT, name)
        if name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            continue
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with zf.open(info) as src, open(target, "wb") as dst:
            dst.write(src.read())
        mode = (info.external_attr >> 16) & 0o777
        if mode & 0o111 or name.endswith(".sh"):
            os.chmod(target, 0o755)

env_path = os.path.join(ROOT, "agent_env.sh")
fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(
        "#!/bin/sh\n"
        "export INVENTORY_SERVER=\"%s\"\n"
        "export AGENT_TOKEN=\"%s\"\n"
        "export CORAX_AUDIT_INTERVAL=\"%s\"\n" % (SERVER, TOKEN, INTERVAL)
    )

sys.stdout.write("corax-agent: scripts unpacked\n")
sys.stdout.flush()
code = os.spawnv(os.P_WAIT, "/bin/sh", ["/bin/sh", os.path.join(ROOT, "corax_send.sh")])
sys.stdout.write("corax-agent: setup exit %s\n" % code)
sys.stdout.flush()
raise SystemExit(code if isinstance(code, int) else 1)
"""


class InstallError(Exception):
    pass


def clean_server(value: str) -> str:
    server = (value or "").strip().rstrip("/")
    if not _SERVER.fullmatch(server) or "'" in server or '"' in server:
        raise ValueError("Адрес панели должен быть http://хост:порт")
    return server


def clean_token(value: str) -> str:
    token = (value or "").strip()
    if not _TOKEN.fullmatch(token):
        raise ValueError("Некорректный токен агента")
    return token


def clean_interval(value: int) -> int:
    interval = int(value)
    if interval not in _INTERVALS:
        raise ValueError("Недопустимый интервал аудита")
    return interval


def clean_ssh_host(value: str) -> str:
    host = (value or "").strip()
    if not _HOST.fullmatch(host):
        raise ValueError("Некорректный SSH-хост")
    return host


def clean_ssh_user(value: str) -> str:
    user = (value or "").strip()
    if not _USER.fullmatch(user):
        raise ValueError("Некорректный SSH-пользователь")
    return user


def installer_source(server: str, token: str, interval: int) -> str:
    server = clean_server(server)
    token = clean_token(token)
    interval = clean_interval(interval)
    payload = json.dumps({"server": server, "token": token, "interval": interval}, ensure_ascii=True)
    return _INSTALLER.replace("__PAYLOAD__", payload, 1)


def one_command(server: str, token: str, interval: int) -> str:
    server = clean_server(server)
    token = clean_token(token)
    interval = clean_interval(interval)
    url = f"{server}/api/v1/agent/linux-install?interval={interval}&server={quote(server, safe='')}"
    inner = (
        'import urllib.request as u;exec(u.urlopen(u.Request("%s",headers={"Authorization":"Bearer %s"}),timeout=120).read())'
        % (url, token)
    )
    return "sudo python3 -c '%s'" % inner


def _redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "…")
    return text


def _check_login(host: str, port: int, user: str, password: str) -> tuple[str, int, str, str]:
    host = clean_ssh_host(host)
    user = clean_ssh_user(user)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise ValueError("Некорректный SSH-порт")
    if not password or len(password) > 256 or any(ch in password for ch in "\r\n\x00"):
        raise ValueError("Некорректный пароль SSH")
    return host, port, user, password


def _abort_channel(channel) -> None:
    try:
        channel.close()
    except Exception:
        pass


def _collect(stdout, timeout: float) -> tuple[int, str]:
    """Read the session until it exits.

    recv_ready() stays false while a PTY still holds output. The remote
    command then blocks on write and the channel never reports an exit.
    Always read with a short timeout, and treat an empty read as EOF.
    """
    channel = stdout.channel
    channel.settimeout(0.4)
    out = bytearray()
    deadline = time.monotonic() + max(1.0, timeout)
    while True:
        if time.monotonic() > deadline:
            _abort_channel(channel)
            raise InstallError("Команда не ответила. Проверьте пароль sudo и что SSH до хоста доходит.")
        try:
            chunk = channel.recv(65536)
        except TimeoutError:
            if channel.exit_status_ready():
                break
            continue
        except Exception:
            break
        if not chunk:
            break
        out += chunk
        if len(out) > 200_000:
            del out[:-200_000]
    status_deadline = time.monotonic() + 1.0
    while not channel.exit_status_ready() and time.monotonic() < status_deadline:
        time.sleep(0.05)
    code = 1
    if channel.exit_status_ready():
        try:
            code = int(channel.recv_exit_status())
        except Exception:
            code = 1
    return code, out.decode("utf-8", "replace")


@contextmanager
def _ssh_client(host: str, port: int, user: str, password: str):
    try:
        import paramiko
    except ImportError as exc:
        raise InstallError("На панели нет paramiko. Пересоберите образ.") from exc
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=user,
            password=password,
            timeout=20,
            banner_timeout=20,
            auth_timeout=20,
            allow_agent=False,
            look_for_keys=False,
        )
        transport = client.get_transport()
        if transport is not None:
            transport.set_keepalive(10)
        yield client
    except InstallError:
        raise
    except Exception as exc:
        message = _redact(str(exc) or exc.__class__.__name__, password)
        lowered = message.lower()
        if "authentication" in lowered or "auth fail" in lowered:
            raise InstallError("SSH не принял пароль") from exc
        raise InstallError(message[:400] or "SSH-подключение не удалось") from exc
    finally:
        client.close()


def _run(client, command: str, password: str, *, sudo: bool, timeout: float) -> tuple[int, str]:
    if sudo:
        command = "sudo -S -p '' " + command
    stdin, stdout, _stderr = client.exec_command(command, timeout=timeout, get_pty=True)
    try:
        if sudo:
            stdin.write(password + "\n")
            stdin.flush()
        try:
            stdin.close()
        except Exception:
            pass
        code, text = _collect(stdout, timeout)
    finally:
        _abort_channel(stdout.channel)
    text = _redact(text, password).strip()
    if not text:
        text = f"(команда завершилась без текста, код {code})"
    return code, text[-12000:]


def run_remote_command(host: str, port: int, user: str, password: str, command: str, timeout: float) -> dict:
    """Run one already-built command. The caller chooses the command, not the browser."""
    host, port, user, password = _check_login(host, port, user, password)
    try:
        with _ssh_client(host, port, user, password) as client:
            code, text = _run(client, command, password, sudo=user != "root", timeout=timeout)
    except (InstallError, ValueError):
        raise
    except Exception as exc:
        message = _redact(str(exc) or exc.__class__.__name__, password)
        raise InstallError(message[:400] or "SSH-подключение не удалось") from exc
    return {"ok": code == 0, "exit_code": code, "output": text}


def push_script_update(host: str, port: int, user: str, password: str) -> dict:
    """Upload the panel's script zip and apply it. The host does not guess the panel URL."""
    from app.agent_bundle import linux_scripts_zip_bytes

    host, port, user, password = _check_login(host, port, user, password)
    blob = linux_scripts_zip_bytes()
    try:
        return _push_script_update(host, port, user, password, blob)
    except (InstallError, ValueError):
        raise
    except Exception as exc:
        message = _redact(str(exc) or exc.__class__.__name__, password)
        raise InstallError(message[:400] or "Обновление скриптов по SSH не удалось") from exc


def _push_script_update(host: str, port: int, user: str, password: str, blob: bytes) -> dict:
    with _ssh_client(host, port, user, password) as client:
        sftp = client.open_sftp()
        with sftp.file(".corax-scripts.zip", "w") as remote:
            remote.write(blob)
        home = sftp.normalize(".").rstrip("/")
        sftp.close()
        src = home + "/.corax-scripts-src"
        extract = (
            "import os, shutil, zipfile\n"
            f"z={home + '/.corax-scripts.zip'!r}\n"
            f"s={src!r}\n"
            "shutil.rmtree(s, ignore_errors=True)\n"
            "os.makedirs(s, exist_ok=True)\n"
            "with zipfile.ZipFile(z) as zf:\n"
            "    zf.extractall(s)\n"
            "print('unpacked', s)\n"
        )
        code, unpacked = _run(client, "python3 -c " + shlex.quote(extract), password, sudo=False, timeout=60)
        if code != 0:
            return {"ok": False, "exit_code": code, "output": unpacked}
        apply = (
            "if [ ! -f /opt/corax-agent/update_scripts.sh ]; then "
            "echo 'На хосте нет /opt/corax-agent/update_scripts.sh. Сначала установите агента.'; exit 1; "
            "fi; /bin/sh /opt/corax-agent/update_scripts.sh " + shlex.quote(src)
        )
        applied_code, applied = _run(client, apply, password, sudo=user != "root", timeout=180)
    text = (unpacked + "\n" + applied).strip()
    return {"ok": applied_code == 0, "exit_code": applied_code, "output": text[-12000:]}


def push_over_ssh(host: str, port: int, user: str, password: str, script: str, token: str) -> dict:
    """Upload the installer into the login home and run it. Root via sudo -S when needed."""
    host, port, user, password = _check_login(host, port, user, password)
    try:
        with _ssh_client(host, port, user, password) as client:
            sftp = client.open_sftp()
            with sftp.file(".corax-install.py", "w") as remote:
                remote.write(script.encode("utf-8"))
            sftp.chmod(".corax-install.py", 0o700)
            home = sftp.normalize(".").rstrip("/")
            sftp.close()
            script_path = home + "/.corax-install.py"
            code, text = _run(
                client,
                "python3 " + shlex.quote(script_path),
                password,
                sudo=user != "root",
                timeout=180,
            )
            try:
                client.exec_command("rm -f " + shlex.quote(script_path))
            except Exception:
                pass
    except (InstallError, ValueError):
        raise
    except Exception as exc:
        message = _redact(str(exc) or exc.__class__.__name__, password, token)
        raise InstallError(message[:400] or "SSH-подключение не удалось") from exc
    text = _redact(text, password, token)
    return {"ok": code == 0, "exit_code": code, "output": text[-8000:]}
