# Scribe

Local-first, multi-speaker voice notes and live bidirectional interpreter for Android (optimized for Motorola Razr 60 Ultra cover screen + inner screen + wide two-pane layouts) with optional **Orb Router** LLM polish and **DGX Spark** parity.

## Architecture

| Stage | Model | Where It Runs | Purpose |
| :--- | :--- | :--- | :--- |
| **VAD** | **Silero VAD v5** (`silero_vad.onnx`, 643 KB) | On-device (`sherpa-onnx`) | Low-latency speech/pause detection with room-mic AGC for distant voices |
| **Offline ASR** | **NVIDIA Parakeet-TDT-0.6B-v3** (INT8, 640 MB) | On-device (`sherpa-onnx`, ~100 ms/turn) | 100% offline transcription across 25 European languages (EN, FR, PT, ES, DE, IT, …) with native punctuation & capitalization |
| **Speaker ID** | **WeSpeaker ResNet293-LM** (`[1,200,80] -> [1,256]`, 0.45% EER) | On-device (ONNX Runtime / QNN HTP) | Extracts 256-D voiceprints to separate speakers by color and match saved names in `Documents/OrbVoice/voiceprints.json` |
| **Live Polish & Translate** | **Orb Router `builtin/fast`** | Cloud (optional, offline-safe) | Rolling jargon autocorrect, auto-title + summary on stop, Settings auto-translate target, and live bidirectional `Lang A ⇄ Lang B` **Translate** mode |
| **Deep Audio Polish** | **Orb Router `builtin/smart`** (configurable quorum) | On-demand per saved note | Uploads the saved audio directly to a strong multimodal model for studio-grade transcription & speaker attribution |
| **Non-NPU / Thin-Client Parity** | **`spark-voice-service/server.py`** | DGX Spark / GPU server | Mirrors `WeSpeaker ResNet293-LM` + `Parakeet-TDT-0.6B-v3` and syncs the shared 256-D Voiceprint Registry |

## Features
- **Library of Voices:** Tap any colored speaker pill to label them (`Thomas`, `Teacher`, etc.) — their 256-D voiceprint is saved and recognized automatically in future recordings.
- **Background & Locked Recording:** Foreground microphone service + partial wake lock keeps recording with the screen off or phone folded; optional `☕` Stay-Awake toggle keeps the cover screen on while watching.
- **Bidirectional Translate Mode:** Pick two languages (`English ⇄ French`, `French ⇄ Portuguese`, etc.) to see original speech + live translation across multiple speakers in real time.
- **LLM-Queryable Notes:** Every session saves clean timestamped Markdown + JSON + audio to `Documents/OrbVoice/` (and syncs to DGX Spark Memory / Hindsight) so you can later ask an LLM *"What did my teacher say yesterday?"*.

## Repository Layout
- `android/` — Jetpack Compose Android app (`com.th0rgal.orbvoice`, launcher name **Scribe**)
- `spark-voice-service/` — FastAPI parity server for DGX Spark (`POST /v1/diarize-transcribe`, `GET/POST /v1/voiceprints`)
