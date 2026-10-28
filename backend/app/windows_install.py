"""Push the Windows agent over WinRM. The password is used once and is not stored.

The target must be a private LAN address. The remote command downloads the
stamped EXE from this panel and starts it with --install --silent, so the
person at the PC gets no wizard and no console. The tray icon is the agent
that already ships with Corax.
"""

from __future__ import annotations

import ipaddress
import logging
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


log = logging.getLogger(__name__)


class WindowsInstallError(Exception):
    pass


_LOGON_STATUS = {
    0xC0000064,  # no such user
    0xC000006A,  # wrong password
    0xC000006D,  # logon failure
    0xC000006E,  # account restriction
    0xC000006F,  # invalid logon hours
    0xC0000071,  # password expired
    0xC0000072,  # account disabled
    0xC000015B,  # logon type not granted
    0xC0000234,  # locked out
}
_ACCESS_STATUS = {
    0xC0000022,  # access denied
    0xC0000061,  # privilege not held
}
_MISSING_STATUS = {
    0xC0000034,  # object name not found
    0xC000003A,  # object path not found
    0xC00000CC,  # bad network name
}


def _nt_status(exc: BaseException) -> int | None:
    code = getattr(exc, "error", None)
    if not isinstance(code, int):
        getter = getattr(exc, "getErrorCode", None)
        if callable(getter):
            try:
                code = getter()
            except Exception:
                code = None
    if isinstance(code, int):
        return code & 0xFFFFFFFF
    return None


def _refused(exc: BaseException) -> bool:
    errno = getattr(exc, "errno", None)
    if errno in (111, 10061):
        return True
    text = str(exc).lower()
    return "connection refused" in text or "10061" in text


def _timed_out(exc: BaseException) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    errno = getattr(exc, "errno", None)
    if errno in (110, 10060):
        return True
    text = str(exc).lower()
    return "timed out" in text or "timeout" in text


