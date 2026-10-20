const { scrapePrices } = require('./scraper');

(async () => {
    try {
        const data = await scrapePrices();
        const count = Object.keys(data.prices).length;
        console.log(`\n✅ Recorded ${count} decks at ${data.date}`);
    } catch (err) {
        console.error('❌ Scrape failed:', err.message);
        process.exit(1);
    }
})();