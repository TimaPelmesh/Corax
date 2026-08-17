from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import inspect, text

MigrationFn = Callable[[object], None]


def _table_names(sync_conn) -> set[str]:
    return set(inspect(sync_conn).get_table_names())


def _column_names(sync_conn, table: str) -> set[str]:
    return {c["name"] for c in inspect(sync_conn).get_columns(table)}


def _ensure_schema_migrations(sync_conn) -> None:
    sync_conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version TEXT PRIMARY KEY,
              applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    # Ранние версии приложения создавали version как VARCHAR(32). Идентификаторы
    # новых миграций длиннее, поэтому старую служебную таблицу нужно расширить
    # до попытки отметить миграцию как применённую.
    if sync_conn.dialect.name == "postgresql":
        sync_conn.execute(
            text("ALTER TABLE schema_migrations ALTER COLUMN version TYPE TEXT")
        )


def _is_applied(sync_conn, version: str) -> bool:
    r = sync_conn.execute(
        text("SELECT 1 FROM schema_migrations WHERE version = :v LIMIT 1"),
        {"v": version},
    )
    return r.first() is not None


def _mark_applied(sync_conn, version: str) -> None:
    sync_conn.execute(text("INSERT INTO schema_migrations(version) VALUES (:v)"), {"v": version})


def _pg_try_execute(sync_conn, sql: str) -> bool:
    """Optional DDL that must not abort the outer PostgreSQL transaction on failure.

    Bare ``try/except`` around ``execute`` is not enough: Postgres leaves the
    transaction in an aborted state until ROLLBACK / ROLLBACK TO SAVEPOINT.
    """
    if sync_conn.dialect.name == "postgresql":
        sync_conn.execute(text("SAVEPOINT corax_optional_ddl"))
        try:
            sync_conn.execute(text(sql))
        except Exception:
            sync_conn.execute(text("ROLLBACK TO SAVEPOINT corax_optional_ddl"))
            return False
        sync_conn.execute(text("RELEASE SAVEPOINT corax_optional_ddl"))
        return True
    try:
        sync_conn.execute(text(sql))
        return True
    except Exception:
        return False


def _migrate_tags_color_column(sync_conn) -> None:
    cols = _column_names(sync_conn, "tags")
    if "color" in cols:
        return
    sync_conn.execute(text("ALTER TABLE tags ADD COLUMN color VARCHAR(16)"))


def _migrate_computers_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "computers")
    patch_sql = {
        "location": "ALTER TABLE computers ADD COLUMN location VARCHAR(255)",
        "gpu_name": "ALTER TABLE computers ADD COLUMN gpu_name VARCHAR(512)",
        "memory_used_percent": "ALTER TABLE computers ADD COLUMN memory_used_percent INTEGER",
        "motherboard_manufacturer": "ALTER TABLE computers ADD COLUMN motherboard_manufacturer VARCHAR(255)",
        "motherboard_product": "ALTER TABLE computers ADD COLUMN motherboard_product VARCHAR(255)",
        "disks_json": "ALTER TABLE computers ADD COLUMN disks_json TEXT",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))


def _migrate_service_requests_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "service_requests")
    patch_sql = {
        "glpi_id": "ALTER TABLE service_requests ADD COLUMN glpi_id INTEGER",
        "glpi_status": "ALTER TABLE service_requests ADD COLUMN glpi_status VARCHAR(64)",
        "glpi_priority": "ALTER TABLE service_requests ADD COLUMN glpi_priority VARCHAR(64)",
        "glpi_updated_at": "ALTER TABLE service_requests ADD COLUMN glpi_updated_at TIMESTAMP",
        "external_source": "ALTER TABLE service_requests ADD COLUMN external_source VARCHAR(32)",
        "external_id": "ALTER TABLE service_requests ADD COLUMN external_id VARCHAR(128)",
        "external_url": "ALTER TABLE service_requests ADD COLUMN external_url VARCHAR(512)",
        "external_payload_json": "ALTER TABLE service_requests ADD COLUMN external_payload_json TEXT",
        "requester_name": "ALTER TABLE service_requests ADD COLUMN requester_name VARCHAR(255)",
        "category": "ALTER TABLE service_requests ADD COLUMN category VARCHAR(255)",
        "location": "ALTER TABLE service_requests ADD COLUMN location VARCHAR(255)",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_service_requests_glpi_id ON service_requests (glpi_id)"))
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_service_requests_external_source ON service_requests (external_source)")
    )
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_service_requests_external_id ON service_requests (external_id)"))


def _migrate_service_request_ticket_no(sync_conn) -> None:
    cols = _column_names(sync_conn, "service_requests")
    if "ticket_no" not in cols:
        sync_conn.execute(text("ALTER TABLE service_requests ADD COLUMN ticket_no INTEGER"))
    sync_conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_service_requests_ticket_no "
            "ON service_requests (ticket_no) WHERE ticket_no IS NOT NULL"
        )
    )
    pending = sync_conn.execute(
        text(
            """
            SELECT id FROM service_requests
            WHERE ticket_no IS NULL
              AND (
                closed_at IS NOT NULL
                OR status IN ('done', 'cancelled')
              )
            ORDER BY COALESCE(closed_at, updated_at, created_at) ASC, id ASC
            """
        )
    ).fetchall()
    if not pending:
        return
    max_row = sync_conn.execute(text("SELECT MAX(ticket_no) FROM service_requests")).first()
    n = int(max_row[0] or 0)
    for (rid,) in pending:
        n += 1
        sync_conn.execute(
            text("UPDATE service_requests SET ticket_no = :no WHERE id = :id"),
            {"no": n, "id": rid},
        )


def _migrate_service_request_templates_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "service_request_templates")
    patch_sql = {
        "requester_name": "ALTER TABLE service_request_templates ADD COLUMN requester_name VARCHAR(255)",
        "category": "ALTER TABLE service_request_templates ADD COLUMN category VARCHAR(255)",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))


def _migrate_ldap_config_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "ldap_config")
    if "allow_anonymous" not in cols:
        sync_conn.execute(text("ALTER TABLE ldap_config ADD COLUMN allow_anonymous BOOLEAN DEFAULT FALSE"))


def _migrate_users_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "users")
    patch_sql = {
        "is_ldap": "ALTER TABLE users ADD COLUMN is_ldap BOOLEAN DEFAULT FALSE",
        "role": "ALTER TABLE users ADD COLUMN role VARCHAR(16) DEFAULT 'observer'",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))
    sync_conn.execute(
        text(
            "UPDATE users SET role = CASE "
            "WHEN role IS NULL OR TRIM(role) = '' THEN 'observer' "
            "WHEN lower(role) NOT IN ('observer','editor','directory') THEN 'observer' "
            "ELSE lower(role) END"
        )
    )


