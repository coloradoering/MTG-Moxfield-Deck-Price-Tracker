/**
 * Chrome lifecycle for the scraper.
 *
 * The scraper attaches to a real, visible Chrome rather than launching its own
 * (see README, "Why a browser is required"), so something has to guarantee one is
 * listening on the debugging port. This module probes for it and starts it if it
 * is not there.
 *
 * Two rules, both learned the hard way:
 *
 *  - Never `taskkill` Chrome to "reset" it. The previous start-chrome.bat killed
 *    every Chrome window, including whatever the user was working in. If a tab is
 *    open in the debug profile we reuse it; if the port is dead we start a
 *    separate instance; if the port is taken by something that is not Chrome we
 *    say so and stop.
 *
 *  - Never assume the launch worked. Starting a browser takes a few seconds, so
 *    poll the port until it answers rather than racing it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const CHROME_URL = process.env.CHROME_URL || 'http://localhost:9222';
const PROFILE_DIR =
  process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), 'chrome-debug-profile');

/** Candidate browser executables, in preference order. */
function chromeCandidates() {
  if (process.env.CHROME_PATH) return [process.env.CHROME_PATH];
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findChrome() {
  return chromeCandidates().find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/** True if something is answering the DevTools endpoint on the debug port. */
async function isChromeUp(url = CHROME_URL, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${url}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    const body = await res.json();
    // Distinguish Chrome from anything else that might hold the port.
    return Boolean(body && (body.Browser || body.webSocketDebuggerUrl));
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ensure a debuggable Chrome is available.
 *
 * Returns { status, url, started, pid?, message }, where status is one of
 * 'already-running' | 'started' | 'no-browser' | 'failed'.
 */
async function ensureChrome({ url = CHROME_URL, log = () => {} } = {}) {
  if (await isChromeUp(url)) {
    return { status: 'already-running', url, started: false };
  }

  const exe = findChrome();
  if (!exe) {
    return {
      status: 'no-browser',
      url,
      started: false,
      message:
        'Could not find Chrome. Install it, or set CHROME_PATH to the executable, ' +
        'then start it with --remote-debugging-port=9222.',
    };
  }

  log(`Starting ${path.basename(exe)} with remote debugging...`);

  const args = [
    '--remote-debugging-port=9222',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // Detached + unref so the browser outlives this request. stdio ignored so a
  // parent that exits does not close the child's pipes.
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  // Poll rather than racing the launch.
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    if (await isChromeUp(url)) {
      return { status: 'started', url, started: true, pid: child.pid };
    }
  }

  return {
    status: 'failed',
    url,
    started: false,
    message: `Started Chrome but nothing answered on ${url} within 10s. Check the port is not blocked.`,
  };
}

module.exports = { ensureChrome, isChromeUp, findChrome, CHROME_URL, PROFILE_DIR };
