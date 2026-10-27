"""Push the Windows agent over WinRM. The password is used once and is not stored.

The target must be a private LAN address. The remote command downloads the
stamped EXE from this panel and starts it with --install --silent, so the
person at the PC gets no wizard and no console. The tray icon is the agent
that already ships with Corax.
"""

from __future__ import annotations

import ipaddress
import re
import socket
import time

from app.linux_install import clean_server, clean_token

_HOST = re.compile(
    r"^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$"
    r"|^(?:\d{1,3}\.){3}\d{1,3}$"
)
_STAGE_SECONDS = 600
_staged: dict[str, tuple[float, bytes]] = {}


class WindowsInstallError(Exception):
    pass


def _private(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if not isinstance(addr, ipaddress.IPv4Address):
        return False
    return bool(
        addr.is_private
        and not addr.is_loopback
        and not addr.is_link_local
        and not addr.is_reserved
        and not addr.is_unspecified
    )


def assert_lan_host(value: str) -> str:
    """Reject anything that is not a private IPv4 name on this network."""
    host = (value or "").strip()
    if not _HOST.fullmatch(host):
        raise ValueError("Некорректный адрес компьютера")
    if re.fullmatch(r"(?:\d{1,3}\.){3}\d{1,3}", host):
        if not _private(host):
            raise ValueError("Ставить агент можно только на адрес локальной сети")
        return host
    try:
        infos = socket.getaddrinfo(host, None, socket.AF_INET)
    except socket.gaierror as exc:
        raise ValueError("Компьютер не находится в локальной сети") from exc
    ips = [item[4][0] for item in infos if item and item[4]]
    if not ips or any(not _private(ip) for ip in ips):
        raise ValueError("Ставить агент можно только на адрес локальной сети")
    return host


def clean_winrm_user(value: str) -> str:
    user = (value or "").strip()
    if not user or len(user) > 128 or any(ch in user for ch in "\r\n\x00\"'`$"):
        raise ValueError("Некорректный пользователь")
    return user


def clean_winrm_password(value: str) -> str:
    password = value or ""
    if not password or len(password) > 256 or any(ch in password for ch in "\r\n\x00"):
        raise ValueError("Некорректный пароль")
    return password


def stage_windows_exe(token: str, data: bytes) -> None:
    now = time.time()
    stale = [key for key, (ts, _) in _staged.items() if now - ts > _STAGE_SECONDS]
    for key in stale:
        _staged.pop(key, None)
    _staged[token] = (now, data)


def claim_windows_exe(token: str) -> bytes | None:
    item = _staged.pop(token, None)
    if item is None or time.time() - item[0] > _STAGE_SECONDS:
        return None
    return item[1]


def discard_windows_exe(token: str) -> None:
    _staged.pop(token, None)


def remote_script(server: str, token: str) -> str:
    """Hidden install. The EXE copies itself into ProgramData and opens the tray."""
    server = clean_server(server)
    token = clean_token(token)
    url = f"{server}/api/v1/agent/windows-installer"
    safe_url = url.replace("'", "")
    safe_token = token.replace("'", "")
    return f"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
add-type @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class CoraxPanelTrust : ICertificatePolicy {{
  public bool CheckValidationResult(ServicePoint s, X509Certificate c, WebRequest r, int p) {{ return true; }}
}}
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object CoraxPanelTrust
$dir = Join-Path $env:TEMP 'CORAX'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'CORAX-Agent.exe'
Invoke-WebRequest -Uri '{safe_url}' -Headers @{{ Authorization = 'Bearer {safe_token}' }} -OutFile $exe -UseBasicParsing
$proc = Start-Process -FilePath $exe -ArgumentList @('--install','--silent') -WindowStyle Hidden -Wait -PassThru
if ($null -eq $proc) {{ exit 1 }}
exit $proc.ExitCode
""".strip()


_AGENT_EXE = r"C:\ProgramData\CORAX\Agent\CORAX-Agent.exe"
_AGENT_SHARE_PATH = r"ProgramData\CORAX\Agent\CORAX-Agent.exe"


def split_account(value: str) -> tuple[str, str]:
    """DOMAIN\\user or user@domain. A bare name is a local account."""
    user = clean_winrm_user(value)
    if "\\" in user:
        domain, name = user.split("\\", 1)
        if not domain or not name:
            raise ValueError("Некорректный пользователь")
        return domain, name
    if "@" in user:
        name, domain = user.split("@", 1)
        if not name or not domain:
            raise ValueError("Некорректный пользователь")
        return domain, name
    return "", user


def agent_launch_command() -> str:
    """The only program a remote install is allowed to start."""
    return f'"{_AGENT_EXE}" --install --silent'


def _upload(conn, data: bytes) -> None:
    for folder in (r"ProgramData\CORAX", r"ProgramData\CORAX\Agent"):
        try:
            conn.createDirectory("C$", folder)
        except Exception:
            pass
    view = memoryview(data)
    offset = 0

    def reader(size: int) -> bytes:
        nonlocal offset
        if offset >= len(view):
            return b""
        chunk = bytes(view[offset : offset + size])
        offset += len(chunk)
        return chunk

    conn.putFile("C$", _AGENT_SHARE_PATH, reader)


def _start_quietly(host: str, domain: str, user: str, password: str) -> int:
    """Start the copied agent through WMI. It is not a service, so SCM cannot host it."""
    from impacket.dcerpc.v5.dcom.wmi import CLSID_WbemLevel1Login, IID_IWbemLevel1Login, IWbemLevel1Login
    from impacket.dcerpc.v5.dcomrt import DCOMConnection
    from impacket.dcerpc.v5.dtypes import NULL

    dcom = DCOMConnection(host, user, password, domain, oxidResolver=True)
    try:
        interface = dcom.CoCreateInstanceEx(CLSID_WbemLevel1Login, IID_IWbemLevel1Login)
        login = IWbemLevel1Login(interface)
        services = login.NTLMLogin("//./root/cimv2", NULL, NULL)
        login.RemRelease()
        process, _ = services.GetObject("Win32_Process")
        created = process.Create(agent_launch_command(), r"C:\ProgramData\CORAX\Agent", None)
        code = int(getattr(created, "ReturnValue", 1) or 0)
        if code != 0:
            raise WindowsInstallError(f"Компьютер не запустил агент (код {code})")
        return int(getattr(created, "ProcessId", 0) or 0)
    finally:
        try:
            dcom.disconnect()
        except Exception:
            pass


def push_over_smb(host: str, user: str, password: str, exe: bytes) -> dict:
    """Copy the agent into C$ and start it. Same idea as an antivirus console."""
    host = assert_lan_host(host)
    password = clean_winrm_password(password)
    domain, name = split_account(user)
    if not exe.startswith(b"MZ"):
        raise ValueError("Файл агента повреждён")
    try:
        from impacket.smbconnection import SMBConnection
        from impacket.dcerpc.v5.dcom.wmi import CLSID_WbemLevel1Login, IID_IWbemLevel1Login  # noqa: F401
    except ImportError as exc:
        raise WindowsInstallError("На сервере Corax нет пакета impacket") from exc
    try:
        conn = SMBConnection(host, host, sess_port=445)
        conn.login(name, password, domain)
        try:
            _upload(conn, exe)
        finally:
            try:
                conn.close()
            except Exception:
                pass
        pid = _start_quietly(host, domain, name, password)
    except WindowsInstallError:
        raise
    except Exception as exc:
        raise WindowsInstallError(
            "Общая папка не открылась. Нужны учётка администратора и порты 445 и 135."
        ) from exc
    return {"ok": True, "exit_code": 0, "output": f"запущен, pid {pid}" if pid else "запущен"}


def _redact(text: str, *secrets: str) -> str:
    for secret in secrets:
        if secret:
            text = text.replace(secret, "…")
    return text


def push_over_winrm(host: str, port: int, user: str, password: str, server: str, token: str) -> dict:
    host = assert_lan_host(host)
    user = clean_winrm_user(user)
    password = clean_winrm_password(password)
    server = clean_server(server)
    token = clean_token(token)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise ValueError("Некорректный порт WinRM")
    try:
        import winrm
    except ImportError as exc:
        raise WindowsInstallError("На сервере Corax нет пакета pywinrm") from exc
    scheme = "https" if port == 5986 else "http"
    endpoint = f"{scheme}://{host}:{port}/wsman"
    session = winrm.Session(
        endpoint,
        auth=(user, password),
        transport="ntlm",
        operation_timeout_sec=180,
        read_timeout_sec=200,
        server_cert_validation="ignore",
    )
    script = remote_script(server, token)
    try:
        result = session.run_ps(script)
    except Exception as exc:
        raise WindowsInstallError(
            "WinRM не ответил. На компьютере нужен запущенный WinRM (порт 5985) и учётка администратора."
        ) from exc
    stdout = result.std_out.decode("utf-8", errors="replace") if result.std_out else ""
    stderr = result.std_err.decode("utf-8", errors="replace") if result.std_err else ""
    output = _redact((stdout + "\n" + stderr).strip(), token, password)[:4000]
    code = int(result.status_code)
    return {"ok": code == 0, "exit_code": code, "output": output}
