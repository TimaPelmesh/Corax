import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import authenticate_user, create_access_token, get_current_user
from app.config import settings
from app.database import get_db
from app.models import User
from app.rate_limit import limiter
from app.schemas import Token, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginJson(BaseModel):
    username: str
    password: str
    # Default false: browser clients use HttpOnly cookie only (frontend already sends false).
    # Pass true only for API/scripts that need the JWT in the response body.
    return_token: bool = False


def _cookie_max_age() -> int:
    return max(60, int(settings.access_token_expire_minutes) * 60)


@router.post("/login", response_model=Token)
@limiter.limit(settings.rate_limit_login)
async def login(
    request: Request,
    form: OAuth2PasswordRequestForm = Depends(),
    db: AsyncSession = Depends(get_db),
):
    user = await authenticate_user(db, form.username, form.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный логин или пароль")
    token = create_access_token(user.username)
    return Token(access_token=token)


@router.post("/login/json", response_model=Token)
@limiter.limit(settings.rate_limit_login)
async def login_json(
    request: Request,
    response: Response,
    body: LoginJson,
    db: AsyncSession = Depends(get_db),
):
    user = await authenticate_user(db, body.username, body.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Неверный логин или пароль")
    token = create_access_token(user.username)
    csrf = secrets.token_urlsafe(32)
    xf_proto = (request.headers.get("x-forwarded-proto") or "").strip().lower()
    is_https = request.url.scheme == "https" or xf_proto == "https"
    # Secure cookies whenever the request itself is HTTPS (LAN self-signed included).
    secure_cookie = is_https
    max_age = _cookie_max_age()
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure_cookie,
        path="/",
        max_age=max_age,
    )
    response.set_cookie(
        key="csrf_token",
        value=csrf,
        httponly=False,
        samesite="lax",
        secure=secure_cookie,
        path="/",
        max_age=max_age,
    )
    return Token(access_token=token if body.return_token else "")


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    linked_username = None
    linked_full_name = None
    if user.linked_directory_user_id:
        linked = await db.get(User, user.linked_directory_user_id)
        if linked is not None:
            linked_username = linked.username
            linked_full_name = linked.full_name
    return UserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        full_name=user.full_name,
        avatar_data=user.avatar_data,
        is_active=user.is_active,
        is_superuser=user.is_superuser,
        is_ldap=bool(user.is_ldap),
        role=(user.role or "observer"),
        created_at=user.created_at,
        linked_directory_user_id=user.linked_directory_user_id,
        linked_directory_username=linked_username,
        linked_directory_full_name=linked_full_name,
    )


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("csrf_token", path="/")
    return {"ok": True}
