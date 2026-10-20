const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'moxfield_tracker';

function localDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

(async () => {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const col = client.db(DB_NAME).collection('price_logs');

    const today = localDateString();
    const result = await col.deleteMany({ date: { $regex: `^${today}` } });
    console.log(`Deleted ${result.deletedCount} entry/entries for ${today}.`);

    await client.close();
})();