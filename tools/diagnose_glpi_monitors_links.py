import csv
import os
import sqlite3


def contact_to_username(s: str | None) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    if "@" in s:
        left = s.split("@", 1)[0].strip()
        return left.lower() if left else None
    return s.lower()


def main() -> None:
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    db = os.path.join(root, "backend", "inventory.db")
    csv_path = os.path.join(root, "glpi (6).csv")

    if not os.path.isfile(db):
        raise SystemExit(f"DB not found: {db}")
    if not os.path.isfile(csv_path):
        raise SystemExit(f"CSV not found: {csv_path}")

    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("select username from users")
    users = {r[0].strip().lower() for r in cur.fetchall() if r and r[0]}

    contacts: list[tuple[str, str]] = []
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        rdr = csv.DictReader(f, delimiter=";", quotechar='"')
        for row in rdr:
            raw = (row.get("Контактное лицо") or "").strip()
            u = contact_to_username(raw)
            if raw and u:
                contacts.append((raw, u))

    uniq = sorted({u for _, u in contacts})
    matched = [u for u in uniq if u in users]
    missing = [u for u in uniq if u not in users]

    print("users_in_db:", len(users))
    print("unique_contacts_usernames:", len(uniq))
    print("matched_usernames:", len(matched))
    print("missing_usernames:", len(missing))
    print()
    print("-- matched examples --")
    for u in matched[:30]:
        print(u)
    print()
    print("-- missing examples --")
    for u in missing[:80]:
        print(u)


if __name__ == "__main__":
    main()

