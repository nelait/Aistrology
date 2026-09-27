"""Engine and session management, plus PostgreSQL row-level security (MT-001)."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .models import TENANT_TABLES, Base


class Database:
    def __init__(self, url: str):
        self.url = url
        kwargs: dict = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
        else:
            kwargs.update(pool_pre_ping=True, pool_size=10, max_overflow=20)
        self.engine: Engine = create_engine(url, **kwargs)
        if url.startswith("sqlite"):

            @event.listens_for(self.engine, "connect")
            def _sqlite_pragmas(dbapi_conn, _):  # pragma: no cover - trivial
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA foreign_keys=ON")
                cur.close()

        self.is_postgres = self.engine.dialect.name == "postgresql"
        self._factory = sessionmaker(self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        """Create tables (Alembic migrations take over once the schema stabilizes) and RLS policies on Postgres."""
        Base.metadata.create_all(self.engine)
        if self.is_postgres:
            with self.engine.begin() as conn:
                for table in TENANT_TABLES:
                    conn.execute(text(f"ALTER TABLE {table.name} ENABLE ROW LEVEL SECURITY"))
                    conn.execute(text(f"ALTER TABLE {table.name} FORCE ROW LEVEL SECURITY"))
                    conn.execute(text(f"DROP POLICY IF EXISTS tenant_isolation ON {table.name}"))
                    # app.tenant_id unset → '' → no rows visible. 'platform' is used only by
                    # the system (signup, workers) and sees everything.
                    conn.execute(
                        text(
                            f"CREATE POLICY tenant_isolation ON {table.name} "
                            "USING (tenant_id = current_setting('app.tenant_id', true) "
                            "OR current_setting('app.tenant_id', true) = 'platform')"
                        )
                    )

    @contextmanager
    def session(self, tenant_id: str | None = None) -> Iterator[Session]:
        """A transactional session. ``tenant_id`` scopes RLS on Postgres; None means platform (system) scope."""
        session = self._factory()
        try:
            if self.is_postgres:
                session.execute(text("SELECT set_config('app.tenant_id', :t, true)"), {"t": tenant_id or "platform"})
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()


def default_url(data_dir: Path) -> str:
    data_dir.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{data_dir / 'metadata.db'}"
