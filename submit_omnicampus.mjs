import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const LEADERBOARD_URL = 'https://edu.omnicamp.us/en/courses/170/assignments/1038/leader-board/';
const BRAVE_DEBUG_URL = 'http://127.0.0.1:9222';
const DEFAULT_WAIT_SECONDS = 60;
const SETTLE_DELAY_MS = 2000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = fs.existsSync(path.resolve('.env'))
  ? path.resolve('.env')
  : path.resolve(REPO_ROOT, '.env');

function loadEnv() {
  if (typeof process.loadEnvFile === 'function') {
    try {
      if (fs.existsSync(ENV_PATH)) {
        process.loadEnvFile(ENV_PATH);
      } else {
        process.loadEnvFile();
      }
    } catch {}
  }
}
loadEnv();

const QUEUE_DIR = process.env.OMNICAMPUS_QUEUE_DIR || path.join(os.tmpdir(), 'omnicampus_submit_queue');
const LOCK_FILE = path.join(QUEUE_DIR, 'active.lock');
const LOCK_TIMEOUT_MS = 180000; // 3 minutes timeout ceiling

function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function ensureQueueDir() {
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  } catch {}
}

function cleanStaleQueueItems() {
  ensureQueueDir();

  // Check active.lock
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const isAlive = isProcessAlive(lockData.pid);
      const isExpired = Date.now() - (lockData.acquiredAt || 0) > LOCK_TIMEOUT_MS;

      if (!isAlive || isExpired) {
        try { fs.unlinkSync(LOCK_FILE); } catch {}
      }
    } catch {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
    }
  }

  // Check ticket files
  try {
    const files = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith('.ticket.json'));
    for (const f of files) {
      const p = path.join(QUEUE_DIR, f);
      try {
        const ticket = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!isProcessAlive(ticket.pid) || (Date.now() - (ticket.createdAt || 0) > LOCK_TIMEOUT_MS)) {
          try { fs.unlinkSync(p); } catch {}
        }
      } catch {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  } catch {}
}

async function acquireQueueLock(fileTargets) {
  ensureQueueDir();
  cleanStaleQueueItems();

  const ticketId = `${Date.now().toString().padStart(15, '0')}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`;
  const ticketPath = path.join(QUEUE_DIR, `${ticketId}.ticket.json`);

  const ticketPayload = {
    ticketId,
    pid: process.pid,
    createdAt: Date.now(),
    files: fileTargets.map(f => path.basename(f))
  };

  fs.writeFileSync(ticketPath, JSON.stringify(ticketPayload), 'utf8');

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (fs.existsSync(ticketPath)) fs.unlinkSync(ticketPath);
    } catch {}
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (lockData.pid === process.pid) {
          fs.unlinkSync(LOCK_FILE);
        }
      }
    } catch {}
  };

  const exitHandler = () => release();
  process.on('exit', exitHandler);
  process.on('SIGINT', () => { release(); process.exit(130); });
  process.on('SIGTERM', () => { release(); process.exit(143); });

  const waitStart = Date.now();
  let lastLoggedPosition = -1;
  let lastLogTime = 0;

  while (true) {
    cleanStaleQueueItems();

    let tickets = [];
    try {
      tickets = fs.readdirSync(QUEUE_DIR)
        .filter(f => f.endsWith('.ticket.json'))
        .sort();
    } catch {}

    const myIndex = tickets.indexOf(`${ticketId}.ticket.json`);
    const position = myIndex !== -1 ? myIndex + 1 : 1;
    const total = Math.max(tickets.length, 1);

    if (position === 1) {
      let acquired = false;
      try {
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          ticketId,
          acquiredAt: Date.now()
        }), 'utf8');
        fs.closeSync(fd);
        acquired = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }

      if (acquired) {
        if (Date.now() - waitStart > 1500) {
          console.log(`[Queue] Turn acquired. Proceeding to submission...`);
        }
        return { release };
      }
    }

    const now = Date.now();
    const waitedSec = Math.round((now - waitStart) / 1000);
    if (position !== lastLoggedPosition || (now - lastLogTime >= 10000)) {
      console.log(`[Queue] Position ${position}/${total}. Waiting for turn (waited ${waitedSec}s)...`);
      lastLoggedPosition = position;
      lastLogTime = now;
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

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
  let accountName = process.env.OMNICAMPUS_ACCOUNT_NAME || process.env.ACCOUNT_NAME || null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--wait' && i + 1 < args.length) {
      waitSeconds = parseInt(args[i + 1], 10) || DEFAULT_WAIT_SECONDS;
      i++;
    } else if (args[i] === '--no-account') {
      accountName = null;
    } else if (args[i] === '--account' && i + 1 < args.length) {
      accountName = args[i + 1].trim() || null;
      i++;
    } else if (!args[i].startsWith('--')) {
      targets.push(args[i]);
    }
  }

  if (targets.length === 0) {
    console.error('Usage: node .devutil/submit_omnicampus.mjs <file_or_dir_or_glob...> [--wait 60] [--account <name>]');
    process.exit(1);
  }

  const files = resolveInputFiles(targets);

  if (files.length === 0) {
    console.error('No matching .csv files found from provided inputs.');
    process.exit(1);
  }

  return { files, waitSeconds, accountName };
}

