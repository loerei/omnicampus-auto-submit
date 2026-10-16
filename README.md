# Omnicampus Auto Submit (`omnicampus-auto-submit`)

Autonomous batch submission, score extraction, and leaderboard ranking runner for [Omnicampus](https://edu.omnicamp.us) assignments via the Chrome DevTools Protocol (CDP).

Supports **Brave**, **Google Chrome**, **Microsoft Edge**, and **Chromium** with zero npm dependencies (pure native Node.js 22+).

---

## Features

- **Zero NPM Dependencies**: Built 100% on native Node.js (`WebSocket`, `fetch`, `process.loadEnvFile`).
- **Multi-Browser Support**: Connects seamlessly to Brave, Chrome, Microsoft Edge, or Chromium via remote debugging.
- **Batch Submission**: Accepts single files, lists of files, directories, or glob patterns (e.g. `"candidates/*.csv"`).
- **Fast 1s Polling with Early Exit**: Polls DOM status every second and captures scores immediately upon completion without unnecessary waiting.
- **Token-Saving Progress Logging**: Emits clean state transitions instead of spamming stdout, making it ideal for LLM coding agents and subagents.
- **Cross-Process FIFO Queue**: Multiple terminals or autonomous subagents coordinate safely through an atomic file-based FIFO lock with automatic dead-process eviction.
- **Automated Leaderboard Standing**: Automatically opens/reloads the assignment leaderboard, extracts your rank ("No"), total participant count, and calculates your percentile (`(Rank / Highest) * 100%`).

---

## Prerequisites

- **Node.js 22.0.0 or higher** (uses native `WebSocket` and `fetch`).
- A Chromium-based browser logged into your Omnicampus account, started with `--remote-debugging-port=9222`.

### Starting Your Browser with Remote Debugging

Close existing instances of your target browser (or ensure background apps are closed), then launch from your terminal:

#### Brave
- **Windows**:
  ```powershell
  brave.exe --remote-debugging-port=9222 --remote-allow-origins=*
  ```
- **macOS**:
  ```bash
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" --remote-debugging-port=9222
  ```
- **Linux**:
  ```bash
  brave-browser --remote-debugging-port=9222
  ```

#### Google Chrome
- **Windows**:
  ```powershell
  chrome.exe --remote-debugging-port=9222 --remote-allow-origins=*
  ```
- **macOS**:
  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222
  ```
- **Linux**:
  ```bash
  google-chrome --remote-debugging-port=9222
  ```

#### Microsoft Edge
- **Windows**:
  ```powershell
  msedge.exe --remote-debugging-port=9222 --remote-allow-origins=*
  ```
- **macOS**:
  ```bash
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --remote-debugging-port=9222
  ```
- **Linux**:
  ```bash
  microsoft-edge --remote-debugging-port=9222
  ```

---

## Quick Start

### 1. Configuration (`.env`)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Configure your settings:

```env
# Target browser: brave | chrome | edge | chromium
BROWSER=brave

# CDP port and host (default: 9222)
CDP_PORT=9222
CDP_HOST=127.0.0.1

# Omnicampus assignment configuration
OMNICAMPUS_COURSE_ID=170
OMNICAMPUS_ASSIGNMENT_ID=1038

# Optional: Set your Account Name for automatic ranking & percentile extraction
OMNICAMPUS_ACCOUNT_NAME=your_account_name
```

> **Note**: If `OMNICAMPUS_ACCOUNT_NAME` is omitted, leaderboard navigation is skipped, and the runner outputs a reminder notice.

---

### 2. Usage

#### Submit a Single File
```bash
node submit_omnicampus.mjs submission.csv
```

#### Submit Multiple Files in Batch
```bash
# Explicit file list
node submit_omnicampus.mjs model_1.csv model_2.csv model_3.csv

# Directory of .csv files
node submit_omnicampus.mjs candidates_dir/

# Wildcard / Glob pattern
node submit_omnicampus.mjs "candidates/*.csv"
```

#### CLI Options & Overrides
```bash
# Specify target browser via CLI
node submit_omnicampus.mjs submission.csv --browser chrome

# Custom CDP port
node submit_omnicampus.mjs submission.csv --port 9223

# Set scoring timeout ceiling per file (default 60s)
node submit_omnicampus.mjs "candidates/*.csv" --wait 45

# Override account name via CLI
node submit_omnicampus.mjs submission.csv --account myAccountName

# Temporarily skip leaderboard lookup
node submit_omnicampus.mjs submission.csv --no-account
```

---

## Execution Flow

```text
1. Check Browser CDP endpoint (e.g. http://127.0.0.1:9222/json/version)
2. Acquire Cross-Process FIFO Queue lock (waits if another runner is active)
3. Locate existing Omnicampus tab or open target assignment URL
4. For each file in batch:
   ├── Inject .csv into file input via CDP (DOM.setFileInputFiles)
   ├── Wait for Submit button to enable and trigger click
   ├── Poll DOM every 1s for "Scoring Success"
   ├── Capture score and timestamp immediately upon completion
   ├── If account name configured: query leaderboard tab, calculate rank & percentile
   └── Settle delay (2s) before next candidate
5. Release Queue lock (allows next waiting process in line to proceed)
6. Output structured batch summary table
```

---

## Cross-Process Queue Architecture

When multiple subagents, automated pipelines, or terminal tabs invoke `submit_omnicampus.mjs` concurrently, they coordinate through a machine-wide atomic FIFO queue stored at `os.tmpdir()/omnicampus_submit_queue`:
- **Strict FIFO Ordering**: Requests are served in order of arrival.
- **Deadlock Prevention**: Automatically detects terminated/crashed processes using OS-level signal inspection (`process.kill(pid, 0)`) and purges stale lock files (180s ceiling).
- **Token Efficiency**: Waiting processes log progress conservatively (every 10 seconds or on position change) to avoid context flooding.

---

## License

MIT License. Copyright (c) 2026 loerei.