def explain_remote_failure(exc: BaseException, stage: str) -> str:
    """Say what actually stopped. Do not blame a port that already accepted a session."""
    status = _nt_status(exc)
    if stage == "connect":
        if _refused(exc):
            return "Порт 445 отказал в подключении."
        if _timed_out(exc):
            return "Порт 445 не ответил вовремя."
        return "Сессия SMB не открылась. Если порт 445 слушает, дело не в закрытом порте."
    if stage == "login":
        if status in _LOGON_STATUS:
            return "Порт 445 открыт, но учётка не вошла. Проверьте имя и пароль. Локального администратора пишите как КОМПЬЮТЕР\\пользователь."
        if _refused(exc) or _timed_out(exc):
            return "Порт 445 оборвал вход."
        return "Порт 445 ответил, но вход не прошёл."
    if stage == "copy":
        if status in _ACCESS_STATUS:
            return (
                "Вход прошёл, но Windows не дала записать файл. "
                "Обычного локального администратора она режет именно так: подключиться можно, записать нельзя. "
                "Dr.Web в этой ситуации ставится встроенным Администратором или доменным администратором — их этот фильтр не касается. "
                "Если учётка уже такая, запись останавливает сам Dr.Web."
            )
        if status in _MISSING_STATUS:
            return "Вход прошёл, но служебная папка ADMIN$ или C$ на компьютере не открыта."
        if status in _LOGON_STATUS:
            return "Запись в служебную папку не прошла: учётка не принята."
        code = f" Код {status:08X}." if status is not None else ""
        return "Вход прошёл, записать агент в служебную папку не удалось." + code
    if status in _ACCESS_STATUS:
        return (
            "Агент уже скопирован. Порт 135 слушает, но запуск отклонили: "
            "у учётки нет права запускать процессы или закрыт диапазон RPC."
        )
    if _refused(exc):
        return "Агент уже скопирован, но порт 135 отказал в запуске."
    if _timed_out(exc):
        return "Агент уже скопирован. Порт 135 не довёл запуск до конца: чаще не отвечает диапазон RPC."
    return "Агент уже скопирован, запустить его удалённо не удалось. Открытый порт 135 этого не гарантирует."


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
$dir = Join-Path $env:TEMP 'CORAX'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$exe = Join-Path $dir 'CORAX-Agent.exe'
Invoke-WebRequest -Uri '{safe_url}' -Headers @{{ Authorization = 'Bearer {safe_token}' }} -OutFile $exe -UseBasicParsing
$proc = Start-Process -FilePath $exe -ArgumentList @('--install','--silent') -WindowStyle Hidden -Wait -PassThru
if ($null -eq $proc) {{ exit 1 }}
exit $proc.ExitCode
""".strip()


_AGENT_EXE = r"C:\ProgramData\CORAX\Agent\CORAX-Agent.exe"
# Same drop as a console installer: ADMIN$ is C:\Windows, Temp already exists.
_COPY_TARGETS = (
    ("ADMIN$", r"Temp\CORAX-Agent.exe", r"C:\Windows\Temp\CORAX-Agent.exe", r"C:\Windows\Temp"),
    ("C$", r"Windows\Temp\CORAX-Agent.exe", r"C:\Windows\Temp\CORAX-Agent.exe", r"C:\Windows\Temp"),
)
_LAUNCH_EXES = {item[2] for item in _COPY_TARGETS} | {_AGENT_EXE}
_LAUNCH_DIRS = {item[3] for item in _COPY_TARGETS} | {r"C:\ProgramData\CORAX\Agent"}
# Fixed commands. They only stop this agent's own task and process before the new file is written.
_REPLACE_COMMANDS = (
    r'C:\Windows\System32\schtasks.exe /End /TN "CORAX Agent"',
    r'C:\Windows\System32\schtasks.exe /End /TN "CORAX Agent Tray"',
    r"C:\Windows\System32\taskkill.exe /F /IM CORAX-Agent.exe",
)


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


def copy_targets() -> tuple[tuple[str, str, str, str], ...]:
    return _COPY_TARGETS


def replace_commands() -> tuple[str, ...]:
    return _REPLACE_COMMANDS


def agent_launch_command(exe: str | None = None) -> str:
    """The only program a remote install is allowed to start."""
    path = _AGENT_EXE if exe is None else exe
    if path not in _LAUNCH_EXES:
        raise ValueError("Некорректный путь запуска")
    return f'"{path}" --install --silent'


def _put_file(conn, share: str, path: str, data: bytes) -> None:
    view = memoryview(data)
    offset = 0

    def reader(size: int) -> bytes:
        nonlocal offset
        if offset >= len(view):
            return b""
        chunk = bytes(view[offset : offset + size])
        offset += len(chunk)
        return chunk

    conn.putFile(share, path, reader)


def _upload(conn, data: bytes) -> tuple[str, str]:
    """Copy into Windows Temp. The agent then installs itself into ProgramData."""
    last: BaseException | None = None
    for share, remote, local, cwd in _COPY_TARGETS:
        try:
            _put_file(conn, share, remote, data)
            return local, cwd
        except Exception as exc:
            last = exc
            log.warning("windows install copy to %s failed: %s", share, type(exc).__name__)
    if last is None:
        raise WindowsInstallError("Некуда копировать агент")
    raise last


def _start_quietly(host: str, domain: str, user: str, password: str, exe: str, cwd: str) -> int:
    """Start the copied agent through WMI. It is not a service, so SCM cannot host it."""
    from impacket.dcerpc.v5.dcom.wmi import CLSID_WbemLevel1Login, IID_IWbemLevel1Login, IWbemLevel1Login
    from impacket.dcerpc.v5.dcomrt import DCOMConnection
    from impacket.dcerpc.v5.dtypes import NULL

    dcom = DCOMConnection(host, user, password, domain, oxidResolver=False)
    try:
        interface = dcom.CoCreateInstanceEx(CLSID_WbemLevel1Login, IID_IWbemLevel1Login)
        login = IWbemLevel1Login(interface)
        services = login.NTLMLogin("//./root/cimv2", NULL, NULL)
        login.RemRelease()
        if exe not in _LAUNCH_EXES or cwd not in _LAUNCH_DIRS:
            raise WindowsInstallError("Некорректный путь запуска")
        process, _ = services.GetObject("Win32_Process")
        for command in _REPLACE_COMMANDS:
            try:
                process.Create(command, r"C:\Windows\System32", None)
            except Exception:
                log.warning("windows install could not stop the previous agent")
        time.sleep(1.5)
        created = process.Create(agent_launch_command(exe), cwd, None)
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
    """Copy the agent into Windows Temp and start it, the way a console installer does."""
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
    except Exception as exc:
        log.warning("windows install connect failed: %s", type(exc).__name__)
        raise WindowsInstallError(explain_remote_failure(exc, "connect")) from exc
    try:
        conn.login(name, password, domain)
    except Exception as exc:
        log.warning("windows install login failed: %s", type(exc).__name__)
        try:
            conn.close()
        except Exception:
            pass
        raise WindowsInstallError(explain_remote_failure(exc, "login")) from exc
    try:
        placed, cwd = _upload(conn, exe)
    except WindowsInstallError:
        raise
    except Exception as exc:
        log.warning("windows install copy failed: %s", type(exc).__name__)
        raise WindowsInstallError(explain_remote_failure(exc, "copy")) from exc
    finally:
        try:
            conn.close()
        except Exception:
            pass
    try:
        pid = _start_quietly(host, domain, name, password, placed, cwd)
    except WindowsInstallError:
        raise
    except Exception as exc:
        log.warning("windows install start failed: %s", type(exc).__name__)
        raise WindowsInstallError(explain_remote_failure(exc, "start")) from exc
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
