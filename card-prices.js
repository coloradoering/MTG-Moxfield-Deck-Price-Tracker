const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

const CACHE_DIR = path.join(__dirname, 'scryfall-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'default-cards.jsonl');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// ---------- Scryfall cache ----------
async function ensureScryfallCache() {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    if (fs.existsSync(CACHE_FILE)) {
        const age = Date.now() - fs.statSync(CACHE_FILE).mtimeMs;
        if (age < CACHE_MAX_AGE_MS) {
            console.log(`📦 Using cached Scryfall data (${Math.round(age / 1000 / 60)}m old)`);
            return;
        }
    }

    console.log('📥 Downloading Scryfall Default Cards bulk file...');
    const metaRes = await fetch('https://api.scryfall.com/bulk-data/default_cards', {
        headers: { 'User-Agent': 'MTG-Deck-Tracker/1.0', 'Accept': 'application/json' }
    });
    const meta = await metaRes.json();
    const downloadUrl = meta.jsonl_download_uri;

    const res = await fetch(downloadUrl, { headers: { 'User-Agent': 'MTG-Deck-Tracker/1.0' } });
    if (!res.ok) throw new Error(`Bulk download failed: ${res.status}`);

    const gz = Buffer.from(await res.arrayBuffer());
    const jsonl = zlib.gunzipSync(gz);
    fs.writeFileSync(CACHE_FILE, jsonl);
    console.log(`✅ Cached ${(jsonl.length / 1e6).toFixed(1)} MB of card data`);
}

async function buildPriceLookup() {
    const lookup = new Map();
    const rl = readline.createInterface({
        input: fs.createReadStream(CACHE_FILE),
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const card = JSON.parse(line);
            if (!card.prices?.usd) continue;
            const price = parseFloat(card.prices.usd);
            if (!isFinite(price) || price <= 0) continue;

            // Key by printing UUID (exact)
            if (card.id) lookup.set(card.id, price);

            // Also key by name (cheapest printing, fallback only)
            if (card.name) {
                const nameKey = 'name:' + card.name.toLowerCase();
                const existing = lookup.get(nameKey);
                if (existing === undefined || price < existing) {
                    lookup.set(nameKey, price);
                }
            }
        } catch { /* skip malformed */ }
    }
    console.log(`🔍 Indexed ${lookup.size} entries with USD prices`);
    return lookup;
}

// ---------- Archidekt ----------
async function fetchArchidektCards(url) {
    const id = url.match(/archidekt\.com\/decks\/(\d+)/)?.[1];
    if (!id) throw new Error('Bad Archidekt URL');

    const res = await fetch(`https://archidekt.com/api/decks/${id}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`Archidekt API ${res.status}`);
    const data = await res.json();

    return (data.cards || []).map(entry => {
        const card = entry.card || {};
        return {
            name: card.oracleCard?.name || card.name || null,
            quantity: entry.quantity || 1,
            usd: card.prices?.tcg ?? null
        };
    }).filter(c => c.name);
}

// ---------- Moxfield ----------
async function fetchMoxfieldCards(url) {
    const id = url.match(/moxfield\.com\/decks\/([^/?#]+)/)?.[1];
    if (!id) throw new Error('Bad Moxfield URL');

    const res = await fetch(`https://api2.moxfield.com/v3/decks/all/${id}`, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json'
        }
    });
    if (!res.ok) throw new Error(`Moxfield API ${res.status}`);
    const data = await res.json();

    const cards = [];
    for (const entry of Object.values(data.boards?.commanders?.cards || {})) {
        const c = entry.card;
        if (c?.name) cards.push({ name: c.name, quantity: entry.quantity || 1, scryfallId: c.scryfall_id });
    }
    for (const entry of Object.values(data.boards?.mainboard?.cards || {})) {
        const c = entry.card;
        if (c?.name) cards.push({ name: c.name, quantity: entry.quantity || 1, scryfallId: c.scryfall_id });
    }
    return cards;
}

// ---------- Main ----------
async function scrapeCardPrices() {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(DB_NAME);

    const decks = await db.collection('decks').find().toArray();
    if (decks.length === 0) {
        await client.close();
        throw new Error('No decks in database.');
    }

    const hasMoxfieldDecks = decks.some(d =>
        (d.source || (/archidekt\.com/i.test(d.url || '') ? 'archidekt' : 'moxfield')) === 'moxfield'
    );

    let priceLookup = null;
    if (hasMoxfieldDecks) {
        await ensureScryfallCache();
        priceLookup = await buildPriceLookup();
    } else {
        console.log('ℹ️  No Moxfield decks — skipping Scryfall download.');
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const runData = { date: timestamp, decks: {} };

    for (const deck of decks) {
        if (!deck.url) {
            console.log(`⚠️ Skipping "${deck.name}" — no URL`);
            continue;
        }
        const source = deck.source || (/archidekt\.com/i.test(deck.url) ? 'archidekt' : 'moxfield');
        try {
            console.log(`🃏 [${source}] ${deck.name}...`);

            let cards;
            if (source === 'archidekt') {
                cards = await fetchArchidektCards(deck.url);
            } else {
                cards = await fetchMoxfieldCards(deck.url);
            }

            const priced = {};
            let unmatched = 0;
            for (const { name, quantity, usd: directUsd, scryfallId } of cards) {
                let usd = directUsd;
                if (usd == null && scryfallId && priceLookup) {
                    usd = priceLookup.get(scryfallId);
                }
                if (usd == null && priceLookup && name) {
                    usd = priceLookup.get('name:' + name.toLowerCase());
                }
                if (usd != null) {
                    priced[name] = { usd, quantity };
                } else {
                    unmatched++;
                }
            }

            runData.decks[deck.name] = priced;
            console.log(`   ✅ ${Object.keys(priced).length} cards priced, ${unmatched} unmatched`);
        } catch (err) {
            console.log(`   ❌ ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 300));
    }

    await db.collection('card_prices').insertOne(runData);
    await client.close();
    console.log('✅ Card price snapshot saved');
    return runData;
}

module.exports = { scrapeCardPrices };