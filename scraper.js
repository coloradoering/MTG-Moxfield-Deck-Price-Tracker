const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

function detectSource(url) {
    if (/moxfield\.com\/decks\//i.test(url)) return 'moxfield';
    if (/archidekt\.com\/decks\//i.test(url)) return 'archidekt';
    return 'moxfield';
}

/**
 * Pick the correct price for a printing based on its finish.
 * Handles foil-only / etched-only cards where `usd` is absent.
 */
function pickPrice(prices, { isFoil, isEtched }) {
    prices = prices || {};
    const n = (v) => {
        const p = parseFloat(v);
        return Number.isFinite(p) ? p : null;
    };

    if (isEtched) {
        return n(prices.usd_etched)
            ?? n(prices.usd_foil)
            ?? n(prices.usd)
            ?? n(prices.ck_etched)
            ?? n(prices.ck_foil)
            ?? n(prices.ck)
            ?? 0;
    }
    if (isFoil) {
        return n(prices.usd_foil)
            ?? n(prices.usd)
            ?? n(prices.ck_foil)
            ?? n(prices.ck)
            ?? 0;
    }
    return n(prices.usd)
        ?? n(prices.ck)
        ?? 0;
}

async function getMoxfieldDeckData(page, deckUrl) {
    const deckId = deckUrl.match(/moxfield\.com\/decks\/([^/?#]+)/)?.[1];
    if (!deckId) throw new Error('Bad Moxfield URL');

    const data = await page.evaluate(async (id) => {
        const res = await fetch(`https://api2.moxfield.com/v3/decks/all/${id}`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) return { error: `API ${res.status}` };
        return res.json();
    }, deckId);

    if (data.error) throw new Error(data.error);

    let total = 0;
    const images = [];
    const cards = {};

    for (const boardName of ['commanders', 'companions', 'mainboard', 'sideboard']) {
        const board = data.boards?.[boardName]?.cards || {};
        for (const entry of Object.values(board)) {
            const card = entry.card;
            if (!card) continue;

            const cardKey = card.id || card.scryfall_id || card.name;
            if (!cards[cardKey]) {
                cards[cardKey] = {
                    name: card.name,
                    usd: 0,
                    quantity: 0,
                    lineTotal: 0,
                    printings: []
                };
            }

            // Prefer printingData: it is the per-copy truth for what is owned.
            const printings = Array.isArray(entry.printingData) && entry.printingData.length > 0
                ? entry.printingData
                : [entry];

            for (let i = 0; i < printings.length; i++) {
                const printing = printings[i];
                const qty = printing.quantity || entry.quantity || 1;
                const finish = printing.finish || entry.finish || 'nonFoil';
                const isEtched = finish === 'etched';
                const isFoil = finish === 'foil' || printing.isFoil === true || entry.isFoil === true;

                const prices =
                    printing.card?.prices ||
                    printing.prices ||
                    card.prices ||
                    {};

                const price = pickPrice(prices, { isFoil, isEtched });
                const lineTotal = price * qty;

                total += lineTotal;

                const rec = cards[cardKey];
                rec.quantity += qty;
                rec.lineTotal += lineTotal;
                rec.printings.push({
                    finish,
                    isFoil,
                    isEtched,
                    quantity: qty,
                    unitPrice: price,
                    lineTotal,
                    cardId: printing.card?.id || card.id,
                    scryfall_id: printing.card?.scryfall_id || card.scryfall_id
                });

                if (i === 0) rec.usd = price;
            }

            if (boardName === 'commanders' && card.scryfall_id && images.length < 2) {
                const id = card.scryfall_id;
                images.push(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`);
            }
        }
    }

    for (const rec of Object.values(cards)) {
        rec.usd = Math.round(rec.usd * 100) / 100;
        rec.lineTotal = Math.round(rec.lineTotal * 100) / 100;
    }

    return { price: Math.round(total * 100) / 100, images, cards };
}

async function getArchidektPrice(page) {
    await page.waitForSelector('button[class*="deckPrice_trigger"]', { timeout: 20000 });
    await new Promise(r => setTimeout(r, 200));
    return await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')]
            .find(b => /Est cost:/i.test(b.textContent));
        if (!btn) return 0;
        const match = btn.textContent.match(/\$[\d,]+\.\d{2}/);
        return match ? parseFloat(match[0].replace(/[$,]/g, '')) : 0;
    });
}

async function getArchidektImages(page) {
    return await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('img[src*="card-images.archidekt.com/grid/front"]')];
        if (imgs.length === 0) return [];
        return imgs[0]?.src ? [imgs[0].src] : [];
    });
}

async function scrapePrices({ onProgress } = {}) {
    const log = (msg) => {
        console.log(msg);
        if (onProgress) onProgress(msg);
    };

    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(DB_NAME);

    const decks = await db.collection('decks').find().toArray();
    if (decks.length === 0) {
        await client.close();
        throw new Error('No decks in database.');
    }

    log("🔌 Connecting to Chrome...");
    let browser;
    try {
        browser = await puppeteer.connect({
            browserURL: 'http://localhost:9222',
            defaultViewport: null
        });
    } catch (e) {
        await client.close();
        throw new Error('Cannot connect to Chrome. Make sure Chrome is running with --remote-debugging-port=9222.');
    }

    const pages = await browser.pages();
    let page = pages.find(p => {
        try { return p.url() && !p.url().startsWith('devtools://'); }
        catch { return false; }
    }) || pages[0];
    if (!page) page = await browser.newPage();

    const hasMoxfield = decks.some(d => detectSource(d.url) === 'moxfield');
    if (hasMoxfield && !page.url().includes('moxfield.com')) {
        log("🌐 Navigating to Moxfield...");
        await page.goto('https://www.moxfield.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 800));
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const runData = { date: timestamp, prices: {}, images: {} };
    const cardRunData = { date: timestamp, decks: {} };

    const total = decks.length;
    let i = 0;

    for (const deck of decks) {
        i++;
        const src = detectSource(deck.url);
        try {
            log(`[${i}/${total}] ${deck.name} (${src})...`);

            if (src === 'moxfield') {
                const { price, images, cards } = await getMoxfieldDeckData(page, deck.url);
                runData.prices[deck.name] = price;
                if (images.length > 0) runData.images[deck.name] = images;
                if (cards && Object.keys(cards).length > 0) cardRunData.decks[deck.name] = cards;
                log(`   ✅ -> $${price.toFixed(2)}`);
            } else {
                await page.goto(deck.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                const price = await getArchidektPrice(page);
                runData.prices[deck.name] = price;
                log(`   ✅ -> $${price.toFixed(2)}`);
                try {
                    const images = await getArchidektImages(page);
                    if (images.length > 0) runData.images[deck.name] = images;
                } catch {}
            }
        } catch (err) {
            log(`   ❌ ${err.message}`);
            runData.prices[deck.name] = 0.00;
        }
    }

    await browser.disconnect();

    log("🍃 Saving...");
    await db.collection('price_logs').insertOne(runData);

    if (Object.keys(cardRunData.decks).length > 0) {
        await db.collection('card_prices').insertOne(cardRunData);
    }

    await client.close();

    log("✅ Done");
    return runData;
}

module.exports = { scrapePrices };