def _migrate_users_avatar_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "users")
    patch_sql = {
        "avatar_emoji": "ALTER TABLE users ADD COLUMN avatar_emoji VARCHAR(32)",
        "avatar_bg": "ALTER TABLE users ADD COLUMN avatar_bg VARCHAR(16)",
        "avatar_data": "ALTER TABLE users ADD COLUMN avatar_data TEXT",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))


def _migrate_users_avatar_data(sync_conn) -> None:
    cols = _column_names(sync_conn, "users")
    if "avatar_data" not in cols:
        sync_conn.execute(text("ALTER TABLE users ADD COLUMN avatar_data TEXT"))


def _migrate_users_must_change_password(sync_conn) -> None:
    cols = _column_names(sync_conn, "users")
    if "must_change_password" in cols:
        return
    sync_conn.execute(
        text("ALTER TABLE users ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE")
    )


def _migrate_users_linked_directory(sync_conn) -> None:
    cols = _column_names(sync_conn, "users")
    if "linked_directory_user_id" not in cols:
        sync_conn.execute(
            text("ALTER TABLE users ADD COLUMN linked_directory_user_id INTEGER")
        )
    # FK + index — best-effort (SQLite/Postgres).
    try:
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_users_linked_directory_user_id "
                "ON users (linked_directory_user_id)"
            )
        )
    except Exception:
        pass
    if sync_conn.dialect.name == "postgresql":
        try:
            sync_conn.execute(
                text(
                    "ALTER TABLE users DROP CONSTRAINT IF EXISTS "
                    "fk_users_linked_directory_user_id"
                )
            )
            sync_conn.execute(
                text(
                    "ALTER TABLE users ADD CONSTRAINT fk_users_linked_directory_user_id "
                    "FOREIGN KEY (linked_directory_user_id) REFERENCES users(id) "
                    "ON DELETE SET NULL"
                )
            )
        except Exception:
            pass


def _migrate_monitors_table(sync_conn) -> None:
    if "monitors" in _table_names(sync_conn):
        return
    sync_conn.execute(
        text(
            """
            CREATE TABLE monitors (
              id SERIAL PRIMARY KEY,
              name VARCHAR(255) NOT NULL,
              manufacturer VARCHAR(255),
              model VARCHAR(255),
              serial_number VARCHAR(128),
              inventory_number VARCHAR(128),
              organization VARCHAR(255),
              glpi_contact_raw VARCHAR(255),
              glpi_updated_at TIMESTAMP,
              assigned_user_id INTEGER REFERENCES users(id)
            )
            """
        )
    )
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitors_assigned_user_id ON monitors (assigned_user_id)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitors_serial_number ON monitors (serial_number)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_monitors_inventory_number ON monitors (inventory_number)"))


