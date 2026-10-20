const { MongoClient } = require('mongodb');
const decks = require('./decks');

(async () => {
    const client = new MongoClient('mongodb://localhost:27017');
    await client.connect();
    const db = client.db('moxfield_tracker');
    const col = db.collection('decks');

    const existing = await col.countDocuments();
    if (existing > 0) {
        console.log(`Decks collection already has ${existing} entries. Skipping migration.`);
        console.log('Delete them first with: db.decks.deleteMany({}) if you want to re-migrate.');
        await client.close();
        return;
    }

    if (decks.length > 0) {
        await col.insertMany(decks.map(d => ({ name: d.name, url: d.url })));
    }

    console.log(`✅ Migrated ${decks.length} decks into the database.`);
    await client.close();
})();