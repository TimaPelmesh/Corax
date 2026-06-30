from app.pg_backup import parse_database_url


def test_parse_database_url_asyncpg():
    cfg = parse_database_url("postgresql+asyncpg://inventory:secret@localhost:5432/inventory")
    assert cfg.host == "localhost"
    assert cfg.port == 5432
    assert cfg.user == "inventory"
    assert cfg.password == "secret"
    assert cfg.dbname == "inventory"
