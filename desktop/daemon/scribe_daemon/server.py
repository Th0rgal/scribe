"""Hardened loopback HTTP server for Scribe Desktop."""
from __future__ import annotations

import json
import mimetypes
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .hindsight_sync import HindsightNoteSyncer
from .store import NoteStore


def make_handler(store: NoteStore, syncer: HindsightNoteSyncer, ui_dir: Path):
    def _bg_sync(rel_path: str, title: str, markdown: str, is_voice: bool) -> None:
        try:
            res = syncer.sync_note(rel_path, title, markdown, is_voice=is_voice)
            if res.get("status") == "synced":
                store.mark_synced(rel_path, res["content_hash"], res["document_id"], res["synced_at"])
        except Exception:
            pass

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:  # noqa: A002
            return

        def _send_json(self, data: dict | list, status: int = 200) -> None:
            raw = json.dumps(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _read_json(self) -> dict:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            return json.loads(raw.decode("utf-8"))

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)

            if path == "/api/health":
                self._send_json({"ok": True, "bank": syncer.bank_id, "folder": syncer.folder_prefix})
                return
            if path == "/api/notes":
                q = (qs.get("q") or [""])[0]
                self._send_json({"notes": store.list_notes(q)})
                return
            if path == "/api/note":
                rel = (qs.get("path") or [""])[0]
                try:
                    self._send_json(store.read_note(rel))
                except FileNotFoundError:
                    self._send_json({"error": "not found"}, 404)
                return
            if path.startswith("/api/audio/"):
                rel = unquote(path[len("/api/audio/"):])
                target = (store.notes_dir / rel).resolve()
                if not str(target).startswith(str(store.notes_dir)) or not target.is_file():
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                mime, _ = mimetypes.guess_type(str(target))
                data = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", mime or "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return

            # Static UI bundle
            rel_ui = "index.html" if path in ("", "/") else path.lstrip("/")
            asset = (ui_dir / rel_ui).resolve()
            if not str(asset).startswith(str(ui_dir.resolve())) or not asset.is_file():
                asset = ui_dir / "index.html"
            if not asset.is_file():
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            mime, _ = mimetypes.guess_type(str(asset))
            data = asset.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            body = self._read_json()

            if parsed.path == "/api/notes":
                note = store.create_note(body.get("title") or "Untitled Note")
                threading.Thread(
                    target=_bg_sync,
                    args=(note["rel_path"], note["title"], note["markdown"], note["is_voice"]),
                    daemon=True,
                ).start()
                self._send_json(note, 201)
                return

            if parsed.path == "/api/note":
                rel = body.get("rel_path", "")
                md = body.get("markdown", "")
                note = store.write_note(rel, md)
                threading.Thread(
                    target=_bg_sync,
                    args=(note["rel_path"], note["title"], note["markdown"], note["is_voice"]),
                    daemon=True,
                ).start()
                self._send_json(note)
                return

            if parsed.path == "/api/sync":
                pull_res = syncer.pull_notes(store)
                pushed = 0
                for meta in store.list_notes():
                    if not meta["synced"]:
                        note = store.read_note(meta["rel_path"])
                        res = syncer.sync_note(note["rel_path"], note["title"], note["markdown"], note["is_voice"])
                        if res.get("status") == "synced":
                            store.mark_synced(note["rel_path"], res["content_hash"], res["document_id"], res["synced_at"])
                            pushed += 1
                self._send_json({
                    "synced": pushed,
                    "pulled": pull_res["pulled"],
                    "bank": syncer.bank_id,
                    "folder": syncer.folder_prefix,
                })
                return

            self.send_error(HTTPStatus.NOT_FOUND)

        def do_DELETE(self) -> None:
            parsed = urlparse(self.path)
            qs = parse_qs(parsed.query)
            if parsed.path == "/api/note":
                rel = (qs.get("path") or [""])[0]
                store.delete_note(rel)
                self._send_json({"deleted": rel})
                return
            self.send_error(HTTPStatus.NOT_FOUND)

    return Handler


def run_server(port: int = 47921) -> None:
    notes_dir = Path(os.environ.get("SCRIBE_DEFAULT_NOTES_DIR") or Path.home() / "Notes")
    state_db = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local/state") / "scribe/scribe.db"
    ui_dir = Path(os.environ.get("SCRIBE_UI_DIST") or Path(__file__).resolve().parents[2] / "ui/dist")
    store = NoteStore(notes_dir, state_db)
    syncer = HindsightNoteSyncer()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store, syncer, ui_dir))
    httpd.serve_forever()
