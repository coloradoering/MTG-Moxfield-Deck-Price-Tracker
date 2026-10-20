/**
 * Chrome availability check for the scraper.
 *
 * This module deliberately does NOT launch a browser.
 *
 * An earlier version did, and it was wrong in a way that took three attempts to
 * see clearly. Windows gives Chrome single-instance behaviour: if an instance is
 * already running for a profile, a new invocation hands its flags to the existing
 * process, which ignores --remote-debugging-port and exits. So auto-launch
 * silently did nothing whenever the user already had Chrome open, and the
 * failure surfaced far away as a CORS error inside the page.
 *
 * Trying to manage the user's browser from a web request was the mistake. The
 * scraper needs a specific Chrome, started a specific way, with a logged-in
 * Moxfield session. That is the user's decision, taken deliberately, once. The
 * app's job is to say clearly whether it is there.
 */

const CHROME_URL = process.env.CHROME_URL || 'http://localhost:9222';

const START_HINT =
  'Start it with start-chrome.bat (Windows), then log into Moxfield in that window.';

/**
 * Is a debuggable Chrome answering on the debug port?
 *
 * Returns { up, browser, message }. `browser` is the reported product name when
 * up, so the caller can distinguish Chrome from something else holding the port.
 */
async function checkChrome(url = CHROME_URL, timeoutMs = 2000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${url}/json/version`, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      return {
        up: false,
        browser: null,
        message: `Something answered on ${url} but returned HTTP ${res.status}. ${START_HINT}`,
      };
    }

    const body = await res.json();
    if (!body || !(body.webSocketDebuggerUrl || body.Browser)) {
      return {
        up: false,
        browser: null,
        message: `Nothing that looks like a browser is listening on ${url}. ${START_HINT}`,
      };
    }

    return { up: true, browser: body.Browser || 'unknown', message: null };
  } catch {
    return {
      up: false,
      browser: null,
      message: `No browser is listening on ${url}. ${START_HINT}`,
    };
  }
}

module.exports = { checkChrome, CHROME_URL, START_HINT };
