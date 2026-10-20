const express = require('express');
const { MongoClient } = require('mongodb');
const registry = require('./deck-registry');
const { VENDORS, DEFAULT_VENDOR, resolveVendor } = require('./moxfield-api');
const { colorFor } = require('./colors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moxfield_tracker';

app.use(express.static('public'));

/** Mongo used to be opened and closed inline in every handler. */
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
 * Newer snapshots carry a `vendors` map with every storefront's total, so the
 * value is just a lookup. Older ones only have `prices`, which came from the
 * deck page's displayed total — that was whatever storefront the browser had
 * selected, in practice Card Kingdom. Those are reported under their real
 * vendor instead of being mislabelled as TCGplayer.
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

app.get('/api/history', async (req, res) => {
  try {
    const vendor = resolveVendor(req.query.vendor);
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
    const vendor = resolveVendor(req.query.vendor);
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

/** Available storefronts, for the dashboard dropdown. */
app.get('/api/vendors', (req, res) => {
  res.json({
    default: DEFAULT_VENDOR,
    vendors: Object.entries(VENDORS).map(([key, v]) => ({ key, label: v.label })),
  });
});

/** Tracked decks come from the registry collection, not from a hardcoded list. */
app.get('/api/decks', async (req, res) => {
  try {
    const user = req.query.user || null;
    const { decks, latest } = await withDb(async (db) => {
      const users = user ? [user] : await registry.listUsers(db);
      const all = [];
      for (const u of users) {
        all.push(...(await registry.listDecks(db, u)));
      }
      const snap = await db.collection('price_logs').findOne({}, { sort: { date: -1 } });
      return { decks: all, latest: snap };
    });

    res.json(
      decks.map((d) => ({
        name: d.name,
        user: d.user,
        publicId: d.publicId,
        format: d.format,
        color: colorFor(d.name),
        url: `https://moxfield.com/decks/${d.publicId}`,
        image: latest?.images?.[d.name]?.[0] || null,
      }))
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
