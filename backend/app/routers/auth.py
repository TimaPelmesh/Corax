import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.auth import authenticate_user, create_access_token, get_current_user
from app.rate_limit import limiter
from app.database import get_db
from app.models import User
from app.schemas import Token, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginJson(BaseModel):
    username: str
    password: str
    return_token: bool = True


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
    secure_cookie = (settings.environment or "").strip().lower() == "production" and is_https
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        samesite="lax",
        secure=secure_cookie,
        path="/",
    )
    response.set_cookie(
        key="csrf_token",
        value=csrf,
        httponly=False,
        samesite="lax",
        secure=secure_cookie,
        path="/",
    )
    return Token(access_token=token if body.return_token else "")


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("csrf_token", path="/")
    return {"ok": True}
