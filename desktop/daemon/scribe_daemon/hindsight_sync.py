"""Automatic two-way (push + pull) sync of Scribe notes with Thomas's Hindsight `thomas` bank under `scribe/`."""
from __future__ import annotations

import hashlib
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def resolve_hindsight_token() -> Optional[str]:
    for env_key in ("HINDSIGHT_API_KEY", "SPARK_MEMORY_API_TOKEN"):
        val = os.environ.get(env_key, "").strip()
        if val:
            return val
    for file_key in ("HINDSIGHT_API_KEY_FILE", "SPARK_MEMORY_API_TOKEN_FILE"):
        p = os.environ.get(file_key, "").strip()
        if p and Path(p).is_file():
            tok = Path(p).read_text(encoding="utf-8").strip()
            if tok:
                return tok
    return None


class HindsightNoteSyncer:
    """Two-way sync of local Markdown + voice notes with Hindsight `thomas` bank under `scribe/`."""

    def __init__(
        self,
        api_url: Optional[str] = None,
        bank_id: Optional[str] = None,
        folder_prefix: Optional[str] = None,
    ) -> None:
        self.api_url = (api_url or os.environ.get("HINDSIGHT_API_URL") or "https://memory.thomas.md").rstrip("/")
        self.bank_id = (bank_id or os.environ.get("HINDSIGHT_BANK_ID") or "thomas").strip()
        self.folder_prefix = (folder_prefix or os.environ.get("SCRIBE_HINDSIGHT_FOLDER") or "scribe").strip().strip("/")

    @staticmethod
    def content_hash(markdown: str) -> str:
        return hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    @staticmethod
    def is_private(markdown: str) -> bool:
        lower = markdown.lower()
        return "#private" in lower or "#nosync" in lower or "sync: false" in lower

    def document_id_for(self, rel_path: str) -> str:
        clean = rel_path.replace("\\", "/").lstrip("/")
        return f"{self.folder_prefix}/{clean}"

    def rel_path_from_doc_id(self, doc_id: str) -> Optional[str]:
        prefix = f"{self.folder_prefix}/"
        if not doc_id.startswith(prefix):
            return None
        rel = doc_id[len(prefix):].lstrip("/")
        if not rel or ".." in Path(rel).parts:
            return None
        return rel if rel.endswith(".md") else f"{rel}.md"

    def _headers(self, token: str) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        }

    def sync_note(self, rel_path: str, title: str, markdown: str, is_voice: bool = False) -> dict[str, Any]:
        if not markdown.strip():
            return {"status": "skipped", "reason": "empty"}
        if self.is_private(markdown):
            return {"status": "skipped", "reason": "private"}

        token = resolve_hindsight_token()
        if not token:
            return {"status": "unconfigured", "reason": "missing HINDSIGHT_API_KEY"}

        doc_id = self.document_id_for(rel_path)
        now_iso = datetime.now(timezone.utc).isoformat()
        tags = ["source:scribe", f"folder:{self.folder_prefix}"]
        if is_voice:
            tags.append("type:voice_note")

        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "sync_retain",
                "arguments": {
                    "content": markdown,
                    "context": f"Scribe note ({doc_id}): {title}",
                    "timestamp": now_iso,
                    "tags": tags,
                    "document_id": doc_id,
                    "metadata": {
                        "title": title,
                        "doc_name": title,
                        "auteur": "thomas",
                        "type_de_source": "scribe_voice_note" if is_voice else "scribe_note",
                        "folder_path": f"{self.folder_prefix}/{Path(rel_path).parent.as_posix()}".rstrip("/."),
                        "scribe_rel_path": rel_path,
                        "content_hash": self.content_hash(markdown),
                    },
                },
            },
        }
        url = f"{self.api_url}/mcp/{self.bank_id}/"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=self._headers(token),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        return {
            "status": "synced",
            "bank_id": self.bank_id,
            "document_id": doc_id,
            "content_hash": self.content_hash(markdown),
            "synced_at": now_iso,
            "remote": body,
        }

    def list_remote_notes(self, limit: int = 200) -> list[dict[str, Any]]:
        token = resolve_hindsight_token()
        if not token:
            return []
        url = f"{self.api_url}/v1/default/banks/{urllib.parse.quote(self.bank_id)}/documents?limit={limit}"
        req = urllib.request.Request(url, headers=self._headers(token), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return []
        items = data.get("items") or data.get("documents") or (data if isinstance(data, list) else [])
        out: list[dict[str, Any]] = []
        for item in items:
            doc_id = str(item.get("id") or item.get("document_id") or "")
            rel = self.rel_path_from_doc_id(doc_id)
            if rel:
                out.append({"document_id": doc_id, "rel_path": rel, "raw": item})
        return out

    def fetch_remote_markdown(self, doc_id: str) -> Optional[str]:
        token = resolve_hindsight_token()
        if not token:
            return None
        url = f"{self.api_url}/v1/default/banks/{urllib.parse.quote(self.bank_id)}/documents/{urllib.parse.quote(doc_id, safe='')}"
        req = urllib.request.Request(url, headers=self._headers(token), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            return None
        return data.get("original_text") or data.get("content") or data.get("text")

    def pull_notes(self, store: Any) -> dict[str, Any]:
        """Pull newer or missing `scribe/*` notes from Hindsight `thomas` bank into local store."""
        pulled = 0
        for item in self.list_remote_notes():
            rel = item["rel_path"]
            doc_id = item["document_id"]
            remote_md = self.fetch_remote_markdown(doc_id)
            if not remote_md or not remote_md.strip():
                continue
            remote_hash = self.content_hash(remote_md)
            try:
                local = store.read_note(rel)
                local_hash = self.content_hash(local["markdown"])
                if local_hash == remote_hash:
                    continue
                # If local has unsynced edits, keep local unless remote differs from last synced hash
                if not local["synced"]:
                    continue
            except FileNotFoundError:
                pass
            store.write_note(rel, remote_md)
            store.mark_synced(rel, remote_hash, doc_id, datetime.now(timezone.utc).isoformat())
            pulled += 1
        return {"pulled": pulled, "bank": self.bank_id, "folder": self.folder_prefix}
