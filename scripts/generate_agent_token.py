#!/usr/bin/env python3
"""Генерация AGENT_TOKEN для backend/.env и настроек агента (одно и то же значение везде).

Использует secrets (CSPRNG ОС) — предпочтительнее случайного набора на клавиатуре.
Запуск из корня репозитория: python scripts/generate_agent_token.py
"""

from __future__ import annotations

import argparse
import secrets


def main() -> None:
    p = argparse.ArgumentParser(description="Сгенерировать AGENT_TOKEN для сервера и агентов.")
    p.add_argument(
        "--bytes",
        type=int,
        default=32,
        metavar="N",
        help="длина токена в байтах (по умолчанию 32 → ~43 символа в base64url)",
    )
    args = p.parse_args()
    if args.bytes < 16:
        p.error("минимум 16 байт (в production сервер ожидает AGENT_TOKEN не короче 16 символов)")

    token = secrets.token_urlsafe(args.bytes)
    print(token)
    print()
    print("Добавьте на сервере в backend/.env:")
    print(f"  AGENT_TOKEN={token}")
    print()
    print("На ПК с агентом — то же значение, например в inventory_send.bat:")
    print(f'  set "AGENT_TOKEN={token}"')
    print("или переменная окружения AGENT_TOKEN перед запуском agent.py / PowerShell.")
    print()
    print("Альтернатива: отдельный ключ на машину в панели «Токены агентов» (формат public_id.secret).")


if __name__ == "__main__":
    main()
