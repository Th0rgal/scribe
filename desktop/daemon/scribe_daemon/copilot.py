"""Scribe Copilot — OrbRouter `builtin/assistant` with built-in Scribe MCP tools (notes, Hindsight, USB phone live)."""
from __future__ import annotations

import json
import os
import urllib.request
from pathlib import Path
from typing import Any, Optional

from .hindsight_sync import HindsightNoteSyncer, resolve_hindsight_token
from .store import NoteStore

ORBROUTER_URL = os.environ.get("ORBROUTER_URL", "https://orbrouter.thomas.md/v1").rstrip("/")
COPILOT_MODEL = os.environ.get("SCRIBE_COPILOT_MODEL", "builtin/assistant")
_last_edit_snapshot: Optional[tuple[str, str]] = None


def undo_last_copilot_edit(store: NoteStore) -> dict[str, Any]:
    global _last_edit_snapshot
    if not _last_edit_snapshot:
        return {"ok": False, "error": "No Copilot edit to undo"}
    rel_path, prev_md = _last_edit_snapshot
    _last_edit_snapshot = None
    store.write_note(rel_path, prev_md)
    return {"ok": True, "rel_path": rel_path}


def resolve_orbrouter_key() -> Optional[str]:
    for k in ("ORBROUTER_API_KEY", "ORB_ROUTER_API_KEY", "OPENAI_API_KEY"):
        v = os.environ.get(k, "").strip()
        if v:
            return v
    for fk in ("ORBROUTER_API_KEY_FILE", "ORB_ROUTER_API_KEY_FILE"):
        p = os.environ.get(fk, "").strip()
        if p and Path(p).is_file():
            tok = Path(p).read_text(encoding="utf-8").strip()
            if tok:
                return tok
    return None


TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "note_read_current",
            "description": "Read the currently open note's path and full Markdown content.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_edit_current",
            "description": "Replace an exact substring in the currently open note with new Markdown.",
            "parameters": {
                "type": "object",
                "properties": {
                    "search": {"type": "string", "description": "Exact text to find in the current note."},
                    "replace": {"type": "string", "description": "Replacement Markdown text."},
                },
                "required": ["search", "replace"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_replace_current",
            "description": "Replace the entire Markdown content of the currently open note.",
            "parameters": {
                "type": "object",
                "properties": {
                    "markdown": {"type": "string", "description": "Full updated Markdown content."},
                },
                "required": ["markdown"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_create",
            "description": "Create a new Markdown note (can include LaTeX and ```mermaid diagrams).",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Note title."},
                    "markdown": {"type": "string", "description": "Full Markdown body."},
                },
                "required": ["title", "markdown"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "note_search",
            "description": "Search local Scribe notes by keyword.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "hindsight_recall",
            "description": "Query Thomas's Hindsight memory bank for relevant past notes, classes, or context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Semantic recall query."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "phone_live_read",
            "description": "Read the real-time live transcript currently streaming from Thomas's USB-connected phone.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


def _hindsight_recall(syncer: HindsightNoteSyncer, query: str) -> str:
    token = resolve_hindsight_token()
    if not token:
        return "Hindsight token not configured."
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "recall",
            "arguments": {"query": query, "max_tokens": 1200},
        },
    }
    req = urllib.request.Request(
        f"{syncer.api_url}/mcp/{syncer.bank_id}/",
        data=json.dumps(payload).encode("utf-8"),
        headers=syncer._headers(token),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            parsed = syncer._parse_mcp_response(resp.read().decode("utf-8"))
        return json.dumps(parsed, ensure_ascii=False)[:4000]
    except Exception as exc:
        return f"Hindsight recall error: {exc}"


def _phone_live_read() -> str:
    try:
        with urllib.request.urlopen("http://127.0.0.1:47922/api/live.txt", timeout=1.5) as r:
            return r.read().decode("utf-8")[:6000]
    except Exception:
        return "No phone live stream connected on 127.0.0.1:47922."


def run_copilot_chat(
    store: NoteStore,
    syncer: HindsightNoteSyncer,
    messages: list[dict[str, Any]],
    current_path: Optional[str] = None,
) -> dict[str, Any]:
    global _last_edit_snapshot
    api_key = resolve_orbrouter_key()
    if not api_key:
        return {
            "reply": "Copilot requires `ORBROUTER_API_KEY` (or `ORBROUTER_API_KEY_FILE`) to call `builtin/assistant`.",
            "tool_calls": [],
            "updated_path": None,
            "created_path": None,
        }

    system_prompt = (
        "You are Scribe Copilot, Thomas's concise, high-signal note & live-class assistant. "
        "You have tools to read/edit/create local Scribe Markdown notes, recall from Hindsight, "
        "and read the live USB phone transcript. "
        "When diagrams help explain a concept, use clean ```mermaid fenced blocks (flowchart TD/LR, sequenceDiagram, etc.). "
        "When asked to edit or create a note, call the appropriate tool directly."
    )
    convo: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    for m in messages[-12:]:
        role = m.get("role")
        content = m.get("content")
        if role in ("user", "assistant") and isinstance(content, str):
            convo.append({"role": role, "content": content})

    executed_tools: list[str] = []
    updated_path: Optional[str] = None
    created_path: Optional[str] = None

    for _ in range(6):
        req_body = {
            "model": COPILOT_MODEL,
            "messages": convo,
            "tools": TOOL_SCHEMAS,
            "tool_choice": "auto",
            "temperature": 0.3,
        }
        req = urllib.request.Request(
            f"{ORBROUTER_URL}/chat/completions",
            data=json.dumps(req_body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "Scribe/0.2.0",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        tool_calls = msg.get("tool_calls") or []
        if not tool_calls:
            return {
                "reply": (msg.get("content") or "").strip(),
                "tool_calls": executed_tools,
                "updated_path": updated_path,
                "created_path": created_path,
            }

        convo.append(msg)
        for tc in tool_calls:
            fn = tc.get("function") or {}
            name = fn.get("name", "")
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except Exception:
                args = {}
            executed_tools.append(name)

            if name == "note_read_current":
                if current_path:
                    try:
                        n = store.read_note(current_path)
                        result = f"Path: {n['rel_path']}\n\n{n['markdown']}"
                    except Exception as exc:
                        result = f"Error reading current note: {exc}"
                else:
                    result = "No note is currently open."
            elif name == "note_edit_current":
                if not current_path:
                    result = "No note is currently open."
                else:
                    try:
                        n = store.read_note(current_path)
                        src = str(args.get("search") or "")
                        dst = str(args.get("replace") or "")
                        if src and src in n["markdown"]:
                            _last_edit_snapshot = (current_path, n["markdown"])
                            new_md = n["markdown"].replace(src, dst, 1)
                            store.write_note(current_path, new_md)
                            updated_path = current_path
                            result = f"Updated {current_path}."
                        else:
                            result = "Search substring not found in current note."
                    except Exception as exc:
                        result = f"Error editing note: {exc}"
            elif name == "note_replace_current":
                if not current_path:
                    result = "No note is currently open."
                else:
                    try:
                        prev = store.read_note(current_path)["markdown"]
                        _last_edit_snapshot = (current_path, prev)
                        store.write_note(current_path, str(args.get("markdown") or ""))
                        updated_path = current_path
                        result = f"Replaced content of {current_path}."
                    except Exception as exc:
                        result = f"Error replacing note: {exc}"
            elif name == "note_create":
                try:
                    title = str(args.get("title") or "Untitled Note")
                    md = str(args.get("markdown") or f"# {title}\n\n")
                    note = store.create_note(title)
                    store.write_note(note["rel_path"], md)
                    created_path = note["rel_path"]
                    current_path = created_path
                    result = f"Created note {created_path}."
                except Exception as exc:
                    result = f"Error creating note: {exc}"
            elif name == "note_search":
                q = str(args.get("query") or "")
                hits = store.list_notes(q)[:8]
                result = json.dumps(
                    [{"rel_path": h["rel_path"], "title": h["title"], "preview": h["preview"]} for h in hits],
                    ensure_ascii=False,
                )
            elif name == "hindsight_recall":
                result = _hindsight_recall(syncer, str(args.get("query") or ""))
            elif name == "phone_live_read":
                result = _phone_live_read()
            else:
                result = f"Unknown tool: {name}"

            convo.append(
                {
                    "role": "tool",
                    "tool_call_id": tc.get("id", ""),
                    "content": result,
                }
            )

    return {
        "reply": "Done.",
        "tool_calls": executed_tools,
        "updated_path": updated_path,
        "created_path": created_path,
    }
