from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

_BACKEND_DIR = Path(__file__).resolve().parent.parent

# Одна БД PostgreSQL для inventory, diagrams и warehouse (разные URL можно задать в .env).
_DEFAULT_PG_URL = "postgresql+asyncpg://inventory:inventory@localhost:5432/inventory"


def _default_database_url() -> str:
    return _DEFAULT_PG_URL


def _default_diagrams_database_url() -> str:
    return _DEFAULT_PG_URL


def _default_warehouse_database_url() -> str:
    return _DEFAULT_PG_URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(default_factory=_default_database_url)
    diagrams_database_url: str = Field(default_factory=_default_diagrams_database_url)
    warehouse_database_url: str = Field(default_factory=_default_warehouse_database_url)
    environment: str = "development"  # development|production
    # Нужен для подписи JWT (вход в панель без него невозможен). В проде задайте в .env.
    secret_key: str = "change-me-in-production-use-openssl-rand-hex-32"
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 24
    agent_token: str = "dev-agent-token-change-in-production"
    # Optional comma-separated fallback tokens for old agents during migration.
    agent_legacy_tokens: str = "dev-agent-token-change-in-production"
    # Extra server-side pepper for hashing agent token secrets (recommended; different from SECRET_KEY).
    agent_token_pepper: str = ""
    allow_legacy_agent_token_hashes: bool = True
    cors_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,"
        "http://localhost:3000,http://127.0.0.1:3000"
    )
    # При пустой БД один раз создаётся админ (отключите: пустые значения в .env).
    bootstrap_admin_username: str = "admin"
    bootstrap_admin_password: str = "admin123"
    # Each agent POST is also written as UTF-8 JSON under this directory (absolute or relative to backend/).
    agent_inbox_dir: str = "agent_inbox"
    agent_inbox_retention_days: int = 7
    max_agent_payload_bytes: int = 2_000_000
    ldap_uri: str = ""
    ldap_bind_dn: str = ""
    ldap_bind_password: str = ""
    ldap_user_search_base: str = ""
    ldap_user_filter: str = "(&(objectClass=user)(objectCategory=person))"
    ldap_username_attr: str = "sAMAccountName"
    ldap_display_name_attr: str = "displayName"
    ldap_email_attr: str = "mail"
    ldap_sync_limit: int = 500
    # Bitrix24: incoming webhook URL (recommended) or REST base URL.
    # Example webhook URL:
    #   https://<your>.bitrix24.ru/rest/<user_id>/<webhook_token>
    bitrix24_webhook_url: str = ""
    bitrix24_import_limit: int = 500
    # Bitrix24 chat-bot integration (incoming events → create local service request → reply in chat).
    bitrix24_bot_webhook_url: str = ""
    bitrix24_bot_id: int = 0
    bitrix24_bot_client_id: str = ""
    bitrix24_bot_handler_token: str = ""
    bitrix24_bot_inbox_dir: str = "bitrix_bot_inbox"
    # WikiRAG: uploaded knowledge-base files (absolute or relative to backend/).
    wiki_rag_dir: str = "wiki_rag_docs"
    wiki_rag_context_max_chars: int = 18_000
    # Контекст для чата (меньше — быстрее для лёгких моделей).
    wiki_rag_chat_context_max_chars: int = 4_000
    # LM Studio OpenAI-compatible API (Local Server).
    lm_studio_base_url: str = "http://127.0.0.1:1234/v1"
    lm_studio_model: str = "google/gemma-3-1b"
    lm_studio_timeout_seconds: int = 300
    lm_studio_max_tokens: int = 768
    # pg_dump/pg_restore (резервная копия в настройках). Путь к bin, любой диск (F:\...\bin).
    pg_bin_dir: str = ""
    postgres_admin_user: str = "postgres"
    postgres_admin_password: str = ""
    # slowapi limits (see backend/app/rate_limit.py); disabled when ENVIRONMENT=test.
    rate_limit_login: str = "10/minute"
    rate_limit_agent: str = "120/minute"
    # Dev-only: accept any Bearer on /agent/inventory (explicit opt-in; unsafe if misconfigured).
    allow_dev_any_agent_token: bool = False
    # In production OpenAPI (/docs) is off unless ENABLE_OPENAPI=true.
    enable_openapi: bool = False


def _is_default_secret(v: str) -> bool:
    s = (v or "").strip()
    if not s:
        return True
    defaults = {
        "change-me-in-production-use-openssl-rand-hex-32",
        "dev-agent-token-change-in-production",
        "admin123",
    }
    return s in defaults


def _validate_production_settings(s: Settings) -> None:
    env = (s.environment or "").strip().lower()
    if env not in {"development", "production", "test"}:
        raise ValueError("ENVIRONMENT must be 'development', 'production', or 'test'")
    if env != "production":
        return
    bad: list[str] = []
    if _is_default_secret(s.secret_key):
        bad.append("SECRET_KEY")
    if _is_default_secret(s.agent_token):
        bad.append("AGENT_TOKEN")
    if not (s.agent_token_pepper or "").strip():
        bad.append("AGENT_TOKEN_PEPPER")
    if (s.bootstrap_admin_username or "").strip() and _is_default_secret(s.bootstrap_admin_password or ""):
        bad.append("BOOTSTRAP_ADMIN_PASSWORD")
    for label, url in (
        ("DATABASE_URL", s.database_url),
        ("DIAGRAMS_DATABASE_URL", s.diagrams_database_url),
        ("WAREHOUSE_DATABASE_URL", s.warehouse_database_url),
    ):
        if not (url or "").strip().lower().startswith("postgresql"):
            bad.append(label)
    if bad:
        raise ValueError(
            "Refusing to start in production with default/empty secrets: "
            + ", ".join(bad)
            + ". Set them in backend/.env (copy from backend/.env.example)."
        )


settings = Settings()
_validate_production_settings(settings)
