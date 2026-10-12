import fs from 'node:fs';
import path from 'node:path';

/**
 * Omnicampus Submission & Score Automation (Batch Supported)
 * Automates uploading one or more submission .csv files to Omnicampus and extracting scores
 * sequentially via Brave Remote Debugging Protocol (port 9222).
 *
 * Usage:
 *   node .devutil/submit_omnicampus.mjs <file_or_dir_or_glob...> [--wait <seconds>]
 *
 * Examples:
 *   node .devutil/submit_omnicampus.mjs Competition/submission.csv
 *   node .devutil/submit_omnicampus.mjs model_a.csv model_b.csv model_c.csv
 *   node .devutil/submit_omnicampus.mjs "candidates/*.csv" --wait 60
 *   node .devutil/submit_omnicampus.mjs candidates_dir/
 */

const ASSIGNMENT_URL = 'https://edu.omnicamp.us/en/courses/170/assignments/1038/';
const BRAVE_DEBUG_URL = 'http://127.0.0.1:9222';
const DEFAULT_WAIT_SECONDS = 60;
const SETTLE_DELAY_MS = 3000;

function resolveInputFiles(targets) {
  const resolved = [];

  for (const target of targets) {
    if (target.includes('*') || target.includes('?')) {
      const dir = path.dirname(target) || '.';
      const pattern = path.basename(target);
      const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      const searchDir = path.resolve(dir);

      if (fs.existsSync(searchDir) && fs.statSync(searchDir).isDirectory()) {
        const matches = fs.readdirSync(searchDir)
          .filter(f => regex.test(f))
          .map(f => path.join(searchDir, f))
          .filter(f => fs.statSync(f).isFile() && f.toLowerCase().endsWith('.csv'));
        resolved.push(...matches);
      }
    } else {
      const p = path.resolve(target);
      if (!fs.existsSync(p)) {
        console.warn(`[Warning] Path not found: ${target}`);
        continue;
      }
      if (fs.statSync(p).isDirectory()) {
        const files = fs.readdirSync(p)
          .filter(f => f.toLowerCase().endsWith('.csv'))
          .map(f => path.join(p, f))
          .filter(f => fs.statSync(f).isFile());
        resolved.push(...files);
      } else if (fs.statSync(p).isFile()) {
        resolved.push(p);
      }
    }
  }

  return Array.from(new Set(resolved));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const targets = [];
  let waitSeconds = DEFAULT_WAIT_SECONDS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wait' && args[i + 1]) {
      waitSeconds = parseInt(args[i + 1], 10) || DEFAULT_WAIT_SECONDS;
      i++;
    } else if (!args[i].startsWith('--')) {
      targets.push(args[i]);
    }
  }

  if (targets.length === 0) {
    console.error('Usage: node .devutil/submit_omnicampus.mjs <file_or_dir_or_glob...> [--wait 60]');
    process.exit(1);
  }

  const files = resolveInputFiles(targets);

  if (files.length === 0) {
    console.error('No matching .csv files found from provided inputs.');
    process.exit(1);
  }

  return { files, waitSeconds };
}

async function getBraveTarget() {
  let pages;
  try {
    const res = await fetch(`${BRAVE_DEBUG_URL}/json`, { signal: AbortSignal.timeout(2000) });
    pages = await res.json();
  } catch (err) {
    throw new Error(`Failed to connect to Brave on ${BRAVE_DEBUG_URL}. Ensure Brave is running with --remote-debugging-port=9222. Error: ${err.message}`);
  }

  let omniPage = pages.find(p => p.url && p.url.includes('edu.omnicamp.us') && p.url.includes('assignments/1038'));

  if (!omniPage) {
    console.log('Omnicampus assignment tab not found, creating new tab...');
    const createRes = await fetch(`${BRAVE_DEBUG_URL}/json/new?${encodeURIComponent(ASSIGNMENT_URL)}`, { method: 'PUT' });
    omniPage = await createRes.json();
    await new Promise(r => setTimeout(r, 3000));
  }

  return omniPage;
}

