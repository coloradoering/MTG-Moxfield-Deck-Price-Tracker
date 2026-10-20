const { MongoClient } = require('mongodb');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
const DB_NAME = 'moxfield_tracker';

const decks = [
    "villain kindred",
    "thethiroth", 
    "squallsac",
    "shakira shakira",
    "it just dawned on me",
    "I scry..... you know the drill",
    "heads chaos, tails chaos",
    "can i borrow that?",
    "blight witch",
    "˜\"°•✿•°\"˜ 𝔂𝓾𝓷𝓪 ˜\"°•✿•°\"˜",
    "（︶O︶） 𝔪𝔦𝔩𝔩 （︶-︶）"
];

const currentPrices = {
    "villain kindred": 438.52,
    "thethiroth": 315.27,
    "squallsac": 572.89,
    "shakira shakira": 284.63,
    "it just dawned on me": 651.44,
    "I scry..... you know the drill": 407.18,
    "heads chaos, tails chaos": 346.91,
    "can i borrow that?": 518.35,
    "blight witch": 387.20,
    "˜\"°•✿•°\"˜ 𝔂𝓾𝓷𝓪 ˜\"°•✿•°\"˜": 432.76,
    "（︶O︶） 𝔪𝔦𝔩𝔩 （︶-︶）": 308.15
};

async function seedData() {
    const client = new MongoClient(MONGO_URL);
    await client.connect();
    const db = client.db(DB_NAME);
    
    await db.collection('price_logs').deleteMany({});
    
    const records = [];
    
    // Day 1 (4 days ago) - lowest prices
    const day1 = new Date();
    day1.setDate(day1.getDate() - 4);
    day1.setHours(14, 22, 0, 0);
    
    const day1Prices = {};
    for (let deck of decks) {
        day1Prices[deck] = Math.round((currentPrices[deck] * (Math.random() * 0.03 + 0.94)) * 100) / 100;
    }
    records.push({ 
        date: `${day1.getFullYear()}-${String(day1.getMonth() + 1).padStart(2, '0')}-${String(day1.getDate()).padStart(2, '0')} 14:22`, 
        prices: day1Prices 
    });

    // Day 2 (3 days ago) - slight bump
    const day2 = new Date();
    day2.setDate(day2.getDate() - 3);
    day2.setHours(10, 45, 0, 0);
    
    const day2Prices = {};
    for (let deck of decks) {
        day2Prices[deck] = Math.round((currentPrices[deck] * (Math.random() * 0.04 + 0.95)) * 100) / 100;
    }
    records.push({ 
        date: `${day2.getFullYear()}-${String(day2.getMonth() + 1).padStart(2, '0')}-${String(day2.getDate()).padStart(2, '0')} 10:45`, 
        prices: day2Prices 
    });

    // Day 3 (2 days ago) - small dip
    const day3 = new Date();
    day3.setDate(day3.getDate() - 2);
    day3.setHours(9, 15, 0, 0);
    
    const day3Prices = {};
    for (let deck of decks) {
        day3Prices[deck] = Math.round((currentPrices[deck] * (Math.random() * 0.03 + 0.96)) * 100) / 100;
    }
    records.push({ 
        date: `${day3.getFullYear()}-${String(day3.getMonth() + 1).padStart(2, '0')}-${String(day3.getDate()).padStart(2, '0')} 09:15`, 
        prices: day3Prices 
    });

    // Day 4 (yesterday) - near current
    const day4 = new Date();
    day4.setDate(day4.getDate() - 1);
    day4.setHours(16, 30, 0, 0);
    
    const day4Prices = {};
    for (let deck of decks) {
        day4Prices[deck] = Math.round((currentPrices[deck] * (Math.random() * 0.02 + 0.98)) * 100) / 100;
    }
    records.push({ 
        date: `${day4.getFullYear()}-${String(day4.getMonth() + 1).padStart(2, '0')}-${String(day4.getDate()).padStart(2, '0')} 16:30`, 
        prices: day4Prices 
    });

    // Day 5 (today/current)
    const day5 = new Date();
    day5.setHours(12, 0, 0, 0);
    
    records.push({ 
        date: `${day5.getFullYear()}-${String(day5.getMonth() + 1).padStart(2, '0')}-${String(day5.getDate()).padStart(2, '0')} 12:00`, 
        prices: currentPrices 
    });

    await db.collection('price_logs').insertMany(records);
    console.log(`✅ Inserted ${records.length} mock records`);
    
    await client.close();
}

seedData();