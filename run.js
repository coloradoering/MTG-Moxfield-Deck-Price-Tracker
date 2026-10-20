const puppeteer = require('puppeteer');
const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

const decks = require('./decks');

async function getCommanderImages(page) {
    return await page.evaluate(async () => {
        // Strategy 1: hashes from the Commander <ul>
        let hashes = [];
        for (const ul of document.querySelectorAll('ul')) {
            if (!ul.querySelector('li a span[title="Commander"]')) continue;
            hashes = [...ul.querySelectorAll('li[data-hash]')]
                .map(li => li.getAttribute('data-hash'))
                .filter(Boolean);
            break;
        }

        // Map hash -> real rendered src (handles card-XXXXX and card-face-XXXXX)
        const srcByHash = {};
        for (const img of document.querySelectorAll('.deckview-image-wrapper img.img-card.front')) {
            if (!img.src) continue;
            const m = img.src.match(/card-(?:face-)?([A-Za-z0-9]+)-normal/);
            if (m && !srcByHash[m[1]]) srcByHash[m[1]] = img.src;
        }

        if (hashes.length > 0) {
            // For each hash: prefer the real src, fall back to trying both URL forms
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

        // Strategy 2: no Commander <ul>, use deck header image
        const front = document.querySelector('.deckview-image-wrapper img.img-card.front');
        if (front && front.src) return [front.src];

        return [];
    });
}
(async () => {
    console.log("🔌 Connecting to Chrome...");
    const browser = await puppeteer.connect({
        browserURL: 'http://localhost:9222',
        defaultViewport: null
    });

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const runData = { date: timestamp, prices: {}, images: {} };

    for (const deck of decks) {
        let page = null;
        try {
            console.log(`Checking: ${deck.name}...`);

            // Always grab a fresh page reference
            const pages = await browser.pages();
            page = pages.find(p => p.url().includes('moxfield.com')) || pages[0];
            if (!page) page = await browser.newPage();

            await page.goto(deck.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForSelector('#shoppingcart', { timeout: 15000 });
            await new Promise(r => setTimeout(r, 1000));

            const marketValue = await page.$eval('#shoppingcart', el => {
                const text = el.innerText;
                const match = text.match(/\$[\d,]+\.\d{2}/);
                return match ? match[0].replace('$', '').replace(/,/g, '') : "0.00";
            });

            runData.prices[deck.name] = parseFloat(marketValue);
            console.log(`   -> $${marketValue}`);

            // Re-acquire page AGAIN before image scrape — Moxfield may have redirected
            const pagesAfter = await browser.pages();
            const freshPage = pagesAfter.find(p => p.url().includes(deck.url.split('/decks/')[1])) || pagesAfter[0];

            const imageUrls = await getCommanderImages(freshPage);
            if (imageUrls.length > 0) {
                runData.images[deck.name] = imageUrls;
                console.log(`   🎨 ${imageUrls.length} commander image${imageUrls.length > 1 ? 's' : ''} found`);
            } else {
                console.log(`   ⚠️ No commander images`);
            }
        } catch (err) {
            console.log(`   ❌ Error on ${deck.name}: ${err.message}`);
            runData.prices[deck.name] = 0.00;
        }

        // Don't hold onto the page — it may be dead next iteration
        page = null;
        await new Promise(r => setTimeout(r, 1000));
    }

    await browser.disconnect();

    console.log("\n🍃 Saving to MongoDB...");
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(DB_NAME);
    await db.collection('price_logs').insertOne(runData);
    await client.close();

    console.log("✅ Done!");
})();