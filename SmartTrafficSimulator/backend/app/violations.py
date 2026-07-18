from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Protocol
from uuid import UUID, uuid4

from .schemas import ViolationEvent


class ViolationRepository(Protocol):
    def list(self, limit: int = 200, offset: int = 0) -> list[ViolationEvent]: ...
    def add(self, event: ViolationEvent) -> ViolationEvent | None: ...
    def delete(self, ids: list[UUID] | None = None) -> tuple[int, list[str], list[str]]: ...


class SQLiteViolationRepository:
    def __init__(self, database_path: Path, evidence_dir: Path) -> None:
        self.database_path = database_path
        self.evidence_dir = evidence_dir
        database_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path)
        connection.row_factory = sqlite3.Row
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS violations (
                    id TEXT PRIMARY KEY,
                    track_id INTEGER NOT NULL,
                    violation TEXT NOT NULL,
                    license_plate TEXT NOT NULL,
                    timestamp_ms INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    evidence_path TEXT,
                    UNIQUE(track_id, violation)
                )
                """
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS plate_blacklist (license_plate TEXT PRIMARY KEY)"
            )

    def list(self, limit: int = 200, offset: int = 0) -> list[ViolationEvent]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT payload, evidence_path FROM violations ORDER BY timestamp_ms DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        result: list[ViolationEvent] = []
        for row in rows:
            payload = json.loads(row["payload"])
            if row["evidence_path"]:
                payload["evidenceImageUrl"] = f"/api/evidence/{row['evidence_path']}"
            result.append(ViolationEvent.model_validate(payload))
        return result

    def add(self, event: ViolationEvent) -> ViolationEvent | None:
        record_id = event.id or uuid4()
        evidence_path = None
        stored = event.model_copy(
            update={"id": record_id, "evidence_image": None, "evidence_image_url": None}
        )
        payload = stored.model_dump(by_alias=True, mode="json", exclude_none=True)
        try:
            with self._connect() as connection:
                connection.execute(
                    "INSERT INTO violations VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        str(record_id),
                        event.track_id,
                        event.violation,
                        event.license_plate,
                        event.timestamp_ms,
                        json.dumps(payload, ensure_ascii=False),
                        evidence_path,
                    ),
                )
                connection.execute(
                    "INSERT OR IGNORE INTO plate_blacklist VALUES (?)",
                    (event.license_plate,),
                )
        except sqlite3.IntegrityError:
            if evidence_path:
                (self.evidence_dir / evidence_path).unlink(missing_ok=True)
            return None
        if evidence_path:
            stored = stored.model_copy(update={"evidence_image_url": f"/api/evidence/{evidence_path}"})
        return stored

    def delete(self, ids: list[UUID] | None = None) -> tuple[int, list[str], list[str]]:
        with self._connect() as connection:
            if ids is None:
                rows = connection.execute(
                    "SELECT id, license_plate, evidence_path FROM violations"
                ).fetchall()
            else:
                placeholders = ",".join("?" for _ in ids)
                rows = connection.execute(
                    f"SELECT id, license_plate, evidence_path FROM violations WHERE id IN ({placeholders})",
                    tuple(map(str, ids)),
                ).fetchall()
            if not rows:
                return 0, [], []
            row_ids = [row["id"] for row in rows]
            plates = sorted({row["license_plate"] for row in rows})
            paths = [row["evidence_path"] for row in rows if row["evidence_path"]]
            placeholders = ",".join("?" for _ in row_ids)
            connection.execute(
                f"DELETE FROM violations WHERE id IN ({placeholders})",
                row_ids,
            )
            for plate in plates:
                remaining = connection.execute(
                    "SELECT 1 FROM violations WHERE license_plate = ? LIMIT 1",
                    (plate,),
                ).fetchone()
                if remaining is None:
                    connection.execute(
                        "DELETE FROM plate_blacklist WHERE license_plate = ?",
                        (plate,),
                    )
        for path in paths:
            (self.evidence_dir / path).unlink(missing_ok=True)
        return len(rows), plates, paths

    def _save_image(self, record_id: UUID, data_url: str | None) -> str | None:
        if not data_url:
            return None
        prefix = "data:image/jpeg;base64,"
        if not data_url.startswith(prefix):
            return None
        import base64

        try:
            data = base64.b64decode(data_url[len(prefix):], validate=True)
        except ValueError:
            return None
        if len(data) > 1_500_000:
            return None
        name = f"{record_id}.jpg"
        (self.evidence_dir / name).write_bytes(data)
        return name