function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const pending = new Map();

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.id && pending.has(data.id)) {
        const { resolve, reject } = pending.get(data.id);
        pending.delete(data.id);
        if (data.error) reject(new Error(data.error.message || JSON.stringify(data.error)));
        else resolve(data.result);
      }
    } catch (e) {
      console.warn('Failed to parse CDP message:', e);
    }
  };

  const send = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const close = () => {
    try {
      ws.close();
    } catch {}
  };

  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, close });
    ws.onerror = (err) => reject(new Error(`WebSocket connection failed: ${err.message}`));
  });
}

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return res && res.result ? res.result.value : null;
}

async function getDomStatus(send) {
  return await evaluate(send, `(() => {
    const visible = Array.from(document.querySelectorAll('body *:not(script):not(style)'));
    const scoreInput = document.querySelector('input.form-control');
    const scoredTimeEl = visible.find(e => e.children.length === 0 && e.innerText && e.innerText.includes('was scored on'));
    const submittedTimeEl = visible.find(e => e.children.length === 0 && e.innerText && e.innerText.includes('was Submitted on'));
    const successBadge = visible.find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Scoring Success');
    const isScoringBadge = visible.find(e => e.children.length === 0 && e.innerText && e.innerText.trim() === 'Scoring');

    return {
      score: scoreInput ? scoreInput.value.trim() : null,
      scoredTime: scoredTimeEl ? scoredTimeEl.innerText.trim() : null,
      submittedTime: submittedTimeEl ? submittedTimeEl.innerText.trim() : null,
      hasSuccess: !!successBadge,
      isScoring: !!isScoringBadge
    };
  })()`);
}

