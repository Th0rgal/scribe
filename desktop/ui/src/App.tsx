import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import mermaid from "mermaid";
import { extractMathSpans } from "./mathParser";
import { renderKatexSafe } from "./katexRender";

mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });

interface CopilotMsg {
  role: "user" | "assistant";
  content: string;
  tools?: string[];
}

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
  html = html.replace(/```mermaid\n([\s\S]*?)```/g, (_, code) => `<div class="mermaid-wrap"><div class="mermaid">${code}</div></div>`);
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
      if (name && !/^(title|date|recorded_at|duration_secs|sync|tags|http|https)$/i.test(name)) {
        found.add(name);
      }
    }
  }
  return Array.from(found);
}

function formatTimer(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [copilotOpen, setCopilotOpen] = createSignal(false);
  const [copilotMsgs, setCopilotMsgs] = createSignal<CopilotMsg[]>([]);
  const [copilotInput, setCopilotInput] = createSignal("");
  const [copilotBusy, setCopilotBusy] = createSignal(false);
  const [theme, setTheme] = createSignal<"dark" | "light">("dark");

  // Desktop voice recorder (Mic + System Audio / Google Meet)
  const [recMic, setRecMic] = createSignal(true);
  const [recSys, setRecSys] = createSignal(true);
  const [isRecording, setIsRecording] = createSignal(false);
  const [isTranscribing, setIsTranscribing] = createSignal(false);
  const [recElapsed, setRecElapsed] = createSignal(0);

  // Connected USB phone live stream + remote control
  const [phoneConnected, setPhoneConnected] = createSignal(false);
  const [phoneRecording, setPhoneRecording] = createSignal(false);
  const [phonePaused, setPhonePaused] = createSignal(false);
  const [phoneStatus, setPhoneStatus] = createSignal("");
  const [phoneMarkdown, setPhoneMarkdown] = createSignal("");
  const [viewingPhoneLive, setViewingPhoneLive] = createSignal(false);

  // Quick speaker relabel for current recording
  const [relabelSource, setRelabelSource] = createSignal<string | null>(null);
  const [relabelTarget, setRelabelTarget] = createSignal("");

  let saveTimer: number | undefined;
  let recTimer: number | undefined;
  let searchInputRef: HTMLInputElement | undefined;
  let editorRef: HTMLTextAreaElement | undefined;
  let copilotInputRef: HTMLInputElement | undefined;

  createEffect(() => {
    const t = theme();
    document.documentElement.dataset.theme = t;
    mermaid.initialize({ startOnLoad: false, theme: t === "dark" ? "dark" : "default", securityLevel: "strict" });
  });

  function renderMermaidDiagrams() {
    requestAnimationFrame(() => {
      const nodes = document.querySelectorAll<HTMLElement>(".mermaid:not([data-processed])");
      if (nodes.length > 0) {
        mermaid.run({ nodes }).catch(() => {});
      }
    });
  }

  createEffect(() => {
    previewHtml();
    copilotMsgs();
    mode();
    renderMermaidDiagrams();
  });

  const filteredNotes = createMemo(() => {
    const k = filterKind();
    return notes().filter((n) => {
      if (k === "recordings") return n.is_voice;
      if (k === "notes") return !n.is_voice;
      return true;
    });
  });

  const previewHtml = createMemo(() =>
    renderMarkdownWithKatex(viewingPhoneLive() ? phoneMarkdown() : markdown())
  );
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

  async function pollPhoneLive() {
    try {
      const res = await fetch("/api/phone/live");
      if (!res.ok) return;
      const d = await res.json();
      if (!d.connected) {
        setPhoneConnected(false);
        return;
      }
      const wasRec = phoneRecording();
      setPhoneConnected(true);
      setPhoneRecording(Boolean(d.recording));
      setPhonePaused(Boolean(d.paused));
      setPhoneStatus(d.status || (d.recording ? "Recording on phone" : "Phone ready"));
      const lines: string[] = [
        `# 📱 Phone Live (${d.paused ? "Paused" : d.recording ? "Recording" : "Ready"})`,
        "",
      ];
      for (const seg of d.segments || []) {
        lines.push(`**${seg.speaker}**: ${seg.text}`);
        if (seg.translated) lines.push(`*→ ${seg.translated}*`);
        lines.push("");
      }
      if (d.partial) {
        lines.push(`*… ${d.partial}*`);
        if (d.partial_translation) lines.push(`*→ ${d.partial_translation}*`);
      }
      setPhoneMarkdown(lines.join("\n"));
      if (d.recording && !wasRec) {
        setViewingPhoneLive(true);
        setMode("preview");
      }
    } catch {
      setPhoneConnected(false);
    }
  }

  async function sendPhoneControl(action: "start" | "pause" | "resume" | "stop") {
    await fetch("/api/phone/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (action === "start") {
      setViewingPhoneLive(true);
      setMode("preview");
    }
    setTimeout(pollPhoneLive, 350);
  }

  async function openNote(relPath: string) {
    setViewingPhoneLive(false);
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
    setSyncText("↻ Syncing thomas/scribe...");
    const res = await fetch("/api/sync", { method: "POST", body: "{}" });
    if (res.ok) {
      const d = await res.json();
      setSyncText(`● ${d.bank}/${d.folder} (↑${d.synced} ↓${d.pulled ?? 0})`);
      fetchNotes();
    }
  }

  async function deleteNoteByPath(relPath: string) {
    await fetch(`/api/note?path=${encodeURIComponent(relPath)}`, { method: "DELETE" });
    if (currentPath() === relPath) {
      setCurrentPath(null);
      setCurrentIsVoice(false);
      setMarkdown("");
      setAudioPath(null);
    }
    await fetchNotes();
  }

  async function toggleRecording() {
    if (isTranscribing()) return;
    if (!isRecording()) {
      if (!recMic() && !recSys()) return;
      const res = await fetch("/api/record/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mic: recMic(), system_audio: recSys() }),
      });
      if (res.ok) {
        setIsRecording(true);
        setRecElapsed(0);
        clearInterval(recTimer);
        recTimer = window.setInterval(() => setRecElapsed((s) => s + 1), 1000);
      }
    } else {
      clearInterval(recTimer);
      setIsRecording(false);
      setIsTranscribing(true);
      setSyncText("↻ Transcribing & diarizing...");
      try {
        const res = await fetch("/api/record/stop", { method: "POST", body: "{}" });
        if (res.ok) {
          const note = await res.json();
          await fetchNotes();
          await openNote(note.rel_path);
          setMode("preview");
          setSyncText("● Recording saved & synced");
        }
      } finally {
        setIsTranscribing(false);
      }
    }
  }

  async function sendCopilot() {
    const q = copilotInput().trim();
    if (!q || copilotBusy()) return;
    const nextMsgs: CopilotMsg[] = [...copilotMsgs(), { role: "user", content: q }];
    setCopilotMsgs(nextMsgs);
    setCopilotInput("");
    setCopilotBusy(true);
    try {
      const res = await fetch("/api/copilot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMsgs.map((m) => ({ role: m.role, content: m.content })),
          current_path: viewingPhoneLive() ? null : currentPath(),
        }),
      });
      const data = await res.json();
      setCopilotMsgs([
        ...nextMsgs,
        { role: "assistant", content: data.reply || "Done.", tools: data.tool_calls || [] },
      ]);
      if (data.created_path) {
        await fetchNotes();
        await openNote(data.created_path);
      } else if (data.updated_path) {
        await fetchNotes();
        await openNote(data.updated_path);
      }
    } catch (e) {
      setCopilotMsgs([...nextMsgs, { role: "assistant", content: `Error: ${e}` }]);
    } finally {
      setCopilotBusy(false);
    }
  }

  function toggleCopilot() {
    const next = !copilotOpen();
    setCopilotOpen(next);
    if (next) requestAnimationFrame(() => copilotInputRef?.focus());
  }

  async function applySpeakerLabel() {
    const fromLabel = relabelSource();
    const toLabel = relabelTarget().trim();
    if (!fromLabel || !toLabel) return;
    const res = await fetch("/api/voiceprints/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_label: fromLabel,
        to_label: toLabel,
        rel_path: currentPath(),
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
    (window as unknown as Record<string, unknown>).__SCRIBE_TOGGLE_SIDEBAR__ = () => setSidebarOpen((v) => !v);
    (window as unknown as Record<string, unknown>).__SCRIBE_TOGGLE_COPILOT__ = toggleCopilot;
    (window as unknown as Record<string, unknown>).__SCRIBE_FOCUS_SEARCH__ = () => {
      setSidebarOpen(true);
      requestAnimationFrame(() => searchInputRef?.focus());
    };
    (window as unknown as Record<string, unknown>).__SCRIBE_FILTER__ = (q: string) => {
      setQuery(q);
      fetchNotes(q);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "/") {
        e.preventDefault();
        toggleMode();
      } else if (mod && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "j") {
        e.preventDefault();
        toggleCopilot();
      } else if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSidebarOpen(true);
        requestAnimationFrame(() => searchInputRef?.focus());
      } else if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createNote();
      }
    };
    const phoneTimer = window.setInterval(pollPhoneLive, 1000);
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      window.removeEventListener("keydown", onKeyDown);
      clearInterval(recTimer);
      clearInterval(phoneTimer);
    });

    fetchNotes();
    pollPhoneLive();
  });

  return (
    <div class="scribe-shell">
      <Show when={sidebarOpen()}>
      <aside class="note-rail">
        <div class="rail-header">
          <span class="rail-title">Scribe</span>
          <div class="rail-actions">
            <button class="icon-btn" onClick={createNote} title="New Note (⌘N)">+</button>
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
          <Show when={phoneConnected()}>
            <div
              class={"note-item" + (viewingPhoneLive() ? " active" : "")}
              onClick={() => {
                setViewingPhoneLive(true);
                setMode("preview");
              }}
            >
              <div class="note-item-title">
                📱 Phone Live {phoneRecording() ? (phonePaused() ? "· Paused" : "· ● Live") : "· Connected"}
              </div>
              <div class="note-item-preview">{phoneStatus()}</div>
              <div class="rec-toggles" style="margin-top: 6px;" onClick={(e) => e.stopPropagation()}>
                <Show
                  when={phoneRecording()}
                  fallback={
                    <button class="rec-toggle on" onClick={() => sendPhoneControl("start")}>● Start</button>
                  }
                >
                  <button
                    class="rec-toggle on"
                    onClick={() => sendPhoneControl(phonePaused() ? "resume" : "pause")}
                  >
                    {phonePaused() ? "▶ Resume" : "❚❚ Pause"}
                  </button>
                  <button class="rec-toggle" onClick={() => sendPhoneControl("stop")}>■ Stop</button>
                </Show>
              </div>
            </div>
          </Show>
          <For each={filteredNotes()}>
            {(n) => (
              <div
                class={"note-item" + (n.rel_path === currentPath() ? " active" : "")}
                onClick={() => openNote(n.rel_path)}
              >
                <button
                  class="note-del-btn"
                  title="Delete note"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteNoteByPath(n.rel_path);
                  }}
                >
                  ✕
                </button>
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

        <div class="rec-bar">
          <div class="rec-toggles">
            <button
              class={"rec-toggle" + (recMic() ? " on" : "")}
              disabled={isRecording()}
              onClick={() => setRecMic(!recMic())}
              title="Toggle microphone capture"
            >
              {recMic() ? "🎙 Mic: On" : "🎙 Mic: Off"}
            </button>
            <button
              class={"rec-toggle" + (recSys() ? " on" : "")}
              disabled={isRecording()}
              onClick={() => setRecSys(!recSys())}
              title="Toggle PC / Google Meet audio capture"
            >
              {recSys() ? "🔊 PC Audio: On" : "🔊 PC Audio: Off"}
            </button>
          </div>
          <button
            class={"rec-btn" + (isRecording() ? " recording" : "")}
            disabled={isTranscribing() || (!recMic() && !recSys())}
            onClick={toggleRecording}
          >
            {isTranscribing()
              ? "↻ Diarizing..."
              : isRecording()
                ? `■ Stop (${formatTimer(recElapsed())})`
                : "● Record Audio"}
          </button>
        </div>

        <div class="sync-footer">{syncText()}</div>
      </aside>
      </Show>

      <main class="canvas">
        <header class="canvas-bar">
          <span class="note-path">{currentPath() || "No note selected"}</span>
          <div class="mode-tabs">
            <button
              class={"mode-btn" + (copilotOpen() ? " active" : "")}
              onClick={toggleCopilot}
              title="Toggle Scribe Copilot (⌘J)"
            >
              Copilot
              <kbd class="kbd-hint">⌘J</kbd>
            </button>
            <button
              class={"mode-btn" + (mode() === "edit" ? " active" : "")}
              onClick={toggleMode}
              title="Toggle rendered preview and editable Markdown (⌘/)"
            >
              {mode() === "preview" ? "Edit" : "Preview"}
              <kbd class="kbd-hint">⌘/</kbd>
            </button>
            <Show when={currentPath()}>
              {(p) => (
                <button class="icon-btn danger" onClick={() => deleteNoteByPath(p())} title="Delete Note">
                  Delete
                </button>
              )}
            </Show>
          </div>
        </header>

        <Show when={currentIsVoice() || audioPath()}>
          <div class="recording-card">
            <div class="recording-top">
              <span class="voice-badge">🎙 Recording & Derived STT</span>
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
                      title="Click to rename speaker in this recording"
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
                  <span>Rename <strong>{src()}</strong> to:</span>
                  <input
                    type="text"
                    value={relabelTarget()}
                    onInput={(e) => setRelabelTarget(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && applySpeakerLabel()}
                    placeholder="Speaker name..."
                  />
                  <button class="icon-btn primary" onClick={applySpeakerLabel}>Apply</button>
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

      <Show when={copilotOpen()}>
        <aside class="copilot-pane">
          <div class="copilot-header">
            <span>Scribe Copilot · builtin/assistant</span>
            <button class="icon-btn" onClick={() => setCopilotOpen(false)}>✕</button>
          </div>
          <div class="copilot-messages">
            <Show when={copilotMsgs().length === 0}>
              <div class="vp-empty">
                Ask about this note, your live phone class, Hindsight memory, or ask to edit / create notes with Mermaid diagrams.
              </div>
            </Show>
            <For each={copilotMsgs()}>
              {(m) => (
                <div class={`copilot-msg ${m.role}`}>
                  <Show when={m.tools && m.tools.length > 0}>
                    <div class="copilot-tools">
                      <For each={m.tools}>{(t) => <span class="copilot-tool-chip">{t}</span>}</For>
                    </div>
                  </Show>
                  <div innerHTML={renderMarkdownWithKatex(m.content)} />
                </div>
              )}
            </For>
          </div>
          <div class="copilot-input-row">
            <input
              ref={copilotInputRef}
              type="text"
              placeholder="Ask or edit this note..."
              value={copilotInput()}
              onInput={(e) => setCopilotInput(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && sendCopilot()}
            />
            <button class="icon-btn primary" disabled={copilotBusy()} onClick={sendCopilot}>
              {copilotBusy() ? "…" : "Send"}
            </button>
          </div>
        </aside>
      </Show>
    </div>
  );
}
