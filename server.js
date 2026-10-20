const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const { spawn } = require('child_process');

const registry = require('./deck-registry');
const api = require('./moxfield-api');
const { colorFor } = require('./colors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moxfield_tracker';
const DEFAULT_USER = process.env.MOXFIELD_USER || null;

app.use(express.json());

// Static assets, with no-cache on HTML so a code change is never masked by a
// stale page in the browser. Everything else can cache normally.
app.use(
  express.static('public', {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

async function withDb(fn) {
  const client = new MongoClient(MONGO_URL);
  try {
    await client.connect();
    return await fn(client.db(DB_NAME));
  } finally {
    await client.close();
  }
}

/** Snapshots may predate the `vendor` field; those were scraped as Card Kingdom. */
const LEGACY_VENDOR = 'cardkingdom';

/**
 * Reduce a snapshot to one vendor's totals.
 *
 * Newer snapshots carry a `vendors` map with every storefront's total. Older
 * ones only have `prices`, taken from the deck page's displayed total, which was
 * whatever storefront the browser had selected — in practice Card Kingdom.
 */
function pricesForVendor(snapshot, vendor) {
  if (snapshot.vendors) {
    const out = {};
    for (const [name, values] of Object.entries(snapshot.vendors)) {
      if (typeof values[vendor] === 'number') out[name] = values[vendor];
    }
    return out;
  }
  const snapVendor = snapshot.vendor || LEGACY_VENDOR;
  return snapVendor === vendor ? snapshot.prices || {} : {};
}

/** Which Moxfield user this install tracks, if any. */
async function currentUser(db) {
  const pref = await db.collection('settings').findOne({ _id: 'prefs' });
  return pref?.moxfieldUser || DEFAULT_USER || null;
}

// ---------------------------------------------------------------- tracking user

app.get('/api/user', async (req, res) => {
  try {
    const user = await withDb(currentUser);
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Set the tracked Moxfield user and import their decks.
 *
 * This replaces the old manual "add a deck by URL" flow entirely: the username
 * is the only input, and the deck list is whatever that profile publishes. When
 * the username changes, the previous user's decks are deactivated rather than
 * deleted, so their price history survives.
 */
app.post('/api/user', async (req, res) => {
  const user = String((req.body && req.body.username) || '').trim();
  if (!user) return res.status(400).json({ error: 'Username is required.' });
  if (!/^[\w.\-]{1,64}$/.test(user)) {
    return res.status(400).json({ error: 'That is not a valid Moxfield username.' });
  }

  try {
    const result = await withDb(async (db) => {
      const previous = await currentUser(db);

      // Import needs a browser to talk to Moxfield's API, so reuse the scraper's
      // connection path rather than opening a second one here.
      const decks = await api.discoverDecks(user);
      if (decks.length === 0) {
        throw new Error(
          `No public decks found for "${user}". Check the username, and that the profile is public.`
        );
      }

      await db
        .collection('settings')
        .updateOne({ _id: 'prefs' }, { $set: { moxfieldUser: user } }, { upsert: true });

      let synced = null;
      if (previous !== user) {
        synced = await registry.syncDecks(db, user, decks);
      }

      return { previous, count: decks.length, synced };
    });

    res.json({ ok: true, user, decks: result.count, previous: result.previous, synced: result.synced });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- dashboard data

app.get('/api/history', async (req, res) => {
  try {
    const vendor = api.resolveVendor(req.query.vendor);
    const history = await withDb((db) =>
      db.collection('price_logs').find().sort({ date: 1 }).toArray()
    );
    res.json(
      history.map((snap) => ({
        date: snap.date,
        user: snap.user,
        vendor,
        prices: pricesForVendor(snap, vendor),
        images: snap.images || {},
      }))
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const vendor = api.resolveVendor(req.query.vendor);
    const latest = await withDb((db) =>
      db.collection('price_logs').findOne({}, { sort: { date: -1 } })
    );
    if (!latest) return res.json(null);
    res.json({
      date: latest.date,
      user: latest.user,
      vendor,
      prices: pricesForVendor(latest, vendor),
      images: latest.images || {},
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/vendors', (req, res) => {
  res.json({
    default: api.DEFAULT_VENDOR,
    vendors: Object.entries(api.VENDORS).map(([key, v]) => ({ key, label: v.label })),
  });
});

/** Tracked decks come from the registry collection, not from a hardcoded list. */
app.get('/api/decks', async (req, res) => {
  try {
    // Default to the tracked user. Listing every user ever seen would show decks
    // the dashboard is not currently tracking, which contradicts the username
    // control above it.
    const tracked = req.query.user || (await withDb(currentUser));
    const vendor = api.resolveVendor(req.query.vendor);

    const { decks, latest, fallback } = await withDb(async (db) => {
      const users = tracked ? [tracked] : await registry.listUsers(db);
      const all = [];
      for (const u of users) {
        all.push(...(await registry.listDecks(db, u)));
      }
      const snap = await db.collection('price_logs').findOne({}, { sort: { date: -1 } });

      // The registry is populated by the scraper. If someone upgrades the code
      // without re-scraping it is empty, and the dashboard would show nothing at
      // all despite having a full price history. Degrade instead of going blank.
      if (all.length === 0 && snap) {
        const names = new Set([
          ...Object.keys(pricesForVendor(snap, vendor)),
          ...Object.keys(snap.prices || {}),
        ]);
        const derived = [...names].map((name) => ({
          name,
          user: snap.user || null,
          publicId: snap.deckIds?.[name] || null,
          format: snap.formats?.[name] || null,
          active: true,
        }));
        return { decks: derived, latest: snap, fallback: true };
      }

      return { decks: all, latest: snap, fallback: false };
    });

    res.json({
      decks: decks.map((d) => ({
        name: d.name,
        user: d.user,
        publicId: d.publicId,
        format: d.format,
        color: colorFor(d.name),
        url: d.publicId ? `https://moxfield.com/decks/${d.publicId}` : null,
        image: latest?.images?.[d.name]?.[0] || null,
      })),
      source: fallback ? 'price_logs' : 'registry',
      vendor,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------- scrape / scrub

let scrapeRunning = false;
let scrapeProgress = '';

app.post('/api/scrape', async (req, res) => {
  if (scrapeRunning) return res.status(409).json({ error: 'Scrape already in progress.' });
  scrapeRunning = true;
  scrapeProgress = 'starting';
  try {
    const result = await runScrape((msg) => {
      scrapeProgress = msg;
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    scrapeRunning = false;
    scrapeProgress = '';
  }
});

app.get('/api/scrape/status', (req, res) =>
  res.json({ running: scrapeRunning, message: scrapeProgress })
);

app.post('/api/scrub', async (req, res) => {
  const { date } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
    return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
  }
  try {
    const result = await withDb((db) =>
      db.collection('price_logs').deleteMany({ date: { $regex: `^${date}` } })
    );
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * Run the scraper in-process.
 *
 * Deliberately shells out to run.js rather than importing it: run.js drives a
 * real browser and calls process.exit, and a failed scrape should never take the
 * dashboard down with it.
 */
function runScrape(onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['run.js'], {
      cwd: __dirname,
      env: process.env,
    });
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
      const line = out.trim().split('\n').pop();
      if (line) onProgress(line.trim());
    });
    child.stderr.on('data', (b) => {
      out += b.toString();
    });
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(out.trim().split('\n').slice(-4).join(' ')));
      const m = out.match(/Saved as (.+?)\./);
      const priced = out.match(/(\d+) priced/);
      resolve({ date: m ? m[1] : null, decks: priced ? Number(priced[1]) : null });
    });
  });
}

app.listen(PORT, () => {
  console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
