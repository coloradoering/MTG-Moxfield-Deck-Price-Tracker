const express = require('express');
const { MongoClient } = require('mongodb');
const { colorFor } = require('./decks');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moxfield_tracker';

app.use(express.static('public'));

/** Mongo moved out of this file because it was repeated in every handler. */
async function withDb(fn) {
  const client = new MongoClient(MONGO_URL);
  try {
    await client.connect();
    return await fn(client.db(DB_NAME));
  } finally {
    await client.close();
  }
}

app.get('/api/history', async (req, res) => {
  try {
    const history = await withDb((db) =>
      db.collection('price_logs').find().sort({ date: 1 }).toArray()
    );
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/latest', async (req, res) => {
  try {
    const latest = await withDb((db) =>
      db.collection('price_logs').findOne({}, { sort: { date: -1 } })
    );
    res.json(latest);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Deck metadata for the UI.
 *
 * The deck list is derived from the most recent snapshot's prices rather than
 * from a hardcoded file, so it always matches what was actually scraped. Colours
 * are hashed from the deck name, which keeps a deck's colour stable when the
 * collection changes.
 */
app.get('/api/decks', async (req, res) => {
  try {
    const latest = await withDb((db) =>
      db.collection('price_logs').findOne({}, { sort: { date: -1 } })
    );

    if (!latest) return res.json([]);

    const deckList = Object.keys(latest.prices || {}).map((name) => ({
      name,
      color: colorFor(name),
      url: `https://moxfield.com/decks/${latest.deckIds?.[name] ?? ''}`,
      image: latest.images?.[name] || null,
    }));

    res.json(deckList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});