def _migrate_printers_table(sync_conn) -> None:
    if "printers" in _table_names(sync_conn):
        return
    sync_conn.execute(
        text(
            """
            CREATE TABLE printers (
              id SERIAL PRIMARY KEY,
              dedupe_key VARCHAR(255) NOT NULL UNIQUE,
              name VARCHAR(512) NOT NULL,
              driver_name VARCHAR(512),
              port_name VARCHAR(512),
              ip_address VARCHAR(64),
              is_network BOOLEAN DEFAULT FALSE,
              is_shared BOOLEAN DEFAULT FALSE,
              is_default BOOLEAN DEFAULT FALSE,
              agent_status VARCHAR(64),
              work_offline BOOLEAN,
              poll_status VARCHAR(32),
              computer_id INTEGER REFERENCES computers(id) ON DELETE SET NULL,
              location VARCHAR(255),
              notes TEXT,
              source VARCHAR(16) DEFAULT 'agent',
              last_seen_at TIMESTAMP,
              last_poll_at TIMESTAMP,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_printers_name ON printers (name)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_printers_ip_address ON printers (ip_address)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_printers_computer_id ON printers (computer_id)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_printers_dedupe_key ON printers (dedupe_key)"))


def _migrate_printer_snmp_columns(sync_conn) -> None:
    cols = _column_names(sync_conn, "printers")
    patch_sql = {
        "snmp_model": "ALTER TABLE printers ADD COLUMN snmp_model VARCHAR(512)",
        "page_count": "ALTER TABLE printers ADD COLUMN page_count INTEGER",
        "supplies_json": "ALTER TABLE printers ADD COLUMN supplies_json TEXT",
        "last_snmp_at": "ALTER TABLE printers ADD COLUMN last_snmp_at TIMESTAMP",
        "snmp_status": "ALTER TABLE printers ADD COLUMN snmp_status VARCHAR(32)",
        "snmp_error": "ALTER TABLE printers ADD COLUMN snmp_error TEXT",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))


def _migrate_printer_poll_config(sync_conn) -> None:
    if "printer_poll_config" in _table_names(sync_conn):
        return
    sync_conn.execute(
        text(
            """
            CREATE TABLE printer_poll_config (
              id SERIAL PRIMARY KEY,
              poll_enabled BOOLEAN DEFAULT TRUE,
              poll_interval_minutes INTEGER DEFAULT 30,
              snmp_enabled BOOLEAN DEFAULT TRUE,
              snmp_community VARCHAR(128) DEFAULT 'public',
              snmp_timeout_seconds DOUBLE PRECISION DEFAULT 5.0,
              ping_timeout_ms INTEGER DEFAULT 1200,
              poll_concurrency INTEGER DEFAULT 6,
              last_run_at TIMESTAMP,
              last_run_summary_json TEXT,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )


def _migrate_wake_on_lan_config(sync_conn) -> None:
    if "wake_on_lan_config" in _table_names(sync_conn):
        return
    if sync_conn.dialect.name == "sqlite":
        ddl = """
            CREATE TABLE wake_on_lan_config (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              enabled BOOLEAN NOT NULL DEFAULT 0,
              allowlist_computer_ids_json TEXT NOT NULL DEFAULT '[]',
              wake_user_ids_json TEXT NOT NULL DEFAULT '[]',
              cooldown_seconds INTEGER NOT NULL DEFAULT 120,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
    else:
        ddl = """
            CREATE TABLE wake_on_lan_config (
              id SERIAL PRIMARY KEY,
              enabled BOOLEAN NOT NULL DEFAULT FALSE,
              allowlist_computer_ids_json TEXT NOT NULL DEFAULT '[]',
              wake_user_ids_json TEXT NOT NULL DEFAULT '[]',
              cooldown_seconds INTEGER NOT NULL DEFAULT 120,
              updated_at TIMESTAMPTZ DEFAULT NOW()
            )
            """
    sync_conn.execute(text(ddl))


def _migrate_wol_wake_user_ids(sync_conn) -> None:
    if "wake_on_lan_config" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "wake_on_lan_config")
    if "wake_user_ids_json" not in cols:
        sync_conn.execute(
            text("ALTER TABLE wake_on_lan_config ADD COLUMN wake_user_ids_json TEXT DEFAULT '[]'")
        )
        sync_conn.execute(
            text("UPDATE wake_on_lan_config SET wake_user_ids_json = '[]' WHERE wake_user_ids_json IS NULL")
        )


def _migrate_wol_cooldown_zero(sync_conn) -> None:
    """Drop forced wake pause — admins need to re-wake / re-check without waiting."""
    if "wake_on_lan_config" not in _table_names(sync_conn):
        return
    sync_conn.execute(text("UPDATE wake_on_lan_config SET cooldown_seconds = 0"))


def _migrate_computers_ip_address(sync_conn) -> None:
    if "computers" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "computers")
    if "ip_address" not in cols:
        sync_conn.execute(text("ALTER TABLE computers ADD COLUMN ip_address VARCHAR(64)"))
        try:
            sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_computers_ip_address ON computers (ip_address)"))
        except Exception:
            pass


def _migrate_computers_ping_status(sync_conn) -> None:
    if "computers" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "computers")
    if "ping_status" not in cols:
        sync_conn.execute(text("ALTER TABLE computers ADD COLUMN ping_status VARCHAR(16)"))
    if "last_ping_at" not in cols:
        if sync_conn.dialect.name == "sqlite":
            sync_conn.execute(text("ALTER TABLE computers ADD COLUMN last_ping_at TIMESTAMP"))
        else:
            sync_conn.execute(text("ALTER TABLE computers ADD COLUMN last_ping_at TIMESTAMPTZ"))
    try:
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_computers_ping_status ON computers (ping_status)"))
    except Exception:
        pass


def _migrate_notes_tables(sync_conn) -> None:
    tables = _table_names(sync_conn)
    if "notes" not in tables:
        if sync_conn.dialect.name == "sqlite":
            sync_conn.execute(
                text(
                    """
                    CREATE TABLE notes (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      title VARCHAR(255) NOT NULL DEFAULT '',
                      body_html TEXT NOT NULL DEFAULT '',
                      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      plan_start DATE,
                      plan_end DATE,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
            )
        else:
            sync_conn.execute(
                text(
                    """
                    CREATE TABLE notes (
                      id SERIAL PRIMARY KEY,
                      title VARCHAR(255) NOT NULL DEFAULT '',
                      body_html TEXT NOT NULL DEFAULT '',
                      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      plan_start DATE,
                      plan_end DATE,
                      created_at TIMESTAMPTZ DEFAULT NOW(),
                      updated_at TIMESTAMPTZ DEFAULT NOW()
                    )
                    """
                )
            )
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notes_owner_user_id ON notes (owner_user_id)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notes_plan_start ON notes (plan_start)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notes_plan_end ON notes (plan_end)"))
    if "note_shares" not in _table_names(sync_conn):
        if sync_conn.dialect.name == "sqlite":
            sync_conn.execute(
                text(
                    """
                    CREATE TABLE note_shares (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      can_edit INTEGER NOT NULL DEFAULT 0,
                      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                      UNIQUE (note_id, user_id)
                    )
                    """
                )
            )
        else:
            sync_conn.execute(
                text(
                    """
                    CREATE TABLE note_shares (
                      id SERIAL PRIMARY KEY,
                      note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
                      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                      can_edit BOOLEAN NOT NULL DEFAULT FALSE,
                      created_at TIMESTAMPTZ DEFAULT NOW(),
                      CONSTRAINT uq_note_shares_note_user UNIQUE (note_id, user_id)
                    )
                    """
                )
            )
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_note_shares_note_id ON note_shares (note_id)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_note_shares_user_id ON note_shares (user_id)"))


def _migrate_network_extras_json(sync_conn) -> None:
    if "network_devices" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "network_devices")
    if "extras_json" not in cols:
        sync_conn.execute(text("ALTER TABLE network_devices ADD COLUMN extras_json TEXT"))


def _migrate_network_tables(sync_conn) -> None:
    tables = _table_names(sync_conn)
    if "network_devices" not in tables:
        sync_conn.execute(
            text(
                """
                CREATE TABLE network_devices (
                  id SERIAL PRIMARY KEY,
                  dedupe_key VARCHAR(255) NOT NULL UNIQUE,
                  ip_address VARCHAR(64) NOT NULL,
                  hostname VARCHAR(255),
                  sys_name VARCHAR(255),
                  sys_descr TEXT,
                  sys_object_id VARCHAR(255),
                  device_type VARCHAR(32) DEFAULT 'unknown',
                  vendor VARCHAR(128),
                  location VARCHAR(255),
                  snmp_status VARCHAR(32),
                  snmp_error TEXT,
                  last_snmp_at TIMESTAMP,
                  last_seen_at TIMESTAMP,
                  interfaces_json TEXT,
                  neighbors_json TEXT,
                  fdb_json TEXT,
                  extras_json TEXT,
                  source VARCHAR(16) DEFAULT 'snmp',
                  notes TEXT,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_devices_ip_address ON network_devices (ip_address)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_devices_hostname ON network_devices (hostname)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_devices_device_type ON network_devices (device_type)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_devices_dedupe_key ON network_devices (dedupe_key)"))
    if "network_links" not in tables:
        sync_conn.execute(
            text(
                """
                CREATE TABLE network_links (
                  id SERIAL PRIMARY KEY,
                  from_type VARCHAR(32) NOT NULL,
                  from_id INTEGER NOT NULL,
                  to_type VARCHAR(32) NOT NULL,
                  to_id INTEGER NOT NULL,
                  link_type VARCHAR(32) DEFAULT 'lldp',
                  local_port VARCHAR(128),
                  remote_port VARCHAR(128),
                  confidence DOUBLE PRECISION DEFAULT 1.0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  CONSTRAINT uq_network_links_pair_type UNIQUE (from_type, from_id, to_type, to_id, link_type)
                )
                """
            )
        )
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_links_from_type ON network_links (from_type)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_links_from_id ON network_links (from_id)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_links_to_type ON network_links (to_type)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_links_to_id ON network_links (to_id)"))
        sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_network_links_link_type ON network_links (link_type)"))
    if "network_poll_config" not in tables:
        sync_conn.execute(
            text(
                """
                CREATE TABLE network_poll_config (
                  id SERIAL PRIMARY KEY,
                  poll_enabled BOOLEAN DEFAULT FALSE,
                  poll_interval_minutes INTEGER DEFAULT 120,
                  snmp_community VARCHAR(128) DEFAULT 'public',
                  snmp_timeout_seconds DOUBLE PRECISION DEFAULT 3.5,
                  poll_concurrency INTEGER DEFAULT 8,
                  cidr_list_json TEXT,
                  last_run_at TIMESTAMP,
                  last_run_summary_json TEXT,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
        )


def _migrate_service_request_categories_tree(sync_conn) -> None:
    from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES

    tables = _table_names(sync_conn)
    paths: list[str] = []
    if "service_request_categories" in tables:
        cols = _column_names(sync_conn, "service_request_categories")
        if "path" in cols:
            rows = sync_conn.execute(
                text("SELECT path FROM service_request_categories ORDER BY sort_order, path")
            ).fetchall()
            paths = [str(r[0]) for r in rows if r[0]]
        elif "name" in cols and "parent_id" in cols:
            return
    if not paths:
        paths = list(DEFAULT_REQUEST_CATEGORIES)

    sync_conn.execute(text("DROP TABLE IF EXISTS service_request_categories CASCADE"))
    sync_conn.execute(
        text(
            """
            CREATE TABLE service_request_categories (
              id SERIAL PRIMARY KEY,
              parent_id INTEGER REFERENCES service_request_categories(id) ON DELETE CASCADE,
              name VARCHAR(128) NOT NULL,
              sort_order INTEGER NOT NULL DEFAULT 0
            )
            """
        )
    )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_service_request_categories_parent_id "
            "ON service_request_categories (parent_id)"
        )
    )
    sync_conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_service_request_categories_parent_name "
            "ON service_request_categories (parent_id, name)"
        )
    )

    id_by_full: dict[str, int] = {}
    order = 0
    for raw in sorted(paths, key=lambda s: len(s)):
        parts = [p.strip() for p in raw.split(">") if p.strip()]
        if not parts:
            continue
        parent_full: str | None = None
        for i, part in enumerate(parts):
            full = " > ".join(parts[: i + 1])
            if full in id_by_full:
                parent_full = full
                continue
            parent_id = id_by_full.get(parent_full) if parent_full else None
            result = sync_conn.execute(
                text(
                    "INSERT INTO service_request_categories (parent_id, name, sort_order) "
                    "VALUES (:pid, :name, :ord) RETURNING id"
                ),
                {"pid": parent_id, "name": part[:128], "ord": order},
            )
            new_id = result.scalar()
            id_by_full[full] = int(new_id)
            order += 1
            parent_full = full


