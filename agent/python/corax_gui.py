"""
CORAX Agent — окно статуса (tkinter, встроено в PyInstaller onefile).
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import ttk

import requests

from agent import collect_report

try:
    from corax_embedded import SERVER as _EMBEDDED_SERVER, TOKEN as _EMBEDDED_TOKEN
except ImportError:
    _EMBEDDED_SERVER = ""
    _EMBEDDED_TOKEN = ""


def _pick_server() -> str:
    env = (os.environ.get("INVENTORY_SERVER") or "").strip().rstrip("/")
    if env:
        return env
    return (_EMBEDDED_SERVER or "").strip().rstrip("/")


def _pick_token() -> str:
    env = (os.environ.get("AGENT_TOKEN") or "").strip()
    if env:
        return env
    return (_EMBEDDED_TOKEN or "").strip()


def _queue_dir() -> Path:
    q = (os.environ.get("INVENTORY_QUEUE_DIR") or "").strip()
    if q:
        return Path(q)
    if sys.platform == "win32":
        root = (os.environ.get("ProgramData") or os.environ.get("TEMP") or "").strip()
        if root:
            return Path(root) / "InventoryAgent"
    return Path.home() / ".inventory_agent"


def _try_send(url: str, headers: dict[str, str], body: bytes) -> tuple[bool, str]:
    backoff = [2, 5, 15]
    last_err = ""
    for attempt in range(1, len(backoff) + 2):
        try:
            r = requests.post(url, data=body, headers=headers, timeout=120)
        except requests.RequestException as exc:
            last_err = str(exc)
            if attempt <= len(backoff):
                time.sleep(backoff[attempt - 1])
                continue
            return False, f"Сеть: {exc}"
        if r.status_code >= 500:
            last_err = f"HTTP {r.status_code}"
            if attempt <= len(backoff):
                time.sleep(backoff[attempt - 1])
                continue
            return False, f"Сервер: {r.status_code} {r.text[:200]}"
        if r.status_code >= 400:
            return False, f"Отклонено: {r.status_code} {r.text[:200]}"
        try:
            data = r.json()
            return True, f"OK — {data.get('hostname', data)}"
        except Exception:
            return True, "OK — отчёт принят"
    return False, last_err or "Неизвестная ошибка"


class CoraxAgentApp:
    def __init__(self) -> None:
        self.server = _pick_server()
        self.token = _pick_token()
        self.root = tk.Tk()
        self.root.title("CORAX Agent")
        self.root.geometry("440x320")
        self.root.minsize(400, 280)
        self.root.configure(bg="#f8fafc")
        self._status_var = tk.StringVar(value="Подготовка…")
        self._detail_var = tk.StringVar(value="")
        self._build_ui()
        self.root.after(120, self._start_work)

    def _build_ui(self) -> None:
        pad = {"padx": 20, "pady": 6}
        header = tk.Frame(self.root, bg="#0f172a", height=56)
        header.pack(fill=tk.X)
        header.pack_propagate(False)
        tk.Label(
            header,
            text="CORAX",
            font=("Segoe UI", 16, "bold"),
            fg="#f87171",
            bg="#0f172a",
        ).pack(side=tk.LEFT, padx=20, pady=12)
        tk.Label(
            header,
            text="Инвентаризация ПК",
            font=("Segoe UI", 11),
            fg="#e2e8f0",
            bg="#0f172a",
        ).pack(side=tk.LEFT, pady=14)

        body = tk.Frame(self.root, bg="#f8fafc")
        body.pack(fill=tk.BOTH, expand=True, **pad)

        tk.Label(
            body,
            text="Сервер",
            font=("Segoe UI", 9),
            fg="#64748b",
            bg="#f8fafc",
        ).pack(anchor=tk.W)
        srv = self.server or "— не задан —"
        tk.Label(
            body,
            text=srv,
            font=("Consolas", 10),
            fg="#0f172a",
            bg="#f1f5f9",
            anchor=tk.W,
            padx=10,
            pady=8,
        ).pack(fill=tk.X, pady=(2, 12))

        style = ttk.Style()
        if sys.platform == "win32":
            style.theme_use("vista")
        self.progress = ttk.Progressbar(body, mode="indeterminate", length=360)
        self.progress.pack(fill=tk.X, pady=(0, 10))
        self.progress.start(12)

        tk.Label(
            body,
            textvariable=self._status_var,
            font=("Segoe UI", 11, "bold"),
            fg="#0f172a",
            bg="#f8fafc",
            wraplength=380,
            justify=tk.LEFT,
        ).pack(anchor=tk.W)
        tk.Label(
            body,
            textvariable=self._detail_var,
            font=("Segoe UI", 9),
            fg="#64748b",
            bg="#f8fafc",
            wraplength=380,
            justify=tk.LEFT,
        ).pack(anchor=tk.W, pady=(4, 0))

        self.btn = ttk.Button(body, text="Закрыть", command=self.root.destroy, state=tk.DISABLED)
        self.btn.pack(pady=(16, 0))

    def _set_status(self, main: str, detail: str = "") -> None:
        self._status_var.set(main)
        self._detail_var.set(detail)

    def _start_work(self) -> None:
        if not self.server or not self.token:
            self.progress.stop()
            self._set_status(
                "Ошибка конфигурации",
                "Не задан адрес сервера или токен агента.",
            )
            self.btn.configure(state=tk.NORMAL)
            return
        threading.Thread(target=self._run_agent, daemon=True).start()

    def _run_agent(self) -> None:
        try:
            self.root.after(0, lambda: self._set_status("Сбор данных о компьютере…", "WMI, ПО, периферия"))
            report = collect_report()
            host = report.get("hostname") or "?"
            sw = len(report.get("software") or [])
            per = len(report.get("peripherals") or [])
            detail = f"{host} · ПО: {sw} · устройств: {per}"

            url = f"{self.server}/api/v1/agent/inventory"
            headers = {
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
            }
            payload = json.dumps(report, ensure_ascii=False).encode("utf-8")

            queue_dir = _queue_dir()
            queue_dir.mkdir(parents=True, exist_ok=True)
            queue_file = queue_dir / "pending_report.json"

            self.root.after(0, lambda: self._set_status("Отправка на сервер…", detail))

            if queue_file.is_file():
                try:
                    prev = queue_file.read_bytes()
                except OSError:
                    prev = b""
                if prev:
                    ok, _ = _try_send(url, headers, prev)
                    if ok:
                        try:
                            queue_file.unlink(missing_ok=True)
                        except OSError:
                            pass

            ok, msg = _try_send(url, headers, payload)
            if ok:
                self.root.after(0, lambda: self._on_success(msg, detail))
            else:
                try:
                    queue_file.write_bytes(payload)
                    msg += f"\nОтчёт сохранён: {queue_file}"
                except OSError:
                    pass
                self.root.after(0, lambda: self._on_error(msg))
        except Exception as exc:
            self.root.after(0, lambda: self._on_error(str(exc)))

    def _on_success(self, msg: str, detail: str) -> None:
        self.progress.stop()
        self.progress.configure(mode="determinate", value=100)
        self._set_status("Готово", f"{detail}\n{msg}")
        self.btn.configure(state=tk.NORMAL)
        self.root.after(4000, self.root.destroy)

    def _on_error(self, msg: str) -> None:
        self.progress.stop()
        self._set_status("Ошибка", msg)
        self.btn.configure(state=tk.NORMAL)

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    if not _pick_server() or not _pick_token():
        return 2
    CoraxAgentApp().run()
    return 0
