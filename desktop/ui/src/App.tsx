import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
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

interface Voiceprint {
  id: string;
  name: string;
  embedding_dim: number;
  sample_count: number;
  source: string;
  notes: string;
  created_at: number;
  updated_at: number;
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

function detectSpeakers(md: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\*\*([A-Za-zÀ-ÿ0-9 _-]{2,28})\*\*:/g,
    /\*\*([A-Za-zÀ-ÿ0-9 _-]{2,28}):\*\*/g,
    /^([A-Za-zÀ-ÿ0-9 _-]{2,24}):\s/gm,
    /\[((?:Speaker|Locuteur)\s*\d+)\]/gi,
  ];
  for (const pat of patterns) {
    let m: RegExpExecArray | null;
    while ((m = pat.exec(md)) !== null) {
      const name = m[1].trim();
      if (name && !/^(title|date|recorded_at|sync|tags|http|https)$/i.test(name)) {
        found.add(name);
      }
    }
  }
  return Array.from(found);
}

export function App() {
  const [notes, setNotes] = createSignal<NoteMeta[]>([]);
  const [query, setQuery] = createSignal("");
  const [filterKind, setFilterKind] = createSignal<"all" | "notes" | "recordings">("all");
  const [currentPath, setCurrentPath] = createSignal<string | null>(null);
  const [currentIsVoice, setCurrentIsVoice] = createSignal(false);
  const [markdown, setMarkdown] = createSignal("");
  const [audioPath, setAudioPath] = createSignal<string | null>(null);
  const [syncText, setSyncText] = createSignal("● Hindsight: thomas/scribe");
  const [mode, setMode] = createSignal<"preview" | "edit">("preview");
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");

  // Voiceprints state
  const [vpOpen, setVpOpen] = createSignal(false);
  const [voiceprints, setVoiceprints] = createSignal<Voiceprint[]>([]);
  const [selectedVpIds, setSelectedVpIds] = createSignal<string[]>([]);
  const [newVpName, setNewVpName] = createSignal("");
  const [newVpNotes, setNewVpNotes] = createSignal("");
  const [mergeTargetName, setMergeTargetName] = createSignal("");
  const [editingVpId, setEditingVpId] = createSignal<string | null>(null);
  const [editingVpName, setEditingVpName] = createSignal("");
  const [vpStatus, setVpStatus] = createSignal<string | null>(null);

  // Quick speaker relabel popover for current recording
  const [relabelSource, setRelabelSource] = createSignal<string | null>(null);
  const [relabelTarget, setRelabelTarget] = createSignal("");

  let saveTimer: number | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let editorRef: HTMLTextAreaElement | undefined;

  createEffect(() => {
    document.documentElement.dataset.theme = theme();
  });

  const filteredNotes = createMemo(() => {
    const k = filterKind();
    return notes().filter((n) => {
      if (k === "recordings") return n.is_voice;
      if (k === "notes") return !n.is_voice;
      return true;
    });
  });

  const previewHtml = createMemo(() => renderMarkdownWithKatex(markdown()));
  const detectedSpeakers = createMemo(() => (currentIsVoice() ? detectSpeakers(markdown()) : []));

  function toggleMode() {
    const next = mode() === "preview" ? "edit" : "preview";
    setMode(next);
    if (next === "edit") {
      requestAnimationFrame(() => editorRef?.focus());
    }
  }

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
    setCurrentIsVoice(Boolean(note.is_voice));
    setMarkdown(note.markdown || "");
    setAudioPath(note.audio_rel_path || null);
    setRelabelSource(null);
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
      await openNote(note.rel_path);
      setMode("edit");
      requestAnimationFrame(() => editorRef?.focus());
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
    setCurrentIsVoice(false);
    setMarkdown("");
    setAudioPath(null);
    fetchNotes();
  }

  // ---- Voiceprints API ----
  async function fetchVoiceprints() {
    try {
      const res = await fetch("/api/voiceprints");
      if (!res.ok) return;
      const data = await res.json();
      setVoiceprints(data.voiceprints || []);
    } catch {
      // ignore
    }
  }

  async function addVoiceprint(nameOverride?: string, source = "desktop") {
    const name = (nameOverride ?? newVpName()).trim();
    if (!name) return;
    const res = await fetch("/api/voiceprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, notes: newVpNotes().trim(), source }),
    });
    if (res.ok) {
      if (!nameOverride) {
        setNewVpName("");
        setNewVpNotes("");
      }
      setVpStatus(`Saved voiceprint "${name}"`);
      await fetchVoiceprints();
    }
  }

  async function renameVoiceprint(vpId: string) {
    const name = editingVpName().trim();
    if (!name) return;
    const res = await fetch("/api/voiceprints", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: vpId, name, relabel_notes: true }),
    });
    if (res.ok) {
      const data = await res.json();
      setEditingVpId(null);
      setVpStatus(`Renamed to "${name}" (${data.relabeled_notes || 0} transcripts updated)`);
      await fetchVoiceprints();
      const cur = currentPath();
      if (cur) await openNote(cur);
    }
  }

  async function mergeSelectedVoiceprints() {
    const ids = selectedVpIds();
    const target = mergeTargetName().trim();
    if (ids.length < 2 || !target) return;
    const res = await fetch("/api/voiceprints/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, target_name: target, relabel_notes: true }),
    });
    if (res.ok) {
      const data = await res.json();
      setSelectedVpIds([]);
      setMergeTargetName("");
      setVpStatus(`Merged ${data.merged_count} voiceprints into "${data.name}" (${data.relabeled_notes || 0} transcripts updated)`);
      await fetchVoiceprints();
      const cur = currentPath();
      if (cur) await openNote(cur);
    }
  }

  async function deleteVoiceprint(vpId: string) {
    await fetch(`/api/voiceprints?id=${encodeURIComponent(vpId)}`, { method: "DELETE" });
    setSelectedVpIds((prev) => prev.filter((id) => id !== vpId));
    await fetchVoiceprints();
  }

  function toggleVpSelection(vpId: string) {
    setSelectedVpIds((prev) =>
      prev.includes(vpId) ? prev.filter((id) => id !== vpId) : [...prev, vpId]
    );
  }

  async function applySpeakerLabel(applyAll: boolean) {
    const fromLabel = relabelSource();
    const toLabel = relabelTarget().trim();
    if (!fromLabel || !toLabel) return;
    // Save voiceprint if not already in registry
    if (!voiceprints().some((v) => v.name.toLowerCase() === toLabel.toLowerCase())) {
      await addVoiceprint(toLabel, "recording");
    }
    const res = await fetch("/api/voiceprints/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_label: fromLabel,
        to_label: toLabel,
        rel_path: applyAll ? null : currentPath(),
      }),
    });
    if (res.ok) {
      setRelabelSource(null);
      setRelabelTarget("");
      const cur = currentPath();
      if (cur) await openNote(cur);
      await fetchNotes();
    }
  }

  onMount(() => {
    (window as unknown as Record<string, unknown>).__SCRIBE_SET_THEME__ = (t: "dark" | "light") => setTheme(t);
    (window as unknown as Record<string, unknown>).__SCRIBE_NEW_NOTE__ = createNote;
    (window as unknown as Record<string, unknown>).__SCRIBE_TOGGLE_MODE__ = toggleMode;
    (window as unknown as Record<string, unknown>).__SCRIBE_FOCUS_SEARCH__ = () => searchInputRef?.focus();
    (window as unknown as Record<string, unknown>).__SCRIBE_FILTER__ = (q: string) => {
      setQuery(q);
      fetchNotes(q);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "/") {
        e.preventDefault();
        toggleMode();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef?.focus();
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createNote();
      } else if (e.key === "Escape" && vpOpen()) {
        setVpOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));

    fetchNotes();
    fetchVoiceprints();
  });

  return (
    <div class="scribe-shell">
      <aside class="note-rail">
        <div class="rail-header">
          <span class="rail-title">Scribe</span>
          <div class="rail-actions">
            <button class="icon-btn" onClick={createNote} title="New Note (⌘N)">+</button>
            <button
              class={"icon-btn" + (vpOpen() ? " active" : "")}
              onClick={() => {
                const next = !vpOpen();
                setVpOpen(next);
                if (next) fetchVoiceprints();
              }}
              title="Voiceprints & Speakers"
            >
              🎙
            </button>
            <button class="icon-btn" onClick={triggerSync} title="Two-Way Sync">↻</button>
            <button class="icon-btn" onClick={() => setTheme(theme() === "dark" ? "light" : "dark")} title="Toggle Theme">◐</button>
          </div>
        </div>

        <div class="rail-search">
          <input
            ref={searchInputRef}
            type="search"
            placeholder="Search notes & recordings..."
            value={query()}
            onInput={(e) => {
              const v = e.currentTarget.value;
              setQuery(v);
              fetchNotes(v);
            }}
          />
        </div>

        <div class="rail-filters">
          <button class={"filter-pill" + (filterKind() === "all" ? " active" : "")} onClick={() => setFilterKind("all")}>All</button>
          <button class={"filter-pill" + (filterKind() === "notes" ? " active" : "")} onClick={() => setFilterKind("notes")}>Notes</button>
          <button class={"filter-pill" + (filterKind() === "recordings" ? " active" : "")} onClick={() => setFilterKind("recordings")}>Recordings</button>
        </div>

        <div class="note-list">
          <For each={filteredNotes()}>
            {(n) => (
              <div
                class={"note-item" + (n.rel_path === currentPath() ? " active" : "")}
                onClick={() => openNote(n.rel_path)}
              >
                <div class="note-item-title">{n.title}</div>
                <div class="note-item-preview">{n.preview || "Empty note"}</div>
                <div class="note-item-meta">
                  <Show when={n.is_voice} fallback={<span class="dot-note">Note</span>}>
                    <span class="dot-voice">🎙 Recording</span>
                  </Show>
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
            <button
              class={"mode-btn" + (mode() === "edit" ? " active" : "")}
              onClick={toggleMode}
              title="Toggle rendered preview and editable Markdown (⌘/)"
            >
              {mode() === "preview" ? "Edit" : "Preview"}
              <kbd class="kbd-hint">⌘/</kbd>
            </button>
            <button class="icon-btn danger" onClick={deleteCurrent} title="Delete Note">✕</button>
          </div>
        </header>

        <Show when={currentIsVoice() || audioPath()}>
          <div class="recording-card">
            <div class="recording-top">
              <span class="voice-badge">🎙 Recording & Derived STT</span>
              <button
                class="vp-trigger-btn"
                onClick={() => {
                  fetchVoiceprints();
                  setVpOpen(true);
                }}
              >
                Manage Voiceprints ({voiceprints().length})
              </button>
            </div>
            <Show when={audioPath()}>
              {(ap) => <audio controls src={`/api/audio/${encodeURIComponent(ap())}`} />}
            </Show>
            <Show when={detectedSpeakers().length > 0}>
              <div class="speaker-row">
                <span class="speaker-row-label">Speakers:</span>
                <For each={detectedSpeakers()}>
                  {(spk) => (
                    <button
                      class={"speaker-chip" + (relabelSource() === spk ? " active" : "")}
                      onClick={() => {
                        setRelabelSource(spk);
                        setRelabelTarget(spk);
                      }}
                      title="Click to label or assign voiceprint"
                    >
                      {spk}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={relabelSource()}>
              {(src) => (
                <div class="relabel-bar">
                  <span>Label <strong>{src()}</strong> as:</span>
                  <input
                    type="text"
                    list="vp-suggestions"
                    value={relabelTarget()}
                    onInput={(e) => setRelabelTarget(e.currentTarget.value)}
                    placeholder="Speaker name..."
                  />
                  <datalist id="vp-suggestions">
                    <For each={voiceprints()}>{(vp) => <option value={vp.name} />}</For>
                  </datalist>
                  <button class="icon-btn" onClick={() => applySpeakerLabel(false)}>This recording</button>
                  <button class="icon-btn primary" onClick={() => applySpeakerLabel(true)}>All recordings</button>
                  <button class="icon-btn" onClick={() => setRelabelSource(null)}>Cancel</button>
                </div>
              )}
            </Show>
          </div>
        </Show>

        <section class={`workspace mode-${mode()}`}>
          <textarea
            ref={editorRef}
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

      <Show when={vpOpen()}>
        <div class="vp-backdrop" onClick={() => setVpOpen(false)}>
          <div class="vp-modal" onClick={(e) => e.stopPropagation()}>
            <div class="vp-header">
              <div>
                <div class="vp-title">Voiceprints</div>
                <div class="vp-subtitle">Save, label, and merge speaker voiceprints for automatic labeling</div>
              </div>
              <button class="icon-btn" onClick={() => setVpOpen(false)}>✕</button>
            </div>

            <div class="vp-add-row">
              <input
                type="text"
                placeholder="New speaker name (e.g. Thomas)..."
                value={newVpName()}
                onInput={(e) => setNewVpName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addVoiceprint()}
              />
              <input
                type="text"
                placeholder="Optional note..."
                value={newVpNotes()}
                onInput={(e) => setNewVpNotes(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && addVoiceprint()}
              />
              <button class="icon-btn primary" onClick={() => addVoiceprint()}>Save</button>
            </div>

            <Show when={selectedVpIds().length >= 2}>
              <div class="vp-merge-bar">
                <span>Merge {selectedVpIds().length} selected into:</span>
                <input
                  type="text"
                  placeholder="Target speaker name..."
                  value={mergeTargetName()}
                  onInput={(e) => setMergeTargetName(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === "Enter" && mergeSelectedVoiceprints()}
                />
                <button class="icon-btn primary" onClick={mergeSelectedVoiceprints}>
                  Merge ({selectedVpIds().length})
                </button>
              </div>
            </Show>

            <Show when={vpStatus()}>
              {(msg) => <div class="vp-status">{msg()}</div>}
            </Show>

            <div class="vp-list">
              <Show
                when={voiceprints().length > 0}
                fallback={<div class="vp-empty">No voiceprints saved yet. Add one above or click a speaker in any recording.</div>}
              >
                <For each={voiceprints()}>
                  {(vp) => (
                    <div class="vp-item">
                      <input
                        type="checkbox"
                        checked={selectedVpIds().includes(vp.id)}
                        onChange={() => toggleVpSelection(vp.id)}
                      />
                      <div class="vp-item-info">
                        <Show
                          when={editingVpId() === vp.id}
                          fallback={
                            <div class="vp-item-name">
                              {vp.name}
                              <span class="vp-item-meta">
                                {vp.sample_count} sample{vp.sample_count === 1 ? "" : "s"}
                                {vp.embedding_dim > 0 ? ` · ${vp.embedding_dim}D` : ""}
                                {vp.source ? ` · ${vp.source}` : ""}
                              </span>
                            </div>
                          }
                        >
                          <div class="vp-rename-row">
                            <input
                              type="text"
                              value={editingVpName()}
                              onInput={(e) => setEditingVpName(e.currentTarget.value)}
                              onKeyDown={(e) => e.key === "Enter" && renameVoiceprint(vp.id)}
                            />
                            <button class="icon-btn primary" onClick={() => renameVoiceprint(vp.id)}>Save</button>
                            <button class="icon-btn" onClick={() => setEditingVpId(null)}>Cancel</button>
                          </div>
                        </Show>
                        <Show when={vp.notes}>
                          <div class="vp-item-notes">{vp.notes}</div>
                        </Show>
                      </div>
                      <div class="vp-item-actions">
                        <button
                          class="icon-btn"
                          onClick={() => {
                            setEditingVpId(vp.id);
                            setEditingVpName(vp.name);
                          }}
                        >
                          Label
                        </button>
                        <button class="icon-btn danger" onClick={() => deleteVoiceprint(vp.id)}>✕</button>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
