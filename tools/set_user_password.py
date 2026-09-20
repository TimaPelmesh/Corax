from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from sqlalchemy import select

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = ROOT / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.auth import hash_password
from app.database import AsyncSessionLocal
from app.models import User


async def _run(username: str, new_password: str) -> int:
    async with AsyncSessionLocal() as db:
        row = await db.execute(select(User).where(User.username == username))
        user = row.scalar_one_or_none()
        if user is None:
            print(f"User '{username}' not found")
            return 1
        user.hashed_password = hash_password(new_password)
        await db.commit()
    print(f"Password updated for '{username}'")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Set local user password in inventory DB.")
    parser.add_argument("--username", required=True, help="Username, e.g. admin")
    parser.add_argument("--password", required=True, help="New password (plain text)")
    args = parser.parse_args()
    if len(args.password) < 6:
        print("Password must be at least 6 characters")
        return 2
    return asyncio.run(_run(args.username, args.password))


if __name__ == "__main__":
    raise SystemExit(main())