async function ensureBraveReady() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BRAVE_DEBUG_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {}

    if (attempt === 0) {
      console.log('Brave port 9222 not reachable, running connection helper...');
      try {
        const helperPath = path.resolve('..', 'myskills', 'productivity', 'brave-browsing', 'scripts', 'ensure-brave.js');
        if (fs.existsSync(helperPath)) {
          execSync(`node "${helperPath}"`, { stdio: 'pipe' });
        }
      } catch (e) {
        // ignore
      }
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  return false;
}

async function getBraveTarget() {
  const isReady = await ensureBraveReady();
  if (!isReady) {
    throw new Error(`Failed to connect to Brave on ${BRAVE_DEBUG_URL}. Ensure Brave is running with --remote-debugging-port=9222.`);
  }

  let pages;
  try {
    const res = await fetch(`${BRAVE_DEBUG_URL}/json`);
    pages = await res.json();
  } catch (err) {
    throw new Error(`Failed to fetch page list from Brave on ${BRAVE_DEBUG_URL}: ${err.message}`);
  }

  // 1. Exact match on assignment 1038 submission page (exclude leaderboard subroute)
  let omniPage = pages.find(p => p.type === 'page' && p.url && p.url.includes('assignments/1038') && !p.url.includes('/leader-board/'));

  // 2. Fallback to any Omnicampus tab to repurpose and navigate
  if (!omniPage) {
    omniPage = pages.find(p => p.type === 'page' && p.url && p.url.includes('edu.omnicamp.us'));
  }

  // 3. Create a new tab if no Omnicampus tab is found
  if (!omniPage) {
    console.log('No Omnicampus tab found in Brave, creating new tab...');
    const createRes = await fetch(`${BRAVE_DEBUG_URL}/json/new?${encodeURIComponent(ASSIGNMENT_URL)}`, { method: 'PUT' });
    omniPage = await createRes.json();
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
  let prevWaitLogged = false;
  for (let i = 0; i < 30; i++) {
    const status = await getDomStatus(cdp.send);
    if (!status?.isScoring) break;
    if (!prevWaitLogged) {
      console.log('Previous scoring still in progress, waiting for completion...');
      prevWaitLogged = true;
    }
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

  console.log(`Dispatched. Probing for score every 1s...`);

  const startTime = Date.now();
  const maxWaitMs = waitSeconds * 1000;
  let finalScore = null;
  let finalTimestamp = null;
  let submissionStatus = 'TIMEOUT';
  let reportedScoring = false;

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
        console.log(`Scored: ${finalScore} (${finalTimestamp}) in ${elapsed}s`);
        break;
      } else if (curr.submittedTime || curr.isScoring) {
        if (!reportedScoring) {
          console.log(`Scoring in progress, probing every 1s...`);
          reportedScoring = true;
        }
      }
    }
  }

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

async function ensurePageReady(cdp) {
  await cdp.send('Page.enable');

  const currentUrl = await evaluate(cdp.send, 'window.location.href');
  const isExactAssignmentPage = currentUrl && currentUrl.includes('assignments/1038') && !currentUrl.includes('/leader-board/');

  if (!isExactAssignmentPage) {
    console.log(`Current page is ${currentUrl || 'unknown'}. Navigating to ${ASSIGNMENT_URL}...`);
    await cdp.send('Page.navigate', { url: ASSIGNMENT_URL });
  }

  console.log('Waiting for Omnicampus submission interface to load...');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await evaluate(cdp.send, `(() => {
      const fileInput = document.querySelector('input[type="file"]');
      const submitBtn = Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('Submit'));
      return !!fileInput && submitBtn;
    })()`);
    if (ready) break;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!ready) {
    throw new Error('Omnicampus page loaded, but submission controls were not found. Ensure you are logged into Omnicampus in Brave.');
  }

  console.log('Omnicampus submission interface is ready.');
}