def _migrate_service_request_categories(sync_conn) -> None:
    tables = _table_names(sync_conn)
    if "service_request_categories" not in tables:
        sync_conn.execute(
            text(
                """
                CREATE TABLE service_request_categories (
                  id SERIAL PRIMARY KEY,
                  path VARCHAR(512) NOT NULL UNIQUE,
                  sort_order INTEGER NOT NULL DEFAULT 0
                )
                """
            )
        )
        sync_conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_service_request_categories_path ON service_request_categories (path)")
        )

    cols = _column_names(sync_conn, "service_request_categories")
    if "path" not in cols:
        return

    from app.request_categories_defaults import DEFAULT_REQUEST_CATEGORIES

    cnt = sync_conn.execute(text("SELECT COUNT(*) FROM service_request_categories")).scalar() or 0
    if int(cnt) == 0:
        for i, path in enumerate(DEFAULT_REQUEST_CATEGORIES):
            sync_conn.execute(
                text("INSERT INTO service_request_categories (path, sort_order) VALUES (:p, :o)"),
                {"p": path, "o": i},
            )


def _migrate_printer_kind_serial(sync_conn) -> None:
    cols = _column_names(sync_conn, "printers")
    patches = {
        "printer_kind": "ALTER TABLE printers ADD COLUMN printer_kind VARCHAR(32)",
        "serial_number": "ALTER TABLE printers ADD COLUMN serial_number VARCHAR(128)",
        "snmp_sys_name": "ALTER TABLE printers ADD COLUMN snmp_sys_name VARCHAR(255)",
    }
    for key, sql in patches.items():
        if key not in cols:
            sync_conn.execute(text(sql))
    if "printer_kind" in _column_names(sync_conn, "printers"):
        sync_conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_printers_printer_kind ON printers (printer_kind)")
        )


def _migrate_printer_poll_interval_30(sync_conn) -> None:
    sync_conn.execute(
        text(
            "UPDATE printer_poll_config "
            "SET poll_interval_minutes = 30 "
            "WHERE poll_interval_minutes IS NULL OR poll_interval_minutes = 15"
        )
    )


