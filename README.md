# Scribe

**Scribe** is a fast, local-first **Markdown + LaTeX + Voice Notes** app for **Desktop (Linux/Wayland & macOS)** and **Android**, designed around the **Orb hybrid mode** aesthetic (dark & light mode) with automatic background sync to Hindsight (`thomas` bank under the `scribe/` folder).

## Repository Layout

- `desktop/linux_shell/` — Native GTK4 + WebKitGTK 6.0 hybrid shell (native lean-ui sidebar, search, theme toggle + WebKit Markdown/LaTeX canvas)
- `desktop/macos_shell/` — Native AppKit + WKWebView macOS shell
- `desktop/daemon/` — Hardened loopback `scribe-locald` daemon (`~/Notes` Markdown + voice audio store, SQLite FTS5, automatic Hindsight `thomas/scribe` sync)
- `desktop/ui/` — Orb-styled Dark & Light Markdown + LaTeX + Voice Note web canvas
- `android/` — Jetpack Compose Android app (Apple Notes-inspired list & editor, Orb dark/light palette, on-device voice notes via Silero VAD + Parakeet ASR + WeSpeaker, Translate tucked into overflow menu, automatic Hindsight `thomas/scribe` sync)
- `spark-voice-service/` — FastAPI parity server for DGX Spark
- `nix/` & `flake.nix` — Nix package (`scribe-desktop`, `scribe-locald`) and Home Manager module (`programs.scribe`)

## Hindsight Sync

Every note (unless tagged `#private` / `#nosync` or `sync: false`) is automatically content-address synced (`SHA-256`) into your **`thomas`** Hindsight bank under `document_id = "scribe/<rel_path>"` (`folder_path = "scribe"`), so all notes are backed up and queryable by your assistants without cluttering the editor with a Hindsight or Notion browser.
