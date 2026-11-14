/**
 * Chrome availability and automatic startup for the Moxfield scraper.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME_URL = process.env.CHROME_URL || 'http://localhost:9222';
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR
  || path.join(os.homedir(), 'chrome-debug-profile');

function getChromeLaunchArgs(url = CHROME_URL, profileDir = PROFILE_DIR) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
  ) {
    throw new Error(`Cannot auto-launch Chrome for non-local CHROME_URL "${url}".`);
  }

  const port = parsed.port || '9222';
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'https://www.moxfield.com/',
  ];
}

function findChromeExecutable() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramFiles && path.join(
        process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'
      ),
      process.env['ProgramFiles(x86)'] && path.join(
        process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'
      ),
      process.env.LOCALAPPDATA && path.join(
        process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'
      ),
    ].filter(Boolean);
    const executable = candidates.find((candidate) => fs.existsSync(candidate));
    if (executable) return executable;
    throw new Error('Chrome was not found. Set CHROME_PATH to the Chrome executable.');
  }

  if (process.platform === 'darwin') {
    const executable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(executable)) return executable;
    throw new Error('Chrome was not found. Set CHROME_PATH to the Chrome executable.');
  }

  return 'google-chrome';
}

async function checkChrome(url = CHROME_URL, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const endpoint = new URL(url);
    if (!endpoint.port) endpoint.port = '9222';
    const res = await fetch(`${endpoint.origin}/json/version`, { signal: ctrl.signal });
    if (!res.ok) {
      return {
        up: false,
        occupied: true,
        browser: null,
        message: `Something answered on ${url} but returned HTTP ${res.status}.`,
      };
    }

    let body;
    try {
      body = await res.json();
    } catch {
      return {
        up: false,
        occupied: true,
        browser: null,
        message: `Something answered on ${url}, but it did not return browser information.`,
      };
    }
    if (!body || !(body.webSocketDebuggerUrl || body.Browser)) {
      return {
        up: false,
        occupied: true,
        browser: null,
        message: `Something answered on ${url}, but it does not look like a browser.`,
      };
    }

    return { up: true, occupied: true, browser: body.Browser || 'unknown', message: null };
  } catch {
    return { up: false, occupied: false, browser: null, message: `No browser is listening on ${url}.` };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureChrome(url = CHROME_URL, { timeoutMs = 20000, pollMs = 500 } = {}) {
  let status = await checkChrome(url);
  if (status.up) return { ...status, started: false };
  if (status.occupied) throw new Error(status.message);

  const args = getChromeLaunchArgs(url);
  const executable = findChromeExecutable();
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  }).catch((err) => {
    throw new Error(`Could not launch Chrome: ${err.message}`);
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    status = await checkChrome(url, 1000);
    if (status.up) return { ...status, started: true };
    if (status.occupied) throw new Error(status.message);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  throw new Error(
    `Chrome was launched but did not become available at ${url} within ${timeoutMs} ms.`
  );
}

module.exports = {
  checkChrome,
  ensureChrome,
  getChromeLaunchArgs,
  CHROME_URL,
  PROFILE_DIR,
};