def _migrate_diagrams(sync_conn) -> None:
    if "diagrams" in _table_names(sync_conn):
        return
    sync_conn.execute(
        text(
            """
            CREATE TABLE diagrams (
              id SERIAL PRIMARY KEY,
              title VARCHAR(255) DEFAULT 'Схема',
              source_filename VARCHAR(255) DEFAULT '',
              source_mime VARCHAR(128) DEFAULT '',
              source_bytes BYTEA NOT NULL,
              svg_text TEXT DEFAULT '',
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagrams_title ON diagrams (title)"))
    sync_conn.execute(
        text(
            """
            CREATE TABLE diagram_bindings (
              id SERIAL PRIMARY KEY,
              diagram_id INTEGER NOT NULL REFERENCES diagrams(id) ON DELETE CASCADE,
              shape_id VARCHAR(255) NOT NULL,
              object_type VARCHAR(32) NOT NULL,
              object_id INTEGER NOT NULL,
              label VARCHAR(255),
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagram_bindings_diagram_id ON diagram_bindings (diagram_id)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagram_bindings_shape_id ON diagram_bindings (shape_id)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagram_bindings_object_type ON diagram_bindings (object_type)"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagram_bindings_object_id ON diagram_bindings (object_id)"))


def _migrate_diagrams_floor_plan(sync_conn) -> None:
    cols = _column_names(sync_conn, "diagrams")
    if "sort_order" not in cols:
        sync_conn.execute(text("ALTER TABLE diagrams ADD COLUMN sort_order INTEGER DEFAULT 0"))
    if "floor_layout_json" not in cols:
        sync_conn.execute(text("ALTER TABLE diagrams ADD COLUMN floor_layout_json TEXT DEFAULT '{}'"))
    sync_conn.execute(text("CREATE INDEX IF NOT EXISTS ix_diagrams_sort_order ON diagrams (sort_order)"))


def _migrate_ldap_users_default_observer(sync_conn) -> None:
    """Импорт LDAP не должен давать права редактора по умолчанию."""
    sync_conn.execute(
        text(
            "UPDATE users SET role = 'observer' "
            "WHERE is_ldap = TRUE AND is_superuser = FALSE "
            "AND lower(COALESCE(role, '')) IN ('', 'editor')"
        )
    )


def _migrate_ldap_users_directory_only(sync_conn) -> None:
    """LDAP и импорт — только справочник заявок, без входа в панель."""
    sync_conn.execute(
        text(
            "UPDATE users SET role = 'directory', is_superuser = FALSE "
            "WHERE is_ldap = TRUE"
        )
    )


def _migrate_purge_orphan_computer_children(sync_conn) -> None:
    """Удаляет ПО/периферию/диски без родительского ПК."""
    orphan_filter = "computer_id NOT IN (SELECT id FROM computers)"
    for table in ("installed_software", "peripherals", "disk_volumes", "computer_tags", "asset_change_logs"):
        sync_conn.execute(text(f"DELETE FROM {table} WHERE {orphan_filter}"))


def _migrate_search_index(sync_conn) -> None:
    """PostgreSQL-only search projection for deterministic catalog search."""
    if sync_conn.dialect.name != "postgresql":
        return
    sync_conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
    sync_conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS search_documents (
              id BIGSERIAL PRIMARY KEY,
              entity_type VARCHAR(32) NOT NULL,
              entity_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              body TEXT NOT NULL DEFAULT '',
              identifiers TEXT NOT NULL DEFAULT '',
              metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
              search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              CONSTRAINT uq_search_documents_entity UNIQUE (entity_type, entity_id)
            )
            """
        )
    )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_search_documents_vector "
            "ON search_documents USING GIN (search_vector)"
        )
    )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_search_documents_identifiers_trgm "
            "ON search_documents USING GIN (identifiers gin_trgm_ops)"
        )
    )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_search_documents_title_trgm "
            "ON search_documents USING GIN (title gin_trgm_ops)"
        )
    )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_search_documents_type_updated "
            "ON search_documents (entity_type, updated_at DESC)"
        )
    )
    for table, column, index_name in (
        ("computers", "hostname", "ix_computers_hostname_trgm"),
        ("computers", "serial_number", "ix_computers_serial_number_trgm"),
        ("computers", "ip_address", "ix_computers_ip_address_trgm"),
        ("installed_software", "name", "ix_installed_software_name_trgm"),
    ):
        sync_conn.execute(
            text(
                f"CREATE INDEX IF NOT EXISTS {index_name} "
                f"ON {table} USING GIN ({column} gin_trgm_ops)"
            )
            )


def _migrate_ticket_handler_tables(sync_conn) -> None:
    names = _table_names(sync_conn)
    is_sqlite = sync_conn.dialect.name == "sqlite"
    if "ticket_handler_config" not in names:
        if is_sqlite:
            ddl = """
                CREATE TABLE ticket_handler_config (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  enabled BOOLEAN NOT NULL DEFAULT 0,
                  processor_mode VARCHAR(16) NOT NULL DEFAULT 'local',
                  remote_base_url VARCHAR(512) NOT NULL DEFAULT '',
                  client_secret VARCHAR(255) NOT NULL DEFAULT '',
                  llm_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
                  llm_base_url VARCHAR(512) NOT NULL DEFAULT 'http://127.0.0.1:11434/v1',
                  llm_model VARCHAR(255) NOT NULL DEFAULT '',
                  include_corax_knowledge BOOLEAN NOT NULL DEFAULT 1,
                  include_wiki_docs BOOLEAN NOT NULL DEFAULT 1,
                  auto_create_ticket BOOLEAN NOT NULL DEFAULT 1,
                  default_priority VARCHAR(32) NOT NULL DEFAULT 'normal',
                  default_category VARCHAR(255) NOT NULL DEFAULT '',
                  default_status VARCHAR(64) NOT NULL DEFAULT 'new',
                  system_prompt TEXT NOT NULL DEFAULT '',
                  pipeline_json TEXT NOT NULL DEFAULT '[]',
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
                """
        else:
            ddl = """
                CREATE TABLE ticket_handler_config (
                  id SERIAL PRIMARY KEY,
                  enabled BOOLEAN NOT NULL DEFAULT FALSE,
                  processor_mode VARCHAR(16) NOT NULL DEFAULT 'local',
                  remote_base_url VARCHAR(512) NOT NULL DEFAULT '',
                  client_secret VARCHAR(255) NOT NULL DEFAULT '',
                  llm_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
                  llm_base_url VARCHAR(512) NOT NULL DEFAULT 'http://127.0.0.1:11434/v1',
                  llm_model VARCHAR(255) NOT NULL DEFAULT '',
                  include_corax_knowledge BOOLEAN NOT NULL DEFAULT TRUE,
                  include_wiki_docs BOOLEAN NOT NULL DEFAULT TRUE,
                  auto_create_ticket BOOLEAN NOT NULL DEFAULT TRUE,
                  default_priority VARCHAR(32) NOT NULL DEFAULT 'normal',
                  default_category VARCHAR(255) NOT NULL DEFAULT '',
                  default_status VARCHAR(64) NOT NULL DEFAULT 'new',
                  system_prompt TEXT NOT NULL DEFAULT '',
                  pipeline_json TEXT NOT NULL DEFAULT '[]',
                  updated_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
        sync_conn.execute(text(ddl))

    if "ticket_handler_runs" not in _table_names(sync_conn):
        if is_sqlite:
            ddl = """
                CREATE TABLE ticket_handler_runs (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  status VARCHAR(32) NOT NULL DEFAULT 'ok',
                  latency_ms INTEGER,
                  hostname VARCHAR(255),
                  requester_name VARCHAR(255),
                  service_request_id INTEGER,
                  error_detail TEXT,
                  meta_json TEXT,
                  FOREIGN KEY(service_request_id) REFERENCES service_requests(id) ON DELETE SET NULL
                )
                """
        else:
            ddl = """
                CREATE TABLE ticket_handler_runs (
                  id SERIAL PRIMARY KEY,
                  created_at TIMESTAMPTZ DEFAULT NOW(),
                  status VARCHAR(32) NOT NULL DEFAULT 'ok',
                  latency_ms INTEGER,
                  hostname VARCHAR(255),
                  requester_name VARCHAR(255),
                  service_request_id INTEGER REFERENCES service_requests(id) ON DELETE SET NULL,
                  error_detail TEXT,
                  meta_json TEXT
                )
                """
        sync_conn.execute(text(ddl))
        sync_conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_ticket_handler_runs_created_at ON ticket_handler_runs (created_at)")
        )
        sync_conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_ticket_handler_runs_status ON ticket_handler_runs (status)")
        )


def _migrate_service_request_ai_fields(sync_conn) -> None:
    cols = _column_names(sync_conn, "service_requests")
    patch_sql = {
        "ai_title_suggestion": "ALTER TABLE service_requests ADD COLUMN ai_title_suggestion VARCHAR(255)",
        "ai_enriched_at": "ALTER TABLE service_requests ADD COLUMN ai_enriched_at TIMESTAMP",
    }
    for key, sql in patch_sql.items():
        if key not in cols:
            sync_conn.execute(text(sql))


def _migrate_wiki_rag_semantic_index(sync_conn) -> None:
    """Чанки + статус индексации для семантического поиска WikiRAG."""
    tables = _table_names(sync_conn)
    is_sqlite = sync_conn.dialect.name == "sqlite"
    if "wiki_rag_documents" in tables:
        cols = _column_names(sync_conn, "wiki_rag_documents")
        patches = {
            "indexed_at": "ALTER TABLE wiki_rag_documents ADD COLUMN indexed_at TIMESTAMP",
            "index_status": "ALTER TABLE wiki_rag_documents ADD COLUMN index_status VARCHAR(16) DEFAULT 'pending'",
            "index_error": "ALTER TABLE wiki_rag_documents ADD COLUMN index_error TEXT",
            "chunk_count": "ALTER TABLE wiki_rag_documents ADD COLUMN chunk_count INTEGER DEFAULT 0",
        }
        for key, sql in patches.items():
            if key not in cols:
                sync_conn.execute(text(sql))
        sync_conn.execute(
            text(
                "UPDATE wiki_rag_documents SET index_status = 'pending' "
                "WHERE index_status IS NULL OR trim(index_status) = ''"
            )
        )

    if "wiki_rag_chunks" not in tables:
        if is_sqlite:
            ddl = """
                CREATE TABLE wiki_rag_chunks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  document_id INTEGER NOT NULL REFERENCES wiki_rag_documents(id) ON DELETE CASCADE,
                  chunk_index INTEGER NOT NULL DEFAULT 0,
                  content TEXT NOT NULL,
                  embedding TEXT,
                  embedding_model VARCHAR(128),
                  char_start INTEGER NOT NULL DEFAULT 0,
                  char_end INTEGER NOT NULL DEFAULT 0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  CONSTRAINT uq_wiki_rag_chunks_doc_idx UNIQUE (document_id, chunk_index)
                )
                """
        else:
            ddl = """
                CREATE TABLE wiki_rag_chunks (
                  id SERIAL PRIMARY KEY,
                  document_id INTEGER NOT NULL REFERENCES wiki_rag_documents(id) ON DELETE CASCADE,
                  chunk_index INTEGER NOT NULL DEFAULT 0,
                  content TEXT NOT NULL,
                  embedding TEXT,
                  embedding_model VARCHAR(128),
                  char_start INTEGER NOT NULL DEFAULT 0,
                  char_end INTEGER NOT NULL DEFAULT 0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  CONSTRAINT uq_wiki_rag_chunks_doc_idx UNIQUE (document_id, chunk_index)
                )
                """
        sync_conn.execute(text(ddl))
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_document_id ON wiki_rag_chunks (document_id)")
    )


