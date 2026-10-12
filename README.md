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
- Omnicampus account logged in inside Brave (tab will auto-open/navigate if not already on the submission page).

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

# Override or specify account name via CLI
node .devutil/submit_omnicampus.mjs Competition/submission.csv --account myAccount
```

### Configuration (`.env`)

To automatically fetch your leaderboard standing and percentile after submission without passing CLI arguments, define your account name in `.env`:

```env
OMNICAMPUS_ACCOUNT_NAME=yourAccountName
```

If neither `OMNICAMPUS_ACCOUNT_NAME` nor `--account` is set, leaderboard lookups are skipped and the runner outputs:
```text
Set your Account Name in the <.env path> to get your ranking after a submission.
```

### Flow

1. Connects to Brave via debugging port 9222.
2. Locates an existing Omnicampus tab or creates a new one, navigates to the assignment 1038 submission URL if on another page, and waits until the upload interface is fully rendered.
3. For each candidate file in the batch:
   - Waits if a previous submission is still scoring (polls every 1s).
   - Injects the file into `<input type="file">` via Chrome DevTools Protocol (`DOM.setFileInputFiles`).
   - Waits for the `Submit` button to enable in React.
   - Triggers click on `Submit`.
   - Polls DOM status every 1s until `Scoring Success` is detected, capturing score and timestamp immediately upon completion (or timing out if `--wait` limit is reached).
   - If an account name is configured, queries the leaderboard page via a dedicated tab to extract Rank, Total participants, and calculates percentile `(Rank / Highest) * 100` (%). If not configured, prints the instructional notice and skips leaderboard navigation.
   - Pauses brief settle time before the next candidate.
4. Prints a structured batch summary table with scores, ranks, percentiles, timestamps, and durations.
