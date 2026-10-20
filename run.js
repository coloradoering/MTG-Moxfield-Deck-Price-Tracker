/**
 * Take one price snapshot of every deck owned by a Moxfield user.
 *
 * Usage:
 *   node run.js                      # uses MOXFIELD_USER from env
 *   node run.js --user name          # explicit
 *   node run.js --vendor tcgplayer   # which storefront to price against
 *   node run.js --all-formats        # include non-commander decks
 *
 * Requires an already-running Chrome with remote debugging, logged into
 * Moxfield. Set CHROME_URL if it is not on localhost:9222. See README for why:
 * the API sits behind Cloudflare and rejects non-browser TLS fingerprints.
 */

const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');
const api = require('./moxfield-api');
const registry = require('./deck-registry');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moxfield_tracker';
const CHROME_URL = process.env.CHROME_URL || 'http://localhost:9222';

function parseArgs(argv) {
  const opts = {
    user: process.env.MOXFIELD_USER || null,
    vendor: process.env.MOXFIELD_VENDOR || api.DEFAULT_VENDOR,
    allFormats: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--user' || a === '-u') opts.user = argv[++i];
    else if (a === '--vendor' || a === '-v') opts.vendor = argv[++i];
    else if (a === '--all-formats') opts.allFormats = true;
  }
  return opts;
}

function localTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.user) {
    console.error(
      'No username given.\n' +
        '  Set MOXFIELD_USER=yourname, or pass --user yourname\n' +
        'Your Moxfield username is the last part of https://moxfield.com/users/<name>'
    );
    process.exit(1);
  }

  let vendor;
  try {
    vendor = api.resolveVendor(opts.vendor);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Connecting to Chrome at ${CHROME_URL}...`);
  let browser;
  try {
    browser = await puppeteer.connect({
      browserURL: CHROME_URL,
      defaultViewport: null,
    });
  } catch (err) {
    console.error(
      `Could not reach Chrome at ${CHROME_URL}.\n` +
        'Start it with remote debugging (see README), log into Moxfield, then retry.\n' +
        `Underlying error: ${err.message}`
    );
    process.exit(1);
  }

  const pages = await browser.pages();
  // Match the exact site origin. A substring test accepts any Moxfield host —
  // including api2 — and a page on the wrong origin gets its fetch rejected by
  // CORS, which surfaces as an unhelpful "failed to fetch".
  let page = pages.find((p) => {
    try {
      return new URL(p.url()).host === 'www.moxfield.com';
    } catch {
      return false;
    }
  });

  if (!page) {
    page = await browser.newPage();
    console.log('Opening moxfield.com to establish session...');
    await page.goto('https://www.moxfield.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    console.log(`Reusing existing tab: ${page.url()}`);
  }

  // Moxfield exposes no session endpoint (verified: every plausible path returns
  // 404), so there is nothing to probe for login state. What actually matters is
  // whether the API is reachable from this page at all — a Cloudflare block shows
  // up here first, and failing early is much clearer than twenty confusing errors.
  console.log('\nChecking Moxfield API reachability...');
  try {
    await api.apiGetInPage(page, '/v2/decks/search-sfw?pageSize=1');
    console.log('API reachable.');
  } catch (err) {
    console.error(
      `Cannot reach the Moxfield API from this browser: ${err.message}\n` +
        'This usually means Cloudflare is blocking the request. Make sure Chrome is\n' +
        'running with a visible window (not headless) and that moxfield.com loads\n' +
        'normally when you open it manually.'
    );
    await browser.disconnect();
    process.exit(1);
  }

  console.log(`\nFetching decks for "${opts.user}"...`);
  let decks;
  try {
    decks = await api.fetchUserDecks(page, opts.user);
  } catch (err) {
    console.error(`Deck discovery failed: ${err.message}`);
    await browser.disconnect();
    process.exit(1);
  }

  console.log(`Found ${decks.length} decks.`);

  const selected = opts.allFormats
    ? decks
    : decks.filter((d) => d.format === 'commander');
  console.log(
    `Pricing ${selected.length}${opts.allFormats ? '' : ' commander'} decks ` +
      `via ${api.VENDORS[vendor].label}.\n`
  );

  const runData = {
    date: localTimestamp(),
    user: opts.user,
    vendor,
    prices: {},
    images: {},
    deckIds: {},
    formats: {},
    vendors: {},
    missing: {},
  };

  for (const d of selected) {
    try {
      const deck = await api.fetchDeck(page, d.publicId);

      // Every vendor's total is stored, so switching the dropdown later is a
      // read rather than a re-scrape. `prices` holds the chosen one, which is
      // what the dashboard uses by default.
      const values = api.allVendorValues(deck);
      runData.vendors[d.name] = values;
      runData.prices[d.name] = values[vendor];

      runData.deckIds[d.name] = d.publicId;
      runData.formats[d.name] = d.format;

      const images = await api.commanderImages(page, deck);
      if (images.length > 0) runData.images[d.name] = images;

      const cardCount = Object.keys(deck.mainboard || {}).length;
      console.log(
        `  ${d.name.slice(0, 40).padEnd(40)} $${values[vendor].toFixed(2).padStart(9)}` +
          `  (${cardCount} cards, ${images.length} img)`
      );
    } catch (err) {
      // Record the failure explicitly instead of silently writing 0.00.
      // A zero would be indistinguishable from a deck that is genuinely worthless.
      runData.missing[d.name] = err.message;
      console.log(`  ${d.name.slice(0, 40).padEnd(40)} FAILED: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  await browser.disconnect();

  const priced = Object.keys(runData.prices).length;
  const failed = Object.keys(runData.missing).length;

  if (priced === 0) {
    console.error('\nNo decks were priced. Nothing written to MongoDB.');
    process.exit(1);
  }

  console.log(`\nSaving snapshot: ${priced} priced, ${failed} failed...`);
  const client = new MongoClient(MONGO_URL);
  try {
    await client.connect();
    const db = client.db(DB_NAME);

    const sync = await registry.syncDecks(db, opts.user, selected);
    console.log(
      `Registry: ${sync.total} tracked ` +
        `(${sync.added} new, ${sync.updated} changed, ${sync.deactivated} deactivated).`
    );

    const result = await db.collection('price_logs').insertOne(runData);
    console.log(`Saved as ${result.insertedId}.`);
  } catch (err) {
    console.error(`MongoDB write failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})().catch((err) => {
  console.error(`Unexpected failure: ${err.message}`);
  process.exit(1);
});