def _migrate_wiki_rag_chunks_embedding_schema(sync_conn) -> None:
    """
    Старая wiki_rag_chunks (search_text / embedding_json) → схема под WikiRagChunk.
    Чанки пустые или пересоздаются переиндексацией.
    """
    tables = _table_names(sync_conn)
    if "wiki_rag_chunks" not in tables:
        _migrate_wiki_rag_semantic_index(sync_conn)
        return

    cols = _column_names(sync_conn, "wiki_rag_chunks")
    needs_rebuild = ("embedding" not in cols) or ("char_start" not in cols) or ("search_text" in cols)
    if not needs_rebuild:
        return

    is_sqlite = sync_conn.dialect.name == "sqlite"
    sync_conn.execute(text("DROP TABLE IF EXISTS wiki_rag_chunks"))
    if is_sqlite:
        ddl = """
            CREATE TABLE wiki_rag_chunks (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              document_id INTEGER NOT NULL REFERENCES wiki_rag_documents(id) ON DELETE CASCADE,
              chunk_index INTEGER NOT NULL DEFAULT 0,
              content TEXT NOT NULL,
              embedding TEXT,
              embedding_model VARCHAR(128),
              char_start INTEGER NOT NULL DEFAULT 0,
              char_end INTEGER NOT NULL DEFAULT 0,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              CONSTRAINT uq_wiki_rag_chunks_doc_idx UNIQUE (document_id, chunk_index)
            )
            """
    else:
        ddl = """
            CREATE TABLE wiki_rag_chunks (
              id SERIAL PRIMARY KEY,
              document_id INTEGER NOT NULL REFERENCES wiki_rag_documents(id) ON DELETE CASCADE,
              chunk_index INTEGER NOT NULL DEFAULT 0,
              content TEXT NOT NULL,
              embedding TEXT,
              embedding_model VARCHAR(128),
              char_start INTEGER NOT NULL DEFAULT 0,
              char_end INTEGER NOT NULL DEFAULT 0,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              CONSTRAINT uq_wiki_rag_chunks_doc_idx UNIQUE (document_id, chunk_index)
            )
            """
    sync_conn.execute(text(ddl))
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_document_id ON wiki_rag_chunks (document_id)")
    )
    if "wiki_rag_documents" in tables:
        doc_cols = _column_names(sync_conn, "wiki_rag_documents")
        if "index_status" in doc_cols:
            sync_conn.execute(
                text(
                    "UPDATE wiki_rag_documents SET index_status = 'pending', "
                    "index_error = NULL, chunk_count = 0, indexed_at = NULL"
                )
            )


