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
    # Session length for panel JWT / HttpOnly cookie. LAN default 24h; shorten in .env if needed.
    access_token_expire_minutes: int = 60 * 24
    agent_token: str = "dev-agent-token-change-in-production"
    # Optional comma-separated fallback tokens for old agents during migration.
    agent_legacy_tokens: str = "dev-agent-token-change-in-production"
    # Extra server-side pepper for hashing agent token secrets (recommended; different from SECRET_KEY).
    agent_token_pepper: str = ""
    # Prefer HMAC-stored agent tokens; plaintext legacy hashes only during migration.
    allow_legacy_agent_token_hashes: bool = False
    # --- Observability ---
    # stdout (Docker) + rotating files under LOG_DIR (skipped when ENVIRONMENT=test).
    log_level: str = "INFO"
    log_dir: str = "logs"
    log_to_stdout: bool = True
    log_to_file: bool = True
    # None = JSON in production, human-readable elsewhere (stdout). File corax.jsonl is always JSON.
    log_json: bool | None = None
    log_max_bytes: int = 10_485_760
    log_backup_count: int = 14
    # Security headers / CSP (CSP only when ENVIRONMENT=production).
    security_headers_enabled: bool = True
    security_csp_enabled: bool = True
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
    wiki_rag_context_max_chars: int = 48_000
    # Контекст для чата (документы + данные CORAX).
    wiki_rag_chat_context_max_chars: int = 40_000
    # Доля контекста чата под авто-сводку CORAX (ПК, теги, заявки).
    wiki_rag_corax_context_max_chars: int = 24_000
    # LM Studio / Ollama OpenAI-compatible API (Local Server).
    # Ollama example: http://127.0.0.1:11434/v1 (or remote host:11434/v1).
    lm_studio_base_url: str = "http://127.0.0.1:1234/v1"
    lm_studio_model: str = "qwen2.5:3b-instruct"
    corax_docker: bool = False
    lm_studio_timeout_seconds: int = 300
    # Reasoning-модели (Gemma 4 и т.п.) тратят часть бюджета на thinking —
    # 3072 даёт запас, чтобы успел появиться content после reasoning.
    lm_studio_max_tokens: int = 4096
    # Лимит контекста промпта + Ollama num_ctx. 0 = авто (макс. модели, до 32768).
    # Вручную: 8192/16384 на слабой GPU, 32768 если VRAM позволяет.
    wiki_rag_lm_context_tokens: int = 0
    # WikiRAG semantic index — aligned with fast Ollama RAG script (bge-m3 + 1500/300 + k=45).
    # Empty base URL → same as lm_studio_base_url.
    wiki_rag_embed_base_url: str = ""
    wiki_rag_embed_model: str = "bge-m3"
    # bge-m3 = 1024; must match embedding model output size for pgvector.
    wiki_rag_embed_dims: int = 1024
    wiki_rag_chunk_size: int = 1500
    wiki_rag_chunk_overlap: int = 300
    wiki_rag_retrieve_top_k: int = 45
    # Explicit opt-in only: auto-importing CORAX at boot can unexpectedly
    # replace a user's WikiRAG corpus and trigger a full reindex.
    wiki_rag_corax_sync_minutes: int = 0
    # False = classic RAG like script.py (retrieve MD chunks → strict prompt).
    # True = legacy tools summaries (often too thin for inventory Q&A).
    wiki_rag_use_tools: bool = False
    # Hard ceiling for retrieved context in classic RAG (chars ≈ tokens*3).
    # ~45 chunks × ~1500 chars with headroom (matches WIKI_RAG_RETRIEVE_TOP_K).
    wiki_rag_classic_context_chars: int = 60000
    # Автоиндексация при загрузке/правке: в очередь только этот файл, не «переиндексировать всё».
    wiki_rag_auto_index: bool = False
    # pg_dump/pg_restore (резервная копия в настройках). Путь к bin, любой диск (F:\...\bin).
    pg_bin_dir: str = ""
    postgres_admin_user: str = "postgres"
    postgres_admin_password: str = ""
    # slowapi limits (see backend/app/rate_limit.py); disabled when ENVIRONMENT=test.
    rate_limit_login: str = "10/minute"
    rate_limit_agent: str = "120/minute"
    self_service_enabled: bool = False
    rate_limit_self_service: str = "10/minute"
    self_service_default_category: str = "self-service"
    # Local CA / HTTPS for admin browsers (files under backend/data/tls by default).
    tls_dir: str = "data/tls"
    # Wake-on-LAN from panel (superuser + DB allowlist). Kill-switch overrides DB enable.
    wol_force_disabled: bool = False
    rate_limit_wake: str = "5/minute"
    rate_limit_ping: str = "60/minute"
    # Fleet ICMP: batched + drip (fast enough, network-safe).
    # Full reconcile on UI kick / startup; between — small stale batches every ~8–18s.
    computer_ping_enabled: bool = True
    computer_ping_interval_minutes: int = 15
    computer_ping_concurrency: int = 3
    computer_ping_batch_size: int = 10
    computer_ping_batch_pause_ms: int = 350
    computer_ping_timeout_ms: int = 700
    computer_ping_jitter_ms: int = 40
    # Dev-only: accept any Bearer on /agent/inventory (explicit opt-in; unsafe if misconfigured).
    allow_dev_any_agent_token: bool = False
    # In production OpenAPI (/docs) is off unless ENABLE_OPENAPI=true.
    enable_openapi: bool = False
    # Host/IP that agents should use (Docker: set to host LAN IP — container sees 172.x otherwise).
    # Example: CORAX_ADVERTISE_HOST=192.168.1.10
    corax_advertise_host: str = ""


