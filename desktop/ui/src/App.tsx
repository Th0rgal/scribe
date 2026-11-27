import { For, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { extractMathSpans } from "./mathParser";
import { renderKatexSafe } from "./katexRender";

interface NoteMeta {
  rel_path: string;
  title: string;
  preview: string;
  updated_at: number;
  is_voice: boolean;
  audio_rel_path: string | null;
  synced: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdownWithKatex(md: string): string {
  const spans = extractMathSpans(md);
  let out = "";
  let cursor = 0;
  for (const sp of spans) {
    out += formatPlainMarkdown(md.slice(cursor, sp.rawStart));
    const rendered = renderKatexSafe(sp.tex, sp.display);
    out += sp.display
      ? `<div class="katex-display-wrap">${rendered.html}</div>`
      : `<span class="katex-inline-wrap">${rendered.html}</span>`;
    cursor = sp.rawEnd;
  }
  out += formatPlainMarkdown(md.slice(cursor));
  return out;
}

function formatPlainMarkdown(chunk: string): string {
  let html = escapeHtml(chunk);
  html = html.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(/^- \[x\] (.+)$/gm, "<div>☑ $1</div>");
  html = html.replace(/^- \[ \] (.+)$/gm, "<div>☐ $1</div>");
  html = html.replace(/^- (.+)$/gm, "<div>• $1</div>");
  html = html.replace(/\n\n+/g, "<br/><br/>").replace(/\n/g, "<br/>");
  return html;
}

export function App() {
  const [notes, setNotes] = createSignal<NoteMeta[]>([]);
  const [query, setQuery] = createSignal("");
  const [currentPath, setCurrentPath] = createSignal<string | null>(null);
  const [markdown, setMarkdown] = createSignal("");
  const [audioPath, setAudioPath] = createSignal<string | null>(null);
  const [syncText, setSyncText] = createSignal("● Hindsight: thomas/scribe");
  const [mode, setMode] = createSignal<"split" | "edit" | "preview">("split");
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");

  let saveTimer: number | undefined;

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  const previewHtml = createMemo(() => renderMarkdownWithKatex(markdown()));

  async function fetchNotes(q = query()) {
    try {
      const res = await fetch(`/api/notes?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const data = await res.json();
      const list: NoteMeta[] = data.notes || [];
      setNotes(list);
      if (!currentPath() && list.length > 0) {
        openNote(list[0].rel_path);
      }
    } catch {
      // offline
    }
  }

  async function openNote(relPath: string) {
    const res = await fetch(`/api/note?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) return;
    const note = await res.json();
    setCurrentPath(note.rel_path);
    setMarkdown(note.markdown || "");
    setAudioPath(note.audio_rel_path || null);
  }

  async function saveCurrent(md: string) {
    const p = currentPath();
    if (!p) return;
    setSyncText("○ Syncing to thomas/scribe...");
    const res = await fetch("/api/note", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rel_path: p, markdown: md }),
    });
    if (res.ok) {
      setSyncText("● Synced to thomas/scribe");
      fetchNotes();
    }
  }

  async function createNote() {
    const res = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled Note" }),
    });
    if (res.ok) {
      const note = await res.json();
      await fetchNotes();
      openNote(note.rel_path);
    }
  }

  async function triggerSync() {
    setSyncText("↻ Two-way syncing thomas/scribe...");
    const res = await fetch("/api/sync", { method: "POST", body: "{}" });
    if (res.ok) {
      const d = await res.json();
      setSyncText(`● ${d.bank}/${d.folder} (↑${d.synced} ↓${d.pulled ?? 0})`);
      fetchNotes();
    }
  }

  async function deleteCurrent() {
    const p = currentPath();
    if (!p) return;
    await fetch(`/api/note?path=${encodeURIComponent(p)}`, { method: "DELETE" });
    setCurrentPath(null);
    setMarkdown("");
    setAudioPath(null);
    fetchNotes();
  }

  onMount(() => {
    (window as unknown as Record<string, unknown>).__SCRIBE_SET_THEME__ = (t: "dark" | "light") => setTheme(t);
    (window as unknown as Record<string, unknown>).__SCRIBE_NEW_NOTE__ = createNote;
    (window as unknown as Record<string, unknown>).__SCRIBE_FILTER__ = (q: string) => {
      setQuery(q);
      fetchNotes(q);
    };
    fetchNotes();
  });

  return (
    <div class="scribe-shell">
      <aside class="note-rail">
        <div class="rail-header">
          <span class="rail-title">Notes</span>
          <div class="rail-actions">
            <button class="icon-btn" onClick={createNote} title="New Note">+</button>
            <button class="icon-btn" onClick={triggerSync} title="Two-Way Sync">↻</button>
            <button class="icon-btn" onClick={() => setTheme(theme() === "dark" ? "light" : "dark")} title="Toggle Theme">◐</button>
          </div>
        </div>
        <div class="rail-search">
          <input
            type="search"
            placeholder="Search notes..."
            value={query()}
            onInput={(e) => {
              const v = e.currentTarget.value;
              setQuery(v);
              fetchNotes(v);
            }}
          />
        </div>
        <div class="note-list">
          <For each={notes()}>
            {(n) => (
              <div
                class={"note-item" + (n.rel_path === currentPath() ? " active" : "")}
                onClick={() => openNote(n.rel_path)}
              >
                <div class="note-item-title">{n.title}</div>
                <div class="note-item-preview">{n.preview || "Empty note"}</div>
                <div class="note-item-meta">
                  <Show when={n.is_voice}><span class="dot-voice">🎙 voice</span></Show>
                  <span class={n.synced ? "dot-synced" : ""}>{n.synced ? "● synced" : "○ local"}</span>
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="sync-footer">{syncText()}</div>
      </aside>

      <main class="canvas">
        <header class="canvas-bar">
          <span class="note-path">{currentPath() || "No note selected"}</span>
          <div class="mode-tabs">
            <button class={"mode-btn" + (mode() === "split" ? " active" : "")} onClick={() => setMode("split")}>Split</button>
            <button class={"mode-btn" + (mode() === "edit" ? " active" : "")} onClick={() => setMode("edit")}>Edit</button>
            <button class={"mode-btn" + (mode() === "preview" ? " active" : "")} onClick={() => setMode("preview")}>Preview</button>
            <button class="icon-btn danger" onClick={deleteCurrent} title="Delete Note">✕</button>
          </div>
        </header>

        <Show when={audioPath()}>
          {(ap) => (
            <div class="voice-bar">
              <span class="voice-badge">🎙 Voice Note</span>
              <audio controls src={`/api/audio/${encodeURIComponent(ap())}`} />
            </div>
          )}
        </Show>

        <section class={`workspace mode-${mode()}`}>
          <textarea
            class="editor"
            value={markdown()}
            placeholder="Write in Markdown & LaTeX ($E = mc^2$)..."
            onInput={(e) => {
              const v = e.currentTarget.value;
              setMarkdown(v);
              clearTimeout(saveTimer);
              saveTimer = window.setTimeout(() => saveCurrent(v), 450);
            }}
          />
          <article class="preview" innerHTML={previewHtml()} />
        </section>
      </main>
    </div>
  );
}
