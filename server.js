const express = require('express');
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { scrapePrices } = require('./scraper');

const app = express();
const PORT = 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

app.use(express.static('public'));
app.use(express.json());
app.use('/fonts-beleren', express.static(path.join(__dirname, 'node_modules/@saeris/typeface-beleren-bold')));

async function withDb(fn) {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    try { return await fn(client.db(DB_NAME)); }
    finally { await client.close(); }
}

const COLORS = [
    '#f43f5e', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
    '#ec4899', '#06b6d4', '#84cc16', '#eab308', '#6366f1',
    '#14b8a6', '#f97316', '#a855f7', '#22c55e', '#e11d48',
    '#0ea5e9', '#d946ef', '#ef4444'
];

function detectSource(url) {
    if (/moxfield\.com\/decks\//i.test(url)) return 'moxfield';
    if (/archidekt\.com\/decks\//i.test(url)) return 'archidekt';
    return null;
}

// ---- history ----
app.get('/api/history', async (req, res) => {
    try {
        const history = await withDb(db => db.collection('price_logs').find().sort({ date: 1 }).toArray());
        res.json(history);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- decks ----
app.get('/api/decks', async (req, res) => {
    try {
        const [latest, decks] = await withDb(async db => {
            const latest = await db.collection('price_logs').findOne({}, { sort: { date: -1 } });
            const decks = await db.collection('decks').find().sort({ _id: 1 }).toArray();
            return [latest, decks];
        });

        const list = decks.map((d, i) => ({
            name: d.name,
            url: d.url,
            source: d.source || detectSource(d.url) || 'moxfield',
            color: COLORS[i % COLORS.length],
            image: latest?.images?.[d.name] || null
        }));

        res.json(list);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/decks', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: 'Name and URL are required.' });

    const source = detectSource(url);
    if (!source) {
        return res.status(400).json({ error: 'URL must be a Moxfield or Archidekt deck link.' });
    }

    try {
        await withDb(async db => {
            const existing = await db.collection('decks').findOne({ name });
            if (existing) throw new Error(`A deck named "${name}" already exists.`);
            await db.collection('decks').insertOne({
                name: name.trim(),
                url: url.trim(),
                source
            });
        });
        res.json({ ok: true, source });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/decks/:name', async (req, res) => {
    try {
        const name = decodeURIComponent(req.params.name);
        await withDb(db => db.collection('decks').deleteOne({ name }));
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/card-history/:deckName', async (req, res) => {
    try {
        const deckName = decodeURIComponent(req.params.deckName);
        const history = await withDb(db =>
            db.collection('card_prices')
                .find({ [`decks.${deckName}`]: { $exists: true } })
                .sort({ date: 1 })
                .toArray()
        );

        const formatted = history.map(h => ({
            date: h.date,
            cards: h.decks[deckName] || {}
        }));

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ---- scrape ----
let scrapeRunning = false;
app.post('/api/scrape', async (req, res) => {
    if (scrapeRunning) return res.status(409).json({ error: 'Scrape already in progress.' });
    scrapeRunning = true;
    try {
        const chromeReady = await ensureChrome();
        if (!chromeReady) throw new Error('Could not start Chrome. Try again in a few seconds.');
        const data = await scrapePrices();
        res.json({ ok: true, date: data.date, decks: Object.keys(data.prices).length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        scrapeRunning = false;
    }
});
app.get('/api/scrape/status', (req, res) => res.json({ running: scrapeRunning }));

// ---- scrub ----
app.post('/api/scrub', async (req, res) => {
    const { date } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}/.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }
    try {
        const result = await withDb(async db => {
            const prices = await db.collection('price_logs').deleteMany({ date: { $regex: `^${date}` } });
            const cards = await db.collection('card_prices').deleteMany({ date: { $regex: `^${date}` } });
            return { prices: prices.deletedCount, cards: cards.deletedCount };
        });
        res.json({ ok: true, deleted: result.prices + result.cards, prices: result.prices, cards: result.cards });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- launch ----
function launchChrome() {
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome'
    ];
    const chrome = candidates.find(p => fs.existsSync(p));
    if (!chrome) {
        console.warn('⚠️  Chrome not found. Launch manually with --remote-debugging-port=9222');
        return;
    }
    console.log(`🚀 Launching Chrome from ${chrome}`);
    const child = spawn(chrome, [
        '--remote-debugging-port=9222',
        '--user-data-dir=' + path.join(os.homedir(), 'chrome-debug-profile')
    ], {
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
}
async function ensureChrome() {
    // Check if Chrome's debug port is already responding
    try {
        const res = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
            console.log('✅ Chrome already running with debug port');
            return true;
        }
    } catch {
        // Not running — fall through to launch
    }

    console.log('🚀 Launching Chrome...');
    launchChrome();

    // Wait up to 10 seconds for the debug port to come up
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
            const res = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(1000) });
            if (res.ok) {
                console.log('✅ Chrome ready');
                return true;
            }
        } catch { /* keep waiting */ }
    }

    return false;
}

app.listen(PORT, () => {
    console.log(`📊 Dashboard → http://localhost:${PORT}`);
});