def _migrate_wiki_rag_pgvector_metadata(sync_conn) -> None:
    """Метаданные чанков + pgvector (PostgreSQL). SQLite — только метаданные."""
    tables = _table_names(sync_conn)
    if "wiki_rag_chunks" not in tables:
        return
    cols = _column_names(sync_conn, "wiki_rag_chunks")
    meta_cols = {
        "source_kind": "ALTER TABLE wiki_rag_chunks ADD COLUMN source_kind VARCHAR(32)",
        "source_table": "ALTER TABLE wiki_rag_chunks ADD COLUMN source_table VARCHAR(64)",
        "hostname": "ALTER TABLE wiki_rag_chunks ADD COLUMN hostname VARCHAR(255)",
        "computer_id": "ALTER TABLE wiki_rag_chunks ADD COLUMN computer_id INTEGER",
        "snapshot_at": "ALTER TABLE wiki_rag_chunks ADD COLUMN snapshot_at TIMESTAMP",
        "meta_json": "ALTER TABLE wiki_rag_chunks ADD COLUMN meta_json TEXT",
    }
    for name, ddl in meta_cols.items():
        if name not in cols:
            sync_conn.execute(text(ddl))
    for ddl in (
        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_source_kind ON wiki_rag_chunks (source_kind)",
        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_source_table ON wiki_rag_chunks (source_table)",
        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_hostname ON wiki_rag_chunks (hostname)",
        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_computer_id ON wiki_rag_chunks (computer_id)",
    ):
        _pg_try_execute(sync_conn, ddl)

    if sync_conn.dialect.name != "postgresql":
        return
    # Without pgvector installed, CREATE EXTENSION fails and would otherwise abort
    # the whole migration transaction (InFailedSQLTransactionError on mark_applied).
    if not _pg_try_execute(sync_conn, "CREATE EXTENSION IF NOT EXISTS vector"):
        return
    cols = _column_names(sync_conn, "wiki_rag_chunks")
    if "embedding_vec" not in cols:
        if not _pg_try_execute(
            sync_conn, "ALTER TABLE wiki_rag_chunks ADD COLUMN embedding_vec vector(1024)"
        ):
            return
    if not _pg_try_execute(
        sync_conn,
        "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_embedding_vec_hnsw "
        "ON wiki_rag_chunks USING hnsw (embedding_vec vector_cosine_ops)",
    ):
        _pg_try_execute(
            sync_conn,
            "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_embedding_vec_ivfflat "
            "ON wiki_rag_chunks USING ivfflat (embedding_vec vector_cosine_ops) WITH (lists = 100)",
        )


def _migrate_wiki_rag_russian_fts(sync_conn) -> None:
    """Добавляет русскоязычный lexical-путь для hybrid WikiRAG retrieval."""
    if sync_conn.dialect.name != "postgresql" or "wiki_rag_chunks" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "wiki_rag_chunks")
    if "search_vector" not in cols:
        sync_conn.execute(
            text("ALTER TABLE wiki_rag_chunks ADD COLUMN search_vector TSVECTOR NOT NULL DEFAULT ''::tsvector")
        )
    sync_conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_wiki_rag_chunks_search_vector "
            "ON wiki_rag_chunks USING GIN (search_vector)"
        )
    )
    sync_conn.execute(
        text(
            "UPDATE wiki_rag_chunks "
            "SET search_vector = to_tsvector('russian', content) "
            "WHERE search_vector = ''::tsvector"
        )
    )


def _migrate_service_request_ops_indexes(sync_conn) -> None:
    if "service_requests" not in _table_names(sync_conn):
        return
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_service_requests_status ON service_requests (status)")
    )
    dialect = sync_conn.dialect.name
    if dialect == "postgresql":
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_service_requests_closed_at "
                "ON service_requests (closed_at) WHERE closed_at IS NOT NULL"
            )
        )
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_service_requests_planned_close_at "
                "ON service_requests (planned_close_at) WHERE planned_close_at IS NOT NULL"
            )
        )
    else:
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_service_requests_closed_at "
                "ON service_requests (closed_at)"
            )
        )
        sync_conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_service_requests_planned_close_at "
                "ON service_requests (planned_close_at)"
            )
        )


def _migrate_risk_snapshots_and_acks(sync_conn) -> None:
    names = _table_names(sync_conn)
    is_sqlite = sync_conn.dialect.name == "sqlite"
    if "risk_snapshots" not in names:
        if is_sqlite:
            ddl = """
                CREATE TABLE risk_snapshots (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  fleet_health_score INTEGER NOT NULL,
                  average_risk_score FLOAT NOT NULL DEFAULT 0,
                  computers_total INTEGER NOT NULL DEFAULT 0,
                  computers_critical INTEGER NOT NULL DEFAULT 0,
                  computers_high INTEGER NOT NULL DEFAULT 0,
                  computers_medium INTEGER NOT NULL DEFAULT 0,
                  computers_healthy INTEGER NOT NULL DEFAULT 0,
                  findings_open INTEGER NOT NULL DEFAULT 0
                )
                """
        else:
            ddl = """
                CREATE TABLE risk_snapshots (
                  id SERIAL PRIMARY KEY,
                  created_at TIMESTAMPTZ DEFAULT NOW(),
                  fleet_health_score INTEGER NOT NULL,
                  average_risk_score DOUBLE PRECISION NOT NULL DEFAULT 0,
                  computers_total INTEGER NOT NULL DEFAULT 0,
                  computers_critical INTEGER NOT NULL DEFAULT 0,
                  computers_high INTEGER NOT NULL DEFAULT 0,
                  computers_medium INTEGER NOT NULL DEFAULT 0,
                  computers_healthy INTEGER NOT NULL DEFAULT 0,
                  findings_open INTEGER NOT NULL DEFAULT 0
                )
                """
        sync_conn.execute(text(ddl))
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_risk_snapshots_created_at ON risk_snapshots (created_at)")
    )

    if "risk_finding_acks" not in _table_names(sync_conn):
        if is_sqlite:
            ddl = """
                CREATE TABLE risk_finding_acks (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  finding_id VARCHAR(128) NOT NULL UNIQUE,
                  computer_id INTEGER NOT NULL,
                  status VARCHAR(16) NOT NULL DEFAULT 'acknowledged',
                  note VARCHAR(500),
                  user_id INTEGER,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY(computer_id) REFERENCES computers(id) ON DELETE CASCADE,
                  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
                )
                """
        else:
            ddl = """
                CREATE TABLE risk_finding_acks (
                  id SERIAL PRIMARY KEY,
                  finding_id VARCHAR(128) NOT NULL UNIQUE,
                  computer_id INTEGER NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
                  status VARCHAR(16) NOT NULL DEFAULT 'acknowledged',
                  note VARCHAR(500),
                  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                  created_at TIMESTAMPTZ DEFAULT NOW(),
                  updated_at TIMESTAMPTZ DEFAULT NOW()
                )
                """
        sync_conn.execute(text(ddl))
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_risk_finding_acks_finding_id ON risk_finding_acks (finding_id)")
    )
    sync_conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_risk_finding_acks_computer_id ON risk_finding_acks (computer_id)")
    )


