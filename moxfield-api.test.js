const test = require('node:test');
const assert = require('node:assert/strict');
const { cardPriceBreakdown, deckValue } = require('./moxfield-api');

test('uses printingData finish and per-printing prices before entry flags', () => {
  const deck = {
    mainboard: {
      example: {
        quantity: 3,
        finish: 'nonFoil',
        isFoil: true,
        card: {
          name: 'Example Card',
          prices: { usd: '1.00', usd_foil: '2.00' },
        },
        printingData: [
          {
            quantity: 1,
            finish: 'nonFoil',
            card: { prices: { usd: '3.00', usd_foil: '8.00' } },
          },
          {
            quantity: 2,
            finish: 'foil',
            card: { prices: { usd: '3.00', usd_foil: '8.00' } },
          },
        ],
      },
    },
  };

  assert.equal(deckValue(deck, 'tcgplayer'), 19);
});

test('exposes per-card printing rows and vendor totals for card history', () => {
  const cards = cardPriceBreakdown({
    mainboard: {
      example: {
        quantity: 3,
        isFoil: true,
        card: { id: 'oracle-id', name: 'Example Card' },
        printingData: [
          {
            quantity: 1,
            finish: 'nonFoil',
            card: { prices: { usd: '3.00', usd_foil: '8.00' } },
          },
          {
            quantity: 2,
            finish: 'foil',
            card: { prices: { usd: '3.00', usd_foil: '8.00' } },
          },
        ],
      },
    },
  });

  const rows = Object.values(cards).sort((a, b) => a.finish.localeCompare(b.finish));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ finish, quantity, vendors }) => ({
    finish,
    quantity,
    unitPrice: vendors.tcgplayer.unitPrice,
    lineTotal: vendors.tcgplayer.lineTotal,
  })), [
    { finish: 'foil', quantity: 2, unitPrice: 8, lineTotal: 16 },
    { finish: 'nonFoil', quantity: 1, unitPrice: 3, lineTotal: 3 },
  ]);
});

test('handles etched and legacy foil entries while excluding basic lands', () => {
  const deck = {
    mainboard: {
      etched: {
        quantity: 2,
        isFoil: false,
        card: { prices: { usd: '10.00', usd_foil: '12.00', usd_etched: '15.00' } },
        printingData: [{ quantity: 2, isEtched: true }],
      },
      foil: {
        quantity: 2,
        isFoil: true,
        card: { prices: { usd: '1.00', usd_foil: '4.00' } },
      },
      basic: {
        quantity: 20,
        card: { isBasicLand: true, prices: { usd: '100.00' } },
      },
    },
  };

  assert.equal(deckValue(deck, 'tcgplayer'), 38);
});
