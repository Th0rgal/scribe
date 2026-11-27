"""Local Markdown + Voice Notes store with SQLite FTS5 index and sync state."""
from __future__ import annotations

import hashlib
import sqlite3
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional


@dataclass
class NoteMeta:
    rel_path: str
    title: str
    preview: str
    updated_at: float
    is_voice: bool
    audio_rel_path: Optional[str]
    synced: bool


class NoteStore:
    def __init__(self, notes_dir: Path, state_db: Path) -> None:
        self.notes_dir = notes_dir.expanduser().resolve()
        self.notes_dir.mkdir(parents=True, exist_ok=True)
        state_db.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(state_db), check_same_thread=False)
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS sync_state (
                rel_path TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                document_id TEXT NOT NULL,
                synced_at TEXT NOT NULL
            )
            """
        )
        self.conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
                rel_path UNINDEXED,
                title,
                body
            )
            """
        )
        self.conn.commit()

    def _safe_path(self, rel_path: str) -> Path:
        clean = rel_path.replace("\\", "/").lstrip("/")
        if ".." in Path(clean).parts:
            raise ValueError("Invalid note path")
        if not clean.endswith(".md"):
            clean += ".md"
        p = (self.notes_dir / clean).resolve()
        if not str(p).startswith(str(self.notes_dir)):
            raise ValueError("Path escapes notes directory")
        return p

    @staticmethod
    def _extract_title_and_preview(md: str, fallback: str) -> tuple[str, str]:
        lines = [ln.strip() for ln in md.splitlines() if ln.strip() and ln.strip() != "---"]
        title = fallback
        preview_lines: list[str] = []
        in_fm = md.lstrip().startswith("---")
        fm_count = 0
        for raw in md.splitlines():
            s = raw.strip()
            if in_fm and s == "---":
                fm_count += 1
                if fm_count >= 2:
                    in_fm = False
                continue
            if in_fm:
                if s.lower().startswith("title:"):
                    t = s.split(":", 1)[1].strip().strip('"').strip("'")
                    if t:
                        title = t
                continue
            if not s:
                continue
            if s.startswith("# ") and title == fallback:
                title = s[2:].strip()
                continue
            preview_lines.append(s)
            if len(" ".join(preview_lines)) > 140:
                break
        if not title and lines:
            title = lines[0].lstrip("#").strip() or fallback
        return title, " ".join(preview_lines)[:140]

    def _find_audio(self, md_path: Path) -> Optional[str]:
        for ext in (".m4a", ".mp3", ".wav", ".ogg", ".webm"):
            cand = md_path.with_suffix(ext)
            if cand.is_file():
                return cand.relative_to(self.notes_dir).as_posix()
        return None

    def _is_synced(self, rel_path: str, md: str) -> bool:
        h = hashlib.sha256(md.encode("utf-8")).hexdigest()
        row = self.conn.execute(
            "SELECT content_hash FROM sync_state WHERE rel_path = ?", (rel_path,)
        ).fetchone()
        return bool(row and row[0] == h)

    def mark_synced(self, rel_path: str, content_hash: str, document_id: str, synced_at: str) -> None:
        self.conn.execute(
            """
            INSERT INTO sync_state (rel_path, content_hash, document_id, synced_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(rel_path) DO UPDATE SET
                content_hash = excluded.content_hash,
                document_id = excluded.document_id,
                synced_at = excluded.synced_at
            """,
            (rel_path, content_hash, document_id, synced_at),
        )
        self.conn.commit()

    def list_notes(self, query: str = "") -> list[dict]:
        notes: list[NoteMeta] = []
        q = query.strip().lower()
        for p in sorted(self.notes_dir.rglob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
            rel = p.relative_to(self.notes_dir).as_posix()
            try:
                md = p.read_text(encoding="utf-8")
            except OSError:
                continue
            title, preview = self._extract_title_and_preview(md, p.stem)
            if q and q not in title.lower() and q not in md.lower() and q not in rel.lower():
                continue
            audio = self._find_audio(p)
            notes.append(
                NoteMeta(
                    rel_path=rel,
                    title=title,
                    preview=preview,
                    updated_at=p.stat().st_mtime,
                    is_voice=audio is not None or "recorded_at:" in md[:300],
                    audio_rel_path=audio,
                    synced=self._is_synced(rel, md),
                )
            )
        return [asdict(n) for n in notes]

    def read_note(self, rel_path: str) -> dict:
        p = self._safe_path(rel_path)
        if not p.is_file():
            raise FileNotFoundError(rel_path)
        md = p.read_text(encoding="utf-8")
        title, preview = self._extract_title_and_preview(md, p.stem)
        audio = self._find_audio(p)
        rel = p.relative_to(self.notes_dir).as_posix()
        return {
            "rel_path": rel,
            "title": title,
            "preview": preview,
            "markdown": md,
            "updated_at": p.stat().st_mtime,
            "is_voice": audio is not None or "recorded_at:" in md[:300],
            "audio_rel_path": audio,
            "synced": self._is_synced(rel, md),
        }

    def write_note(self, rel_path: str, markdown: str) -> dict:
        p = self._safe_path(rel_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".md.tmp")
        tmp.write_text(markdown, encoding="utf-8")
        tmp.replace(p)
        rel = p.relative_to(self.notes_dir).as_posix()
        title, _ = self._extract_title_and_preview(markdown, p.stem)
        self.conn.execute("DELETE FROM notes_fts WHERE rel_path = ?", (rel,))
        self.conn.execute(
            "INSERT INTO notes_fts (rel_path, title, body) VALUES (?, ?, ?)",
            (rel, title, markdown),
        )
        self.conn.commit()
        return self.read_note(rel)

    def create_note(self, title: str = "Untitled Note") -> dict:
        slug = f"{time.strftime('%Y-%m-%d_%H-%M-%S')}.md"
        return self.write_note(slug, f"# {title}\n\n")

    def delete_note(self, rel_path: str) -> None:
        p = self._safe_path(rel_path)
        if p.is_file():
            p.unlink()
        self.conn.execute("DELETE FROM notes_fts WHERE rel_path = ?", (rel_path,))
        self.conn.execute("DELETE FROM sync_state WHERE rel_path = ?", (rel_path,))
        self.conn.commit()
