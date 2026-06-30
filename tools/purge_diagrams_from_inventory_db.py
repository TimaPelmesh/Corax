from __future__ import annotations

import argparse
import shutil
import sqlite3
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Удаляет таблицы diagrams/diagram_bindings из inventory.db, оставляя остальное.",
    )
    ap.add_argument(
        "--db",
        default=str((Path(__file__).resolve().parents[1] / "backend" / "inventory.db").resolve()),
        help="Путь к inventory.db",
    )
    ap.add_argument(
        "--no-backup",
        action="store_true",
        help="Не создавать резервную копию (не рекомендуется).",
    )
    args = ap.parse_args()

    db_path = Path(args.db).resolve()
    if not db_path.is_file():
        raise SystemExit(f"Файл не найден: {db_path}")

    if not args.no_backup:
        backup = db_path.with_suffix(db_path.suffix + ".bak")
        shutil.copy2(db_path, backup)
        print(f"Backup: {backup}")

    try:
        con = sqlite3.connect(str(db_path))
    except sqlite3.Error as e:
        raise SystemExit(f"Не удалось открыть SQLite: {e}")

    try:
        cur = con.cursor()
        cur.execute("PRAGMA foreign_keys=OFF;")
        cur.execute("BEGIN;")
        cur.execute("DROP TABLE IF EXISTS diagram_bindings;")
        cur.execute("DROP TABLE IF EXISTS diagrams;")
        cur.execute("COMMIT;")
        print("OK: таблицы diagrams/diagram_bindings удалены (если существовали).")
    except sqlite3.DatabaseError as e:
        try:
            con.rollback()
        except Exception:
            pass
        print(f"ОШИБКА SQLite: {e}")
        print(
            "Если база реально повреждена, SQLite может не дать удалить таблицы. "
            "Тогда нужно восстановление из копии или попытка recovery средствами sqlite3 (.recover)."
        )
        return 2
    finally:
        try:
            con.close()
        except Exception:
            pass

    # Optional compact.
    try:
        con = sqlite3.connect(str(db_path))
        con.execute("VACUUM;")
        con.close()
        print("VACUUM: выполнено.")
    except sqlite3.Error:
        pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

