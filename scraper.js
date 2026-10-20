const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

function detectSource(url) {
    if (/moxfield\.com\/decks\//i.test(url)) return 'moxfield';
    if (/archidekt\.com\/decks\//i.test(url)) return 'archidekt';
    return 'moxfield';
}

// ---------- Moxfield ----------
async function getMoxfieldPrice(page) {
    await page.waitForSelector('#shoppingcart', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 50));
    return await page.$eval('#shoppingcart', el => {
        const match = el.innerText.match(/\$[\d,]+\.\d{2}/);
        return match ? parseFloat(match[0].replace(/[$,]/g, '')) : 0;
    });
}

async function getMoxfieldImages(page) {
    return await page.evaluate(async () => {
        let hashes = [];
        for (const ul of document.querySelectorAll('ul')) {
            if (!ul.querySelector('li a span[title="Commander"]')) continue;
            hashes = [...ul.querySelectorAll('li[data-hash]')]
                .map(li => li.getAttribute('data-hash'))
                .filter(Boolean);
            break;
        }

        const srcByHash = {};
        for (const img of document.querySelectorAll('.deckview-image-wrapper img.img-card.front')) {
            if (!img.src) continue;
            const m = img.src.match(/card-(?:face-)?([A-Za-z0-9]+)-normal/);
            if (m && !srcByHash[m[1]]) srcByHash[m[1]] = img.src;
        }

        if (hashes.length > 0) {
            const out = [];
            for (const h of hashes) {
                if (srcByHash[h]) { out.push(srcByHash[h]); continue; }
                const normal = `https://assets.moxfield.net/cards/card-${h}-normal.webp`;
                const face = `https://assets.moxfield.net/cards/card-face-${h}-normal.webp`;
                const [normalOk, faceOk] = await Promise.all([
                    fetch(normal, { method: 'HEAD' }).then(r => r.ok).catch(() => false),
                    fetch(face, { method: 'HEAD' }).then(r => r.ok).catch(() => false),
                ]);
                if (normalOk) out.push(normal);
                else if (faceOk) out.push(face);
            }
            if (out.length > 0) return out;
        }

        const front = document.querySelector('.deckview-image-wrapper img.img-card.front');
        if (front && front.src) return [front.src];
        return [];
    });
}

// ---------- Archidekt ----------
async function getArchidektPrice(page) {
    await page.waitForSelector('button[class*="deckPrice_trigger"]', { timeout: 15000 });
    await new Promise(r => setTimeout(r, 15));
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
        const first = imgs[0];
        return first?.src ? [first.src] : [];
    });
}

// ---------- main ----------
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
        throw new Error('No decks in database. Add some from the dashboard first.');
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

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const runData = { date: timestamp, prices: {}, images: {} };

    const total = decks.length;
    let i = 0;

    for (const deck of decks) {
        i++;
        // Legacy decks have no `source` — derive from URL
        const source = deck.source || detectSource(deck.url);

        try {
            log(`[${i}/${total}] ${deck.name} (${source})...`);

            const pages = await browser.pages();
            let page = pages.find(p => {
                try { return p.url() && !p.url().startsWith('devtools://'); }
                catch { return false; }
            }) || pages[0];
            if (!page) page = await browser.newPage();

            await page.goto(deck.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            let price = 0;
            let images = [];

            if (source === 'archidekt') {
                price = await getArchidektPrice(page);
                log(`   -> $${price.toFixed(2)}`);
                try {
                    images = await getArchidektImages(page);
                } catch (imgErr) {
                    log(`   ⚠️ Image scrape skipped: ${imgErr.message}`);
                }
            } else {
                price = await getMoxfieldPrice(page);
                log(`   -> $${price.toFixed(2)}`);

                await new Promise(r => setTimeout(r, 50));
                const pagesAfter = await browser.pages();
                const freshPage = pagesAfter.find(p => {
                    try { return p.url().includes(deck.url.split('/decks/')[1]); }
                    catch { return false; }
                });
                if (freshPage) {
                    try {
                        images = await getMoxfieldImages(freshPage);
                    } catch (imgErr) {
                        log(`   ⚠️ Image scrape skipped: ${imgErr.message}`);
                    }
                }
            }

            runData.prices[deck.name] = price;
            if (images.length > 0) {
                runData.images[deck.name] = images;
                log(`   🎨 ${images.length} image${images.length > 1 ? 's' : ''}`);
            } else {
                log(`   ⚠️ No images`);
            }
        } catch (err) {
            log(`   ❌ Error on ${deck.name}: ${err.message}`);
            runData.prices[deck.name] = 0.00;
        }

        await new Promise(r => setTimeout(r, 15));
    }

    await browser.disconnect();

    log("🍃 Saving...");
    await db.collection('price_logs').insertOne(runData);
    await client.close();

    log("✅ Done");
    return runData;
}

module.exports = { scrapePrices };