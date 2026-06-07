# Motkra — VS Code Extension

A VS Code sidebar extension that combines **Claude** (cloud, agentic) and **Gemma 4** (local, fast) in a single chat panel — like GitHub Copilot but with two models and direct file editing.

---

## Features

- **Side panel chat** — Activity Bar icon opens a persistent chat panel
- **Auto-routing** — short/simple questions go to Gemma 4 locally; complex/code tasks go to Claude
- **Agentic file editing** — Claude can read, write, and patch files directly (no copy-paste)
- **Right-click menu** — send selected code to the panel with one click
- **Streaming** — both models stream tokens in real time
- **No extra server** — Gemma runs via Ollama locally, Claude via the Anthropic API

---

## Requirements

| Requirement | Version |
|---|---|
| VS Code | 1.80+ |
| Node.js | 18+ |
| Ollama | running locally on port 11434 |
| Gemma 4 model | `ollama pull gemma4:e2b` |
| Anthropic API key | from [console.anthropic.com](https://console.anthropic.com/) |

---

## Project Structure

```
dual_ai_ext/
├── extension.js          Main entry point — registers sidebar + right-click commands
├── agent.js              Claude agentic loop with file tools
├── router.js             Auto-routing logic (local vs cloud)
├── clients/
│   └── gemma.js          Ollama HTTP streaming client
├── media/
│   ├── icon.svg          Activity Bar icon
│   └── panel.html        Chat UI (HTML + CSS + JS)
├── package.json          Extension manifest
└── README.md             This file
```

The API key is loaded automatically from `../dual_ai/.env` (sibling folder).

---

## Setup

### 1. Install dependencies

```bash
cd dual_ai_ext
npm install
```

### 2. Make sure your `.env` exists

The file lives at `dual_ai/.env` (one level up):

```
ANTHROPIC_API_KEY=sk-ant-...
```

If you don't have it yet, copy the sample:

```bash
cd ../dual_ai
copy .env.example .env
# then edit .env and add your real key
```

### 3. Make sure Ollama is running with Gemma 4

```bash
ollama serve          # start Ollama if not already running
ollama pull gemma4:e2b  # download model (first time only)
```

---

## Launch (Development Mode)

1. Open the `dual_ai_ext` folder in VS Code:
   ```
   File → Open Folder → dual_ai_ext
   ```

2. Press **F5** — this opens an **Extension Development Host** window.

3. In the new window, click the **two-circles icon** in the Activity Bar to open the **Motkra** panel.

> The extension reloads automatically when you save changes to source files.

---

## Install as a Permanent Extension (.vsix)

To use the extension in any VS Code window without pressing F5:

```bash
# Install the packaging tool (once)
npm install -g @vscode/vsce

# Build the .vsix file
cd dual_ai_ext
vsce package --no-dependencies

# Install it in VS Code
# Extensions panel → ... (top-right) → Install from VSIX → select dual-ai-assistant-0.1.0.vsix
```

---

## Usage

### Chat panel

| Action | Result |
|---|---|
| Type a message + Enter | Send to auto-routed model |
| Shift + Enter | New line in input |
| `✕ clear` button | Wipe conversation history |

### Model indicator

The badge at the top of the panel shows which model is active:

- `☁ Claude` — Anthropic API, agentic, can edit files
- `🏠 Gemma 4` — local Ollama, fast, private, no API call
- `Auto` — will route the next message automatically

### Right-click menu (editor)

Select any code in the editor, right-click, and choose:

| Command | What it does |
|---|---|
| **Motkra: Send Selection** | Sends selection to the panel with "Explain this code:" |
| **Motkra: Fix This Code** | Sends selection with "Fix this code (edit the file directly):" |

---

## How Auto-Routing Works

The router scores keywords in your message:

**→ Gemma 4 (local)** when the message contains: `quick`, `brief`, `short`, `fast`, `simple`, `summarize`, `tldr`, `private`, `offline`

**→ Claude (cloud)** when the message contains: `explain`, `analyze`, `generate`, `implement`, `fix`, `edit`, `refactor`, `design`, `debug`, `create`, `write`, `build`, `how do`, `how does`

**Tie-break:** messages with 8 words or fewer go to Gemma; longer ones go to Claude.

You can override routing mid-session by just asking in a way that contains the right keywords, or the model badge will update automatically each turn.

---

## Claude Agent Tools

When Claude handles a request it can call these tools directly:

| Tool | Description |
|---|---|
| `read_file` | Read the full contents of any file in the workspace |
| `write_file` | Create or overwrite a file with new content |
| `str_replace` | Replace an exact string inside a file (targeted edits) |
| `list_files` | List files and folders in a directory |

File paths are resolved relative to the **workspace root** of the Extension Development Host window. When Claude uses a tool, you will see a line like:

```
⚙ str_replace  {"path":"bell_state/bell.py","old_text":"...","new_text":"..."}
```

The file is edited on disk immediately. VS Code will show the standard "file changed on disk" prompt if the file is open in an editor.

---

## Models Used

| Role | Model ID | Notes |
|---|---|---|
| Cloud agent | `claude-opus-4-7` | Adaptive thinking + xhigh effort + prompt caching |
| Local chat | `gemma4:e2b` | Runs via Ollama on localhost:11434 |

---

## Troubleshooting

**Panel doesn't appear after F5**
- Make sure you opened the `dual_ai_ext` folder (not the parent `Quantum` folder) before pressing F5.

**`ANTHROPIC_API_KEY` error**
- Check that `dual_ai/.env` exists and contains `ANTHROPIC_API_KEY=sk-ant-...` with no extra spaces.

**Ollama connection refused**
- Run `ollama serve` in a separate terminal before using Gemma.

**`gemma4:e2b` not found**
- Run `ollama pull gemma4:e2b` to download the model.

**`str_replace` — text not found**
- Claude matched the wrong text. Ask it to `read_file` first, then retry the edit.
