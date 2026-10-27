from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import func, select

from app.auth import get_current_superuser, verify_superuser_standalone
from app.config import settings
from app.database import get_db
from app.models import Computer, ServiceRequest, User
from sqlalchemy.ext.asyncio import AsyncSession

from app.pg_backup import (
    configured_pg_bin_dir,
    create_database_dump,
    parse_database_url,
    pg_tools_status,
    restore_database_dump,
)

router = APIRouter(prefix="/settings/database", tags=["settings-database"])


@router.get("/status")
async def database_backup_status(
    _: User = Depends(get_current_superuser),
    db: AsyncSession = Depends(get_db),
):
    tools = pg_tools_status()
    cfg = None
    same_urls = True
    try:
        if settings.database_url.strip().lower().startswith("postgresql"):
            cfg = parse_database_url(settings.database_url)
            same_urls = (
                settings.database_url.strip() == settings.diagrams_database_url.strip()
                and settings.database_url.strip() == settings.warehouse_database_url.strip()
            )
    except Exception:
        cfg = None

    computers = await db.scalar(select(func.count()).select_from(Computer))
    requests = await db.scalar(select(func.count()).select_from(ServiceRequest))
    users = await db.scalar(select(func.count()).select_from(User))

    return {
        **tools,
        "pg_bin_dir_configured": configured_pg_bin_dir(),
        "engine": "postgresql" if cfg else "other",
        "database": cfg.dbname if cfg else None,
        "host": cfg.host if cfg else None,
        "port": cfg.port if cfg else None,
        "single_database": same_urls,
        "counts": {
            "computers": int(computers or 0),
            "service_requests": int(requests or 0),
            "users": int(users or 0),
        },
    }


@router.get("/export")
async def export_database_dump(_: User = Depends(get_current_superuser)):
    try:
        data, filename = create_database_dump()
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import")
async def import_database_dump(
    file: UploadFile = File(...),
    confirm: str = Form(...),
    _: None = Depends(verify_superuser_standalone),
):
    if (confirm or "").strip() != "RESTORE":
        raise HTTPException(
            status_code=400,
            detail='Введите RESTORE в поле подтверждения — текущая база будет перезаписана.',
        )

    name = (file.filename or "").lower()
    if name and not (name.endswith(".dump") or name.endswith(".backup") or name.endswith(".tar")):
        raise HTTPException(status_code=400, detail="Ожидается файл дампа PostgreSQL (.dump).")

    raw = await file.read()
    try:
        result = await restore_database_dump(raw)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return result
