"""Local Markdown + Voice Notes store with SQLite FTS5 index, sync state, and voiceprints."""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Optional


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
        self.voiceprints_json = state_db.parent / "voiceprints.json"
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
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS voiceprints (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                embedding_json TEXT NOT NULL DEFAULT '[]',
                sample_count INTEGER NOT NULL DEFAULT 1,
                source TEXT NOT NULL DEFAULT 'desktop',
                notes TEXT NOT NULL DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        self.conn.commit()
        self._import_voiceprints_json_if_empty()

    def _import_voiceprints_json_if_empty(self) -> None:
        count = self.conn.execute("SELECT COUNT(*) FROM voiceprints").fetchone()[0]
        if count > 0 or not self.voiceprints_json.is_file():
            return
        try:
            items = json.loads(self.voiceprints_json.read_text(encoding="utf-8"))
        except Exception:
            return
        if not isinstance(items, list):
            return
        now = time.time()
        for item in items:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            emb = item.get("embedding")
            emb_list = emb if isinstance(emb, list) else []
            vp_id = str(item.get("id") or uuid.uuid4().hex[:12])
            self.conn.execute(
                """
                INSERT OR IGNORE INTO voiceprints
                    (id, name, embedding_json, sample_count, source, notes, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    vp_id,
                    name,
                    json.dumps(emb_list),
                    int(item.get("sample_count") or 1),
                    str(item.get("source") or "imported"),
                    str(item.get("notes") or ""),
                    float(item.get("created_at") or now),
                    float(item.get("updated_at") or now),
                ),
            )
        self.conn.commit()

    def _export_voiceprints_json(self) -> None:
        rows = self.conn.execute(
            "SELECT id, name, embedding_json, sample_count, source, notes, created_at, updated_at FROM voiceprints ORDER BY updated_at DESC"
        ).fetchall()
        payload = []
        for r in rows:
            try:
                emb = json.loads(r[2]) if r[2] else []
            except Exception:
                emb = []
            payload.append(
                {
                    "id": r[0],
                    "name": r[1],
                    "embedding": emb,
                    "sample_count": r[3],
                    "source": r[4],
                    "notes": r[5],
                    "created_at": r[6],
                    "updated_at": r[7],
                }
            )
        tmp = self.voiceprints_json.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.voiceprints_json)

    @staticmethod
    def _normalize_embedding(vec: list[float]) -> list[float]:
        norm = math.sqrt(sum(v * v for v in vec))
        if norm < 1e-8:
            return vec
        return [round(v / norm, 6) for v in vec]

    def list_voiceprints(self, include_embeddings: bool = False) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT id, name, embedding_json, sample_count, source, notes, created_at, updated_at FROM voiceprints ORDER BY updated_at DESC"
        ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            try:
                emb = json.loads(r[2]) if r[2] else []
            except Exception:
                emb = []
            item: dict[str, Any] = {
                "id": r[0],
                "name": r[1],
                "embedding_dim": len(emb),
                "sample_count": r[3],
                "source": r[4],
                "notes": r[5],
                "created_at": r[6],
                "updated_at": r[7],
            }
            if include_embeddings:
                item["embedding"] = emb
            out.append(item)
        return out

    def create_voiceprint(
        self,
        name: str,
        embedding: Optional[list[float]] = None,
        sample_count: int = 1,
        source: str = "desktop",
        notes: str = "",
    ) -> dict[str, Any]:
        clean = name.strip()
        if not clean:
            raise ValueError("Voiceprint name is required")
        now = time.time()
        vp_id = uuid.uuid4().hex[:12]
        emb = [float(x) for x in embedding] if isinstance(embedding, list) else []
        if emb:
            emb = self._normalize_embedding(emb)
        self.conn.execute(
            """
            INSERT INTO voiceprints (id, name, embedding_json, sample_count, source, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (vp_id, clean, json.dumps(emb), max(1, int(sample_count)), source, notes, now, now),
        )
        self.conn.commit()
        self._export_voiceprints_json()
        return {
            "id": vp_id,
            "name": clean,
            "embedding_dim": len(emb),
            "sample_count": max(1, int(sample_count)),
            "source": source,
            "notes": notes,
            "created_at": now,
            "updated_at": now,
        }

    def update_voiceprint(
        self,
        vp_id: str,
        name: Optional[str] = None,
        notes: Optional[str] = None,
        relabel_notes: bool = False,
    ) -> dict[str, Any]:
        row = self.conn.execute(
            "SELECT id, name, embedding_json, sample_count, source, notes, created_at FROM voiceprints WHERE id = ?",
            (vp_id,),
        ).fetchone()
        if not row:
            raise FileNotFoundError(vp_id)
        old_name = row[1]
        new_name = name.strip() if name is not None and name.strip() else old_name
        new_notes = notes if notes is not None else row[5]
        now = time.time()
        self.conn.execute(
            "UPDATE voiceprints SET name = ?, notes = ?, updated_at = ? WHERE id = ?",
            (new_name, new_notes, now, vp_id),
        )
        self.conn.commit()
        self._export_voiceprints_json()
        relabeled = 0
        if relabel_notes and new_name != old_name:
            relabeled = self.relabel_speaker_in_notes(old_name, new_name)
        emb = json.loads(row[2]) if row[2] else []
        return {
            "id": vp_id,
            "name": new_name,
            "embedding_dim": len(emb),
            "sample_count": row[3],
            "source": row[4],
            "notes": new_notes,
            "created_at": row[6],
            "updated_at": now,
            "relabeled_notes": relabeled,
        }

    def merge_voiceprints(
        self,
        ids: list[str],
        target_name: str,
        relabel_notes: bool = True,
    ) -> dict[str, Any]:
        unique_ids = list(dict.fromkeys(i for i in ids if i))
        if len(unique_ids) < 2:
            raise ValueError("Select at least 2 voiceprints to merge")
        clean_target = target_name.strip()
        if not clean_target:
            raise ValueError("Target name is required")

        placeholders = ",".join("?" for _ in unique_ids)
        rows = self.conn.execute(
            f"SELECT id, name, embedding_json, sample_count, notes FROM voiceprints WHERE id IN ({placeholders})",
            unique_ids,
        ).fetchall()
        if len(rows) < 2:
            raise ValueError("Could not find at least 2 matching voiceprints")

        total_samples = 0
        weighted_sum: Optional[list[float]] = None
        old_names: list[str] = []
        merged_notes: list[str] = []

        for r in rows:
            old_names.append(r[1])
            samples = max(1, int(r[3] or 1))
            total_samples += samples
            if r[4]:
                merged_notes.append(r[4])
            try:
                emb = [float(x) for x in json.loads(r[2] or "[]")]
            except Exception:
                emb = []
            if emb:
                if weighted_sum is None:
                    weighted_sum = [v * samples for v in emb]
                elif len(emb) == len(weighted_sum):
                    weighted_sum = [a + b * samples for a, b in zip(weighted_sum, emb)]

        merged_emb = self._normalize_embedding(weighted_sum) if weighted_sum else []
        keep_id = rows[0][0]
        drop_ids = [r[0] for r in rows[1:]]
        now = time.time()

        self.conn.execute(
            """
            UPDATE voiceprints
            SET name = ?, embedding_json = ?, sample_count = ?, source = 'merged', notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                clean_target,
                json.dumps(merged_emb),
                total_samples,
                " | ".join(dict.fromkeys(merged_notes)),
                now,
                keep_id,
            ),
        )
        drop_ph = ",".join("?" for _ in drop_ids)
        self.conn.execute(f"DELETE FROM voiceprints WHERE id IN ({drop_ph})", drop_ids)
        self.conn.commit()
        self._export_voiceprints_json()

        relabeled = 0
        if relabel_notes:
            for old in set(old_names):
                if old != clean_target:
                    relabeled += self.relabel_speaker_in_notes(old, clean_target)

        return {
            "id": keep_id,
            "name": clean_target,
            "embedding_dim": len(merged_emb),
            "sample_count": total_samples,
            "merged_count": len(rows),
            "relabeled_notes": relabeled,
        }

    def delete_voiceprint(self, vp_id: str) -> None:
        self.conn.execute("DELETE FROM voiceprints WHERE id = ?", (vp_id,))
        self.conn.commit()
        self._export_voiceprints_json()

    def relabel_speaker_in_notes(
        self,
        from_label: str,
        to_label: str,
        rel_path: Optional[str] = None,
    ) -> int:
        src = from_label.strip()
        dst = to_label.strip()
        if not src or not dst or src == dst:
            return 0
        targets = [self._safe_path(rel_path)] if rel_path else list(self.notes_dir.rglob("*.md"))
        esc = re.escape(src)
        patterns = [
            (re.compile(rf"(\*\*){esc}(\*\*:)"), rf"\1{dst}\2"),
            (re.compile(rf"(\*\*){esc}(:\*\*)"), rf"\1{dst}\2"),
            (re.compile(rf"(\[){esc}(\])"), rf"\1{dst}\2"),
            (re.compile(rf"(?m)^({esc})(\s*:)"), rf"{dst}\2"),
        ]
        updated = 0
        for p in targets:
            if not p.is_file():
                continue
            try:
                md = p.read_text(encoding="utf-8")
            except OSError:
                continue
            new_md = md
            for pat, repl in patterns:
                new_md = pat.sub(repl, new_md)
            if new_md != md:
                self.write_note(p.relative_to(self.notes_dir).as_posix(), new_md)
                updated += 1
        return updated

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