def _is_default_secret(v: str) -> bool:
    s = (v or "").strip()
    if not s:
        return True
    low = s.lower()
    defaults = {
        "change-me-in-production-use-openssl-rand-hex-32",
        "dev-agent-token-change-in-production",
        "dev-secret-key-change-me",
        "long-random-string-for-agents-min-24-chars",
        "change-me-strong-password-min-12",
        "admin123",
        "admin12345",
        "inventory",
        "postgres",
        "changeme",
        "password",
        "secret",
        "corax_password",
        "secret_key_change_me_123",
    }
    if s in defaults or low in defaults:
        return True
    if low.startswith("replace-with-") or low.startswith("generate-with-"):
        return True
    if low.startswith("change-me") or low.startswith("your-"):
        return True
    if "change_me" in low or "change-me" in low:
        return True
    return False


def _validate_production_settings(s: Settings) -> None:
    env = (s.environment or "").strip().lower()
    if env not in {"development", "production", "test"}:
        raise ValueError("ENVIRONMENT must be 'development', 'production', or 'test'")
    if env != "production":
        return
    # Docker LAN/lab: intentional first-run defaults admin123 + POSTGRES inventory.
    # JWT / agent secrets must still be strong. Bare-metal production keeps full checks.
    lab_docker = bool(getattr(s, "corax_docker", False))
    bad: list[str] = []
    if _is_default_secret(s.secret_key) or len((s.secret_key or "").strip()) < 32:
        bad.append("SECRET_KEY")
    if _is_default_secret(s.agent_token) or len((s.agent_token or "").strip()) < 24:
        bad.append("AGENT_TOKEN")
    if not (s.agent_token_pepper or "").strip() or _is_default_secret(s.agent_token_pepper):
        bad.append("AGENT_TOKEN_PEPPER")
    if not lab_docker and (s.bootstrap_admin_username or "").strip() and (
        _is_default_secret(s.bootstrap_admin_password or "")
        or len((s.bootstrap_admin_password or "").strip()) < 12
    ):
        bad.append("BOOTSTRAP_ADMIN_PASSWORD")
    for label, url in (
        ("DATABASE_URL", s.database_url),
        ("DIAGRAMS_DATABASE_URL", s.diagrams_database_url),
        ("WAREHOUSE_DATABASE_URL", s.warehouse_database_url),
    ):
        u = (url or "").strip().lower()
        if not u.startswith("postgresql"):
            bad.append(label)
        elif not lab_docker and (":inventory@" in u or ":postgres@" in u):
            # Bare-metal production: refuse default DB passwords.
            # Docker lab uses POSTGRES_PASSWORD=inventory by design.
            bad.append(f"{label}(weak DB password)")
    if bad:
        raise ValueError(
            "Refusing to start in production with default/empty secrets: "
            + ", ".join(bad)
            + ". Set them in backend/.env (copy from backend/.env.example)."
        )


settings = Settings()
_validate_production_settings(settings)
