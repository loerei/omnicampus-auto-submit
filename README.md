# Developer Utilities (`.devutil/`)

## Omnicampus Submission Utility (`submit_omnicampus.mjs`)

Automated submission and score extraction runner for Omnicampus course assignment 1038 via Brave Remote Debugging Protocol (port 9222). Supports single files and sequential batch submissions.

### Prerequisites

- Node.js 22+ (uses native `WebSocket` and `fetch`, zero npm dependencies required).
- Brave browser running with remote debugging enabled:
  ```powershell
  node D:\Projects\myskills\productivity\brave-browsing\scripts\ensure-brave.js
  ```
  or manual launch:
  ```powershell
  brave.exe --remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1:9222,http://localhost:9222
  ```
- Omnicampus tab opened and logged in at `https://edu.omnicamp.us/en/courses/170/assignments/1038/`.

### Usage

#### Single File
```powershell
node .devutil/submit_omnicampus.mjs Competition/submission.csv
```

#### Multiple Files / Batch
```powershell
# Pass multiple files directly
node .devutil/submit_omnicampus.mjs file1.csv file2.csv file3.csv

# Pass a directory containing .csv files
node .devutil/submit_omnicampus.mjs candidates_dir/

# Pass wildcard / glob patterns
node .devutil/submit_omnicampus.mjs "candidates/*.csv"

# Custom per-submission timeout ceiling (default 60s)
node .devutil/submit_omnicampus.mjs "candidates/*.csv" --wait 45
```

### Flow

1. Connects to `http://127.0.0.1:9222/json` to locate the active Omnicampus tab.
2. For each candidate file in the batch:
   - Waits if a previous submission is still scoring (polls every 1s).
   - Injects the file into `<input type="file">` via Chrome DevTools Protocol (`DOM.setFileInputFiles`).
   - Waits for the `Submit` button to enable in React.
   - Triggers click on `Submit`.
   - Polls DOM status every 1s until `Scoring Success` is detected, capturing score and timestamp immediately upon completion (or timing out if `--wait` limit is reached).
   - Pauses brief settle time before the next candidate.
3. Prints a structured batch summary table with scores, timestamps, and durations.