_MIGRATIONS: list[tuple[str, MigrationFn]] = [
    ("2026-04-16_schema_migrations", lambda c: None),
    ("2026-04-16_tags_color", _migrate_tags_color_column),
    ("2026-04-16_computers_extra", _migrate_computers_columns),
    ("2026-04-17_service_requests_external", _migrate_service_requests_columns),
    ("2026-04-16_service_request_templates_extra", _migrate_service_request_templates_columns),
    ("2026-04-16_ldap_allow_anonymous", _migrate_ldap_config_columns),
    ("2026-04-16_users_is_ldap", _migrate_users_columns),
    ("2026-05-08_users_role", _migrate_users_columns),
    ("2026-05-20_ldap_users_observer", _migrate_ldap_users_default_observer),
    ("2026-07-03_ldap_users_directory", _migrate_ldap_users_directory_only),
    ("2026-04-22_monitors", _migrate_monitors_table),
    ("2026-04-24_diagrams", _migrate_diagrams),
    ("2026-04-24_diagrams_floor_plan", _migrate_diagrams_floor_plan),
    ("2026-05-21_printers", _migrate_printers_table),
    ("2026-05-21_printer_snmp", _migrate_printer_snmp_columns),
    ("2026-05-21_printer_poll_config", _migrate_printer_poll_config),
    ("2026-05-21_printer_poll_interval_30", _migrate_printer_poll_interval_30),
    ("2026-08-06_printer_kind_serial", _migrate_printer_kind_serial),
    ("2026-05-26_service_request_categories", _migrate_service_request_categories),
    ("2026-05-26_service_request_categories_tree", _migrate_service_request_categories_tree),
    ("2026-05-27_service_request_ticket_no", _migrate_service_request_ticket_no),
    ("2026-06-15_purge_orphan_computer_children", _migrate_purge_orphan_computer_children),
    ("2026-07-13_users_avatar", _migrate_users_avatar_columns),
    ("2026-07-13_users_avatar_data", _migrate_users_avatar_data),
    ("2026-07-24_users_linked_directory", _migrate_users_linked_directory),
    ("2026-08-14_users_must_change_password", _migrate_users_must_change_password),
    ("2026-07-15_network_devices", _migrate_network_tables),
    ("2026-07-15_network_extras_json", _migrate_network_extras_json),
    ("2026-07-16_wake_on_lan_config", _migrate_wake_on_lan_config),
    ("2026-07-16_wol_wake_user_ids", _migrate_wol_wake_user_ids),
    ("2026-07-21_wol_cooldown_zero", _migrate_wol_cooldown_zero),
    ("2026-07-16_computers_ip_address", _migrate_computers_ip_address),
    ("2026-07-16_computers_ping_status", _migrate_computers_ping_status),
    ("2026-07-27_notes", _migrate_notes_tables),
    ("2026-07-30_search_index", _migrate_search_index),
    ("2026-08-04_ticket_handler", _migrate_ticket_handler_tables),
    ("2026-08-04_service_request_ai_fields", _migrate_service_request_ai_fields),
    ("2026-08-05_wiki_rag_semantic_index", _migrate_wiki_rag_semantic_index),
    ("2026-08-05_wiki_rag_chunks_embedding_schema", _migrate_wiki_rag_chunks_embedding_schema),
    ("2026-08-06_wiki_rag_pgvector_metadata", _migrate_wiki_rag_pgvector_metadata),
    ("2026-08-06_wiki_rag_russian_fts", _migrate_wiki_rag_russian_fts),
    ("2026-08-17_service_requests_perf_indexes", _migrate_service_request_ops_indexes),
    ("2026-08-17_risk_snapshots_and_acks", _migrate_risk_snapshots_and_acks),
]


def _fix_postgres_serial_sequences(sync_conn) -> None:
    """Синхронизирует SERIAL/IDENTITY после импорта строк с явным id (SQLite → PostgreSQL)."""
    if sync_conn.dialect.name != "postgresql":
        return
    seq_rows = sync_conn.execute(
        text("SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'")
    ).fetchall()
    for (seq_name,) in seq_rows:
        if not str(seq_name).endswith("_id_seq"):
            continue
        table_name = str(seq_name)[: -len("_id_seq")]
        if not table_name:
            continue
        tables = sync_conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = :t LIMIT 1"
            ),
            {"t": table_name},
        ).first()
        if not tables:
            continue
        max_id = sync_conn.execute(
            text(f'SELECT COALESCE(MAX(id), 0) FROM "{table_name}"')
        ).scalar()
        if max_id and int(max_id) > 0:
            sync_conn.execute(text("SELECT setval(:seq, :val, true)"), {"seq": seq_name, "val": int(max_id)})


def apply_migrations(sync_conn) -> None:
    _ensure_schema_migrations(sync_conn)
    for version, fn in _MIGRATIONS:
        if _is_applied(sync_conn, version):
            continue
        fn(sync_conn)
        _mark_applied(sync_conn, version)
    _fix_postgres_serial_sequences(sync_conn)


def apply_diagrams_migrations(sync_conn) -> None:
    """
    Отдельные миграции для БД схем (diagrams).
    Содержит только таблицы diagrams / diagram_bindings и их доп.колонки.
    """
    _ensure_schema_migrations(sync_conn)
    for version, fn in [
        ("2026-04-24_diagrams", _migrate_diagrams),
        ("2026-04-24_diagrams_floor_plan", _migrate_diagrams_floor_plan),
    ]:
        if _is_applied(sync_conn, version):
            continue
        fn(sync_conn)
        _mark_applied(sync_conn, version)
    _fix_postgres_serial_sequences(sync_conn)


def _migrate_warehouse_manufacturer(sync_conn) -> None:
    if "stock_items" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "stock_items")
    if "manufacturer" in cols:
        return
    sync_conn.execute(text("ALTER TABLE stock_items ADD COLUMN manufacturer VARCHAR(255)"))


def _migrate_warehouse_external_id(sync_conn) -> None:
    if "stock_items" not in _table_names(sync_conn):
        return
    cols = _column_names(sync_conn, "stock_items")
    if "external_id" in cols:
        return
    sync_conn.execute(text("ALTER TABLE stock_items ADD COLUMN external_id VARCHAR(64)"))


def apply_warehouse_migrations(sync_conn) -> None:
    """Миграции для склада. Таблицы создаются через metadata.create_all."""
    _ensure_schema_migrations(sync_conn)
    for version, fn in [
        ("2026-05-21_warehouse_init", lambda _conn: None),
        ("2026-08-17_warehouse_manufacturer", _migrate_warehouse_manufacturer),
        ("2026-08-17_warehouse_external_id", _migrate_warehouse_external_id),
    ]:
        if _is_applied(sync_conn, version):
            continue
        fn(sync_conn)
        _mark_applied(sync_conn, version)
    _fix_postgres_serial_sequences(sync_conn)
