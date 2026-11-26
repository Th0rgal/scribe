let notes = [];
let currentPath = null;
let saveTimer = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderMarkdown(md) {
  let html = escapeHtml(md || "");
  // Display LaTeX $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => `<div class="math-block">${tex.trim()}</div>`);
  // Inline LaTeX $...$
  html = html.replace(/\$([^$\n]+?)\$/g, (_, tex) => `<span class="math-inline">${tex.trim()}</span>`);
  // Code blocks
  html = html.replace(/```[\w-]*\n([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Headings
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // Bold & italic
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  // Checkboxes & lists
  html = html.replace(/^- \[x\] (.+)$/gm, "<div>☑ $1</div>");
  html = html.replace(/^- \[ \] (.+)$/gm, "<div>☐ $1</div>");
  html = html.replace(/^- (.+)$/gm, "<div>• $1</div>");
  // Line breaks
  html = html.replace(/\n\n+/g, "<br/><br/>").replace(/\n/g, "<br/>");
  return html;
}

async function fetchNotes(query = "") {
  const res = await fetch(`/api/notes?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  notes = data.notes || [];
  renderList();
  if (!currentPath && notes.length > 0) {
    openNote(notes[0].rel_path);
  }
}

function renderList() {
  const list = $("note-list");
  list.innerHTML = "";
  for (const n of notes) {
    const el = document.createElement("div");
    el.className = "note-item" + (n.rel_path === currentPath ? " active" : "");
    el.innerHTML = `
      <div class="note-item-title">${escapeHtml(n.title)}</div>
      <div class="note-item-preview">${escapeHtml(n.preview || "Empty note")}</div>
      <div class="note-item-meta">
        ${n.is_voice ? '<span class="dot-voice">🎙 voice</span>' : ""}
        ${n.synced ? '<span class="dot-synced">● synced</span>' : '<span>○ local</span>'}
      </div>
    `;
    el.onclick = () => openNote(n.rel_path);
    list.appendChild(el);
  }
}

async function openNote(relPath) {
  const res = await fetch(`/api/note?path=${encodeURIComponent(relPath)}`);
  if (!res.ok) return;
  const note = await res.json();
  currentPath = note.rel_path;
  $("note-path").textContent = note.rel_path;
  $("sync-pill").textContent = note.synced ? "● Synced to thomas/scribe" : "○ Saving...";
  $("editor").value = note.markdown || "";
  $("preview").innerHTML = renderMarkdown(note.markdown || "");

  const voiceBar = $("voice-bar");
  const audio = $("voice-audio");
  if (note.audio_rel_path) {
    voiceBar.classList.remove("hidden");
    audio.src = `/api/audio/${encodeURIComponent(note.audio_rel_path)}`;
  } else {
    voiceBar.classList.add("hidden");
    audio.removeAttribute("src");
  }
  renderList();
}

async function saveCurrent() {
  if (!currentPath) return;
  const md = $("editor").value;
  $("sync-pill").textContent = "○ Syncing...";
  const res = await fetch("/api/note", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rel_path: currentPath, markdown: md }),
  });
  if (res.ok) {
    $("sync-pill").textContent = "● Saved (syncing to thomas/scribe)";
    fetchNotes($("search-input").value);
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
    await fetchNotes($("search-input").value);
    openNote(note.rel_path);
    $("editor").focus();
  }
}

async function deleteCurrent() {
  if (!currentPath) return;
  await fetch(`/api/note?path=${encodeURIComponent(currentPath)}`, { method: "DELETE" });
  currentPath = null;
  $("editor").value = "";
  $("preview").innerHTML = "";
  $("note-path").textContent = "No note selected";
  await fetchNotes($("search-input").value);
}

$("editor").addEventListener("input", () => {
  $("preview").innerHTML = renderMarkdown($("editor").value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 450);
});

$("search-input").addEventListener("input", (e) => fetchNotes(e.target.value));
$("btn-new").onclick = createNote;
$("btn-delete").onclick = deleteCurrent;
$("btn-sync").onclick = async () => {
  $("sync-footer").textContent = "↻ Syncing to thomas/scribe...";
  const res = await fetch("/api/sync", { method: "POST", body: "{}" });
  const data = await res.json();
  $("sync-footer").textContent = `● Hindsight: ${data.bank}/${data.folder} (+${data.synced})`;
  fetchNotes($("search-input").value);
};
$("btn-theme").onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
};

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    $("workspace").className = `workspace mode-${btn.dataset.mode}`;
  };
});

// Hooks for native GTK4 hybrid shell
window.__SCRIBE_SET_THEME__ = (t) => { document.documentElement.dataset.theme = t; };
window.__SCRIBE_NEW_NOTE__ = createNote;
window.__SCRIBE_FILTER__ = (q) => { $("search-input").value = q; fetchNotes(q); };

fetchNotes();
