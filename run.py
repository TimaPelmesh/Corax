"""
Запуск из корня репозитория (без cd в backend/frontend):

  python run.py

По умолчанию: host 0.0.0.0, port 3001 (API), отдельно web обычно на 3000.
(один адрес для браузера и агентов в ЛВС).

Свой порт:  set PORT=8001 перед запуском (если 3000 занят — WinError 10013 и т.п.).
Только локально: set HOST=127.0.0.1

Разработка: npm start в корне — API + Vite (UI http://127.0.0.1:5173).

Прод (один порт, статика из FastAPI): npm run start:prod — сначала сборка фронта.

Переменная RELOAD=0 — без autoreload uvicorn (для start:prod).

Один раз зависимости Python: pip install -r backend/requirements.txt
"""
from __future__ import annotations

import os
import sys

_ROOT = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.join(_ROOT, "backend")


def main() -> None:
    if _BACKEND not in sys.path:
        sys.path.insert(0, _BACKEND)

    _scripts = os.path.join(_ROOT, "scripts")
    if _scripts not in sys.path:
        sys.path.insert(0, _scripts)
    from ensure_postgres import ensure_postgres

    ensure_postgres()

    os.chdir(_BACKEND)

    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "3001"))
    # Windows: uvicorn --reload + mass SNMP UDP sockets can hit select() FD limits (~512).
    reload_default = "0" if os.name == "nt" else "1"
    reload = os.environ.get("RELOAD", reload_default).strip().lower() not in (
        "0",
        "false",
        "no",
    )
    kw = {"host": host, "port": port, "reload": reload}
    if reload:
        kw["reload_dirs"] = [_BACKEND]
    uvicorn.run("app.main:app", **kw)


if __name__ == "__main__":
    main()
