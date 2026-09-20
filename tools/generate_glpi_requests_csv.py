"""Generate a deterministic GLPI CSV for testing bulk ticket imports."""

from __future__ import annotations

import argparse
import csv
import random
from datetime import datetime, timedelta
from pathlib import Path

HEADERS = (
    "ID",
    "Заголовок",
    "Местоположение",
    "Статус",
    "Последнее изменение",
    "Инициатор запроса - Инициатор запроса",
    "Дата открытия",
    "Приоритет",
    "Категория",
)

SUBJECTS = (
    "Не запускается рабочая станция",
    "Пропало сетевое подключение",
    "Не печатает сетевой принтер",
    "Требуется установка программы",
    "Ошибка входа в корпоративную систему",
    "Медленно работает компьютер",
    "Не открывается общий каталог",
    "Требуется замена картриджа",
    "Не работает электронная почта",
    "Настройка нового рабочего места",
    "Сбой видеоконференции",
    "Не определяется USB-устройство",
    "Обновление операционной системы",
    "Проблема с VPN-подключением",
    "Не работает сканер",
)

LOCATIONS = (
    "Главный офис / 1 этаж",
    "Главный офис / 2 этаж",
    "Главный офис / 3 этаж",
    "Склад №1",
    "Склад №2",
    "Филиал Север",
    "Филиал Юг",
    "Удалённое рабочее место",
)

STATUSES = ("Новая", "В работе", "Назначена", "Решена", "Закрыта", "Отменена")
PRIORITIES = ("Низкий", "Средний", "Высокий", "Очень высокий")
CATEGORIES = (
    "Оборудование > Компьютеры",
    "Оборудование > Принтеры",
    "Программное обеспечение > Установка",
    "Программное обеспечение > Ошибка",
    "Сеть > LAN",
    "Сеть > VPN",
    "Учётные записи > Доступ",
    "Почта",
)
REQUESTERS = (
    "Иванов Иван",
    "Петрова Анна",
    "Сидоров Максим",
    "Кузнецова Елена",
    "Смирнов Алексей",
    "Волкова Мария",
    "Фёдоров Дмитрий",
    "Соколова Ольга",
)


def build_rows(*, count: int, start_id: int, seed: int) -> list[list[str | int]]:
    rng = random.Random(seed)
    base = datetime(2025, 1, 1, 8, 0)
    rows: list[list[str | int]] = []
    for index in range(count):
        opened = base + timedelta(minutes=index * 7)
        changed = opened + timedelta(minutes=5 + index % 720)
        ticket_id = start_id + index
        subject = SUBJECTS[index % len(SUBJECTS)]
        title = f"{subject} — тестовая заявка #{ticket_id}"
        rows.append(
            [
                ticket_id,
                title,
                LOCATIONS[(index * 3) % len(LOCATIONS)],
                STATUSES[(index * 5) % len(STATUSES)],
                changed.strftime("%d-%m-%Y %H:%M"),
                REQUESTERS[(index * 7) % len(REQUESTERS)],
                opened.strftime("%d-%m-%Y %H:%M"),
                PRIORITIES[(index * 11) % len(PRIORITIES)],
                CATEGORIES[(index * 13) % len(CATEGORIES)],
            ]
        )
    rng.shuffle(rows)
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a GLPI-compatible service-request CSV.")
    parser.add_argument("--count", type=int, default=10_000, help="Number of unique tickets")
    parser.add_argument("--start-id", type=int, default=1_500_000_000, help="First GLPI ticket ID")
    parser.add_argument("--seed", type=int, default=20260816, help="Deterministic shuffle seed")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("glpi_requests_10000_test.csv"),
        help="Output CSV path",
    )
    args = parser.parse_args()
    if not 1 <= args.count <= 50_000:
        parser.error("--count must be between 1 and 50000")
    if args.start_id < 1 or args.start_id + args.count - 1 > 2_147_483_647:
        parser.error("generated IDs must fit into a PostgreSQL INTEGER")

    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rows = build_rows(count=args.count, start_id=args.start_id, seed=args.seed)
    with output.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream, delimiter=";", quotechar='"', lineterminator="\r\n")
        writer.writerow(HEADERS)
        writer.writerows(rows)

    print(f"Created {len(rows):,} unique GLPI tickets: {output}")
    print(f"ID range: {args.start_id}–{args.start_id + len(rows) - 1}")


if __name__ == "__main__":
    main()
