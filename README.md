# MTG Moxfield Deck Price Tracker

Tracks the market value of a portfolio of Magic: The Gathering Commander decks over time, and visualizes the price history in a local dashboard.

Prices are read from the `#shoppingcart` element on each deck's public [Moxfield](https://moxfield.com) page. Snapshots are stored in MongoDB and charted with Chart.js.

---

## How it works

```
Moxfield deck pages
        │
        │  scrape (Puppeteer, or requests+BeautifulSoup)
        ▼
   price snapshot  ──►  MongoDB (moxfield_tracker.price_logs)
                              │
                              │  Express API
                              ▼
                     Dashboard (Chart.js)
```

A *snapshot* is one document per scrape run:

```json
{
  "date": "2026-10-20 13:45",
  "prices": { "deck name": 438.52, "another deck": 315.27 },
  "images": { "deck name": ["https://assets.moxfield.net/cards/card-…-normal.webp"] }
}
```

Deck names are joined against the snapshot `prices` keys to render cards and chart lines.

---

## Components

| File | Role |
|---|---|
| `decks.js` | **Source of truth** for which decks are tracked (name + Moxfield URL). |
| `run.js` | Primary scraper. Connects to a Chrome instance over the DevTools protocol, visits each deck, extracts the price and commander art, writes one snapshot to MongoDB. |
| `server.js` | Express server. Serves the dashboard and a small JSON API. Port `3000`. |
| `public/index.html` | Main dashboard UI — stat cards, Chart.js line chart, per-deck cards with prices and day-over-day change, deck preview modal. |
| `dashboard.html` | Static chart. Chart data is **hardcoded** — a snapshot export, not live. |
| `debug.html` | Saved Moxfield page used for reverse-engineering selectors. Not part of the app. |
| `tracker.py` | Alternative scraper. Pure `requests` + BeautifulSoup, no browser. Writes to **Google Sheets** instead of MongoDB. |
| `check_price.py` | Throwaway probe for the Moxfield v2 API shape. |
| `buh.js` | Seed script — inserts **fake** historical data so the dashboard has something to render. |
| `scrub.js` | Deletes all snapshots for the current date, so you can re-run a scrape cleanly. |
| `start-chrome.bat` | Windows helper that launches Chrome with remote debugging on port `9222`. |

---

## Requirements

- **Node.js 18+**
- **MongoDB** running on `localhost:27017`
- **Google Chrome** (for the Puppeteer-based scraper)
- *Optional, for `tracker.py`:* Python 3, `requests`, `beautifulsoup4`, `gspread`, plus a Google service-account `credentials.json`

---

## Quick start

### 1. Start MongoDB

Use the bundled compose file, or any local Mongo instance:

```bash
docker compose up -d mongo
```

### 2. Launch Chrome with remote debugging

The scraper **attaches to an existing Chrome** rather than launching its own. This is deliberate — Moxfield throttles/blocklists headless automation, and a real browser profile gets through.

**Windows:** run `start-chrome.bat`

**Linux/macOS:**

```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/moxfield-chrome
```

Log into Moxfield in that browser window if needed, then leave it open.

### 3. Install dependencies

```bash
npm install
```

> Note: `node_modules/` is currently committed to this repo. You can skip this step unless you're changing dependencies.

### 4. Take a snapshot

```bash
npm run scrape     # runs run.js
```

You'll see per-deck progress:

```
🔌 Connecting to Chrome...
Checking: villain kindred...
   -> $438.52
   🎨 1 commander image found
...
🍃 Saving to MongoDB...
✅ Done!
```

### 5. Start the dashboard

```bash
npm start          # runs server.js
```

Open <http://localhost:3000>.

If the dashboard says *"No data yet"*, you either haven't scraped or MongoDB is empty. To get a non-empty demo without scraping, run `node buh.js` — it seeds fake history.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/history` | All snapshots, sorted oldest → newest. |
| `GET /api/latest` | The single most recent snapshot. |
| `GET /api/decks` | Deck metadata for the UI: name, chart colour, Moxfield URL, commander image. |

The server opens and closes a MongoDB connection per request. Fine for a local single-user dashboard; not appropriate for anything load-bearing.

---

## Configuration

Most things are hardcoded and will need editing to reuse this for your own collection.

**Tracked decks** — edit `decks.js`:

```js
{ name: "my deck", url: "https://moxfield.com/decks/DECK_ID" }
```

The `name` is the join key across the database, the chart legend, and the UI. Renaming a deck starts it as a brand-new series; historical snapshots keep the old name.

**MongoDB connection** — `run.js` honours `MONGO_URL`; `server.js` and the helper scripts do **not**. Set it in all four places (`run.js`, `server.js`, `buh.js`, `scrub.js`) if you're not on `localhost`.

**Port** — `3000`, hardcoded in `server.js`.

---

## Design notes and gotchas

**Prices come from page scraping, not an API.** `#shoppingcart` holds the deck's current market value as rendered by Moxfield's frontend. If Moxfield changes that markup, the scraper silently records `0.00`. `check_price.py` exists because someone went looking for a cleaner API-based path — the v2 API doesn't expose the same aggregate value (it's per-card), so scraping the rendered total stayed.

**A failed scrape is recorded as `0.00`, not skipped.** In `run.js`, a caught error writes `runData.prices[deck.name] = 0.00`. That keeps decks aligned across snapshots but means failures and genuinely-zero decks are indistinguishable in the data. The dashboard filters `v > 0`, so those points simply vanish from the chart rather than showing as a dip to zero.

**`buh.js` writes fake data.** It clears `price_logs` and inserts five backdated snapshots with randomised values around a hardcoded set of prices. Never run it against a database you care about.

**`dashboard.html` is a frozen export.** Its chart series are literal arrays pasted into the HTML. `public/index.html` is the live one. Don't confuse them.

**Tracking is per-deck, not per-card.** You get the portfolio total over time, not which card moved.

---

## Status

Personal project. No tests, no CI, no README until now. `node_modules/` is committed, `.gitignore` only covers `credentials.json` and `*.json.bak`.

Known rough edges:

- `tracker.py` and `decks.js` disagree on which decks exist — Python tracks 10, JS tracks 14. `tracker.py` also writes to Google Sheets rather than MongoDB, so the two paths don't share storage.
- `debug.html` is a saved copy of someone else's Moxfield profile page, committed by accident as far as the history suggests.
- `buh.js` is named as if it were a utility; it's a destructive seed script.

Treat this as a working tool that needs cleanup before it's a general-purpose one.
