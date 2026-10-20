const express = require('express');
const { MongoClient } = require('mongodb');
const decks = require('./decks');

const app = express();
const PORT = 3000;
const MONGO_URL = 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

app.use(express.static('public'));

app.get('/api/history', async (req, res) => {
    try {
        const client = new MongoClient(MONGO_URL);
        await client.connect();
        const db = client.db(DB_NAME);
        const history = await db.collection('price_logs').find().sort({ date: 1 }).toArray();
        await client.close();
        res.json(history);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/latest', async (req, res) => {
    try {
        const client = new MongoClient(MONGO_URL);
        await client.connect();
        const db = client.db(DB_NAME);
        const latest = await db.collection('price_logs').findOne({}, { sort: { date: -1 } });
        await client.close();
        res.json(latest);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/decks', async (req, res) => {
    try {
        const client = new MongoClient(MONGO_URL);
        await client.connect();
        const db = client.db(DB_NAME);
        const latest = await db.collection('price_logs').findOne({}, { sort: { date: -1 } });
        await client.close();

        if (!latest) return res.json([]);

        const colors = [
            '#f43f5e', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
            '#ec4899', '#06b6d4', '#84cc16', '#eab308', '#6366f1',
            '#14b8a6', '#f97316', '#a855f7', '#22c55e', '#e11d48',
            '#0ea5e9', '#d946ef', '#ef4444'
        ];

        const deckList = decks.map((deck, i) => ({
            name: deck.name,
            color: colors[i % colors.length],
            url: deck.url,
            image: latest.images?.[deck.name] || null
        }));

        res.json(deckList);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`📊 Dashboard running at http://localhost:${PORT}`);
});