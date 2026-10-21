const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

function detectSource(url) {
    if (/moxfield\.com\/decks\//i.test(url)) return 'moxfield';
    if (/archidekt\.com\/decks\//i.test(url)) return 'archidekt';
    return 'moxfield';
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

            const qty = entry.quantity || 1;
            const isEtched = entry.finish === 'etched';
            const isFoil = entry.finish === 'foil' || entry.isFoil === true;

            let price = 0;
            if (isEtched) {
                price = parseFloat(card.prices?.usd_etched || card.prices?.usd || 0);
            } else if (isFoil) {
                price = parseFloat(card.prices?.usd_foil || card.prices?.usd || 0);
            } else {
                price = parseFloat(card.prices?.usd || 0);
            }
            
            total += price * qty;
            
                        // Use the Moxfield internal ID to distinguish printings.
            // Fallback to scryfall_id, then name.
            const cardKey = card.id || card.scryfall_id || card.name;
            cards[cardKey] = { usd: price, quantity: qty, name: card.name };

            if (boardName === 'commanders' && card.scryfall_id && images.length < 2) {
                const id = card.scryfall_id;
                images.push(`https://cards.scryfall.io/normal/front/${id[0]}/${id[1]}/${id}.jpg`);
            }
        }
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
                if (cards) cardRunData.decks[deck.name] = cards;
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