async function submitSingleFile(cdp, filePath, waitSeconds, batchIdx, totalFiles) {
  const fileBase = path.basename(filePath);
  console.log(`\n[${batchIdx + 1}/${totalFiles}] Submitting: ${fileBase} (${filePath})`);

  // Wait if previous scoring is still active
  for (let i = 0; i < 30; i++) {
    const status = await getDomStatus(cdp.send);
    if (!status?.isScoring) break;
    process.stdout.write(`\rPrevious scoring still in progress, waiting 1s...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  const baselineState = await getDomStatus(cdp.send);

  // Attach file to input[type="file"]
  await cdp.send('DOM.enable');
  const doc = await cdp.send('DOM.getDocument');
  const inputNode = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: 'input[type="file"]'
  });

  if (!inputNode || !inputNode.nodeId) {
    throw new Error('File input element not found in DOM.');
  }

  await cdp.send('DOM.setFileInputFiles', {
    files: [filePath],
    nodeId: inputNode.nodeId
  });

  // Wait for Submit button to enable
  let buttonEnabled = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    buttonEnabled = await evaluate(cdp.send, `(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Submit');
      return btn && !btn.disabled;
    })()`);
    if (buttonEnabled) break;
  }

  if (!buttonEnabled) {
    throw new Error(`Submit button did not enable for ${fileBase}.`);
  }

  // Click Submit
  const clicked = await evaluate(cdp.send, `(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.trim() === 'Submit');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  })()`);

  if (!clicked) {
    throw new Error(`Failed to click Submit button for ${fileBase}.`);
  }

  console.log(`Dispatched. Polling for scoring completion (up to ${waitSeconds}s)...`);

  const startTime = Date.now();
  const maxWaitMs = waitSeconds * 1000;
  let finalScore = null;
  let finalTimestamp = null;
  let submissionStatus = 'TIMEOUT';

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, 1000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const curr = await getDomStatus(cdp.send);

    if (curr) {
      const hasNewScoredTime = curr.scoredTime && curr.scoredTime !== baselineState?.scoredTime;
      const hasValidScore = curr.score && /^\d+(\.\d+)?$/.test(curr.score);

      if (curr.hasSuccess && hasNewScoredTime && hasValidScore) {
        finalScore = curr.score;
        finalTimestamp = curr.scoredTime;
        submissionStatus = 'SUCCESS';
        process.stdout.write(`\r[+${elapsed}s] Scored: ${finalScore} (${finalTimestamp})\n`);
        break;
      } else if (curr.submittedTime) {
        process.stdout.write(`\r[+${elapsed}s] Scoring in progress (${curr.submittedTime})...`);
      } else {
        process.stdout.write(`\r[+${elapsed}s] Waiting for score...`);
      }
    }
  }

  process.stdout.write('\n');

  // Fallback read
  if (!finalScore || submissionStatus === 'TIMEOUT') {
    const fallback = await getDomStatus(cdp.send);
    const hasValidScore = fallback?.score && /^\d+(\.\d+)?$/.test(fallback.score);
    const hasNewTime = fallback?.scoredTime && fallback.scoredTime !== baselineState?.scoredTime;

    if (fallback?.hasSuccess && hasNewTime && hasValidScore) {
      finalScore = fallback.score;
      finalTimestamp = fallback.scoredTime;
      submissionStatus = 'SUCCESS';
    } else if (hasValidScore) {
      finalScore = fallback.score;
      finalTimestamp = fallback?.scoredTime || 'N/A';
      submissionStatus = 'COMPLETED';
    }
  }

  const durationSec = Math.round((Date.now() - startTime) / 1000);

  return {
    index: batchIdx + 1,
    file: fileBase,
    fullPath: filePath,
    score: finalScore || 'N/A',
    timestamp: finalTimestamp || 'N/A',
    duration: `${durationSec}s`,
    status: submissionStatus
  };
}

async function main() {
  const { files, waitSeconds } = parseArgs();

  console.log(`========================================`);
  console.log(`Omnicampus Batch Submission Runner`);
  console.log(`Found ${files.length} candidate file(s):`);
  files.forEach((f, idx) => console.log(`  ${idx + 1}. ${path.basename(f)}`));
  console.log(`Per-file wait window: ${waitSeconds}s`);
  console.log(`========================================`);

  console.log('Connecting to Brave debugging session on port 9222...');
  const target = await getBraveTarget();
  console.log(`Connected to tab: ${target.title}`);

  const cdp = await createCdpClient(target.webSocketDebuggerUrl);
  const results = [];

  try {
    for (let i = 0; i < files.length; i++) {
      try {
        const res = await submitSingleFile(cdp, files[i], waitSeconds, i, files.length);
        results.push(res);
      } catch (err) {
        console.error(`[Error] Submission failed for ${path.basename(files[i])}:`, err.message);
        results.push({
          index: i + 1,
          file: path.basename(files[i]),
          fullPath: files[i],
          score: 'ERROR',
          timestamp: 'N/A',
          duration: '0s',
          status: 'ERROR'
        });
      }

      if (i < files.length - 1) {
        console.log(`Waiting ${SETTLE_DELAY_MS / 1000}s settle time before next submission...`);
        await new Promise(r => setTimeout(r, SETTLE_DELAY_MS));
      }
    }

    // Print summary table
    console.log('\n================================================================================');
    console.log(`BATCH SUBMISSION SUMMARY (Total: ${results.length})`);
    console.log('================================================================================');
    console.log(
      '#'.padEnd(4) +
      'File'.padEnd(35) +
      'Score'.padEnd(12) +
      'Duration'.padEnd(10) +
      'Status'.padEnd(10) +
      'Timestamp'
    );
    console.log('-'.repeat(80));

    for (const r of results) {
      console.log(
        String(r.index).padEnd(4) +
        r.file.padEnd(35) +
        String(r.score).padEnd(12) +
        r.duration.padEnd(10) +
        r.status.padEnd(10) +
        r.timestamp
      );
    }
    console.log('================================================================================');

    return results;
  } finally {
    cdp.close();
  }
}

main().catch(err => {
  console.error('Batch submission script failed:', err.message);
  process.exit(1);
});