async function getLeaderboardRanking(accountName) {
  if (!accountName) return null;

  let pages;
  try {
    const res = await fetch(`${BRAVE_DEBUG_URL}/json`);
    pages = await res.json();
  } catch {
    return null;
  }

  let lbPage = pages.find(p => p.type === 'page' && p.url && p.url.includes('assignments/1038/leader-board'));

  if (!lbPage) {
    console.log('Opening Omnicampus leaderboard tab in Brave...');
    const createRes = await fetch(`${BRAVE_DEBUG_URL}/json/new?${encodeURIComponent(LEADERBOARD_URL)}`, { method: 'PUT' });
    lbPage = await createRes.json();
  }

  const cdp = await createCdpClient(lbPage.webSocketDebuggerUrl);

  try {
    await cdp.send('Page.enable');

    const currentUrl = await evaluate(cdp.send, 'window.location.href');
    if (!currentUrl || !currentUrl.includes('assignments/1038/leader-board')) {
      await cdp.send('Page.navigate', { url: LEADERBOARD_URL });
    } else {
      await cdp.send('Page.reload');
    }

    await new Promise(r => setTimeout(r, 500));

    // Wait until leaderboard table rows are rendered
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try {
        ready = await evaluate(cdp.send, `(() => {
          const rows = document.querySelectorAll('tbody tr, table tr');
          return rows.length > 10;
        })()`);
        if (ready) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    if (!ready) {
      console.warn('Leaderboard table did not finish rendering.');
      return null;
    }

    const evalExpr = `(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr, table tr')).map(r => {
        return Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim());
      }).filter(r => r.length >= 3 && /^\\d+$/.test(r[0]));

      if (rows.length === 0) return null;

      const highestNo = parseInt(rows[rows.length - 1][0], 10) || rows.length;
      const targetRow = rows.find(r => r[1].toLowerCase() === ${JSON.stringify(accountName.toLowerCase())});

      if (!targetRow) return { found: false, highestNo };

      const no = parseInt(targetRow[0], 10);
      const percentile = ((no / highestNo) * 100).toFixed(2);
      return {
        found: true,
        no,
        name: targetRow[1],
        score: targetRow[2],
        highestNo,
        percentile: percentile + '%'
      };
    })()`;

    let result = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        result = await evaluate(cdp.send, evalExpr);
        if (result) break;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    return result;
  } catch (err) {
    console.warn(`Failed to inspect leaderboard: ${err.message}`);
    return null;
  } finally {
    cdp.close();
  }
}

async function main() {
  const { files, waitSeconds, accountName } = parseArgs();

  console.log(`========================================`);
  console.log(`Omnicampus Batch Submission Runner`);
  console.log(`Target account: ${accountName || '(none - leaderboard ranking skipped)'}`);
  console.log(`Found ${files.length} candidate file(s):`);
  files.forEach((f, idx) => console.log(`  ${idx + 1}. ${path.basename(f)}`));
  console.log(`Per-file wait window: ${waitSeconds}s`);
  console.log(`========================================`);

  await ensureBraveReady();

  const queueLease = await acquireQueueLock(files);
  let cdp = null;

  try {
    console.log('Connecting to Brave debugging session on port 9222...');
    const target = await getBraveTarget();
    console.log(`Connected to tab: ${target.title}`);

    cdp = await createCdpClient(target.webSocketDebuggerUrl);
    await ensurePageReady(cdp);

    const results = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const res = await submitSingleFile(cdp, files[i], waitSeconds, i, files.length);

        if (res.status === 'SUCCESS' || res.status === 'COMPLETED') {
          if (accountName) {
            console.log(`Querying leaderboard ranking for '${accountName}'...`);
            const rankInfo = await getLeaderboardRanking(accountName);
            if (rankInfo && rankInfo.found) {
              res.rank = `${rankInfo.no}/${rankInfo.highestNo}`;
              res.percentile = rankInfo.percentile;
              console.log(`Leaderboard Standing: Rank ${rankInfo.no}/${rankInfo.highestNo} | Percentile: ${rankInfo.percentile} | Board Score: ${rankInfo.score}`);
            } else if (rankInfo) {
              res.rank = 'Not ranked';
              res.percentile = 'N/A';
              console.log(`Account '${accountName}' not found on leaderboard (Total entries: ${rankInfo.highestNo}).`);
            } else {
              res.rank = 'N/A';
              res.percentile = 'N/A';
            }
          } else {
            console.log(`Set your Account Name in the ${ENV_PATH} to get your ranking after a submission.`);
            res.rank = 'N/A';
            res.percentile = 'N/A';
          }
        } else {
          res.rank = 'N/A';
          res.percentile = 'N/A';
        }

        results.push(res);
      } catch (err) {
        console.error(`[Error] Submission failed for ${path.basename(files[i])}:`, err.message);
        results.push({
          index: i + 1,
          file: path.basename(files[i]),
          fullPath: files[i],
          score: 'ERROR',
          rank: 'N/A',
          percentile: 'N/A',
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
    console.log('\n========================================================================================================================');
    console.log(`BATCH SUBMISSION SUMMARY (Total: ${results.length})`);
    console.log('========================================================================================================================');
    console.log(
      '#'.padEnd(4) +
      'File'.padEnd(30) +
      'Score'.padEnd(10) +
      'Rank'.padEnd(14) +
      'Percentile'.padEnd(14) +
      'Duration'.padEnd(10) +
      'Status'.padEnd(10) +
      'Timestamp'
    );
    console.log('-'.repeat(120));

    for (const r of results) {
      console.log(
        String(r.index).padEnd(4) +
        r.file.padEnd(30) +
        String(r.score).padEnd(10) +
        String(r.rank || 'N/A').padEnd(14) +
        String(r.percentile || 'N/A').padEnd(14) +
        r.duration.padEnd(10) +
        r.status.padEnd(10) +
        r.timestamp
      );
    }
    console.log('========================================================================================================================');

    return results;
  } finally {
    if (cdp) {
      try { cdp.close(); } catch {}
    }
    queueLease.release();
  }
}

main().catch(err => {
  console.error('Batch submission script failed:', err.message);
  process.exit(1);
});
