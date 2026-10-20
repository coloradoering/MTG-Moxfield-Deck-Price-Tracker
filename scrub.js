const { MongoClient } = require('mongodb');

function localDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

(async () => {
    const client = new MongoClient('mongodb://localhost:27017');
    await client.connect();
    const col = client.db('moxfield_tracker').collection('price_logs');

    const today = localDateString();
    const result = await col.deleteMany({ date: { $regex: `^${today}` } });
    console.log(`Deleted ${result.deletedCount} entry/entries for ${today}.`);

    await client.close();
})();