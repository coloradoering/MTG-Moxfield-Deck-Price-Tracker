# MTG Moxfield Deck Price Tracker

Tracks the market value of every deck in a Magic: The Gathering [Moxfield](https://moxfield.com) collection over time, and visualizes the history in a local dashboard.

Deck selection is **automatic**: point it at a username and it discovers and prices the whole collection. There is no hardcoded deck list to maintain. Snapshots are stored in MongoDB and charted with Chart.js.

---

## How it works

```
Moxfield API  ──►  deck discovery (all decks for a user)
      │
      │  per-deck fetch, prices computed from card data
      ▼
 price snapshot  ──►  MongoDB (moxfield_tracker.price_logs)
                            │
                            │  Express API
                            ▼
                   Dashboard (Chart.js)
```

All Moxfield requests are made **from inside your own Chrome session** via Puppeteer. This is not incidental — see *Why a browser is required* below.

A *snapshot* is one document per scrape run:

```json
{
  "date": "2026-10-20 14:47",
  "user": "yourname",
  "prices": { "deck name": 90.73 },
  "images": { "deck name": ["https://assets.moxfield.net/cards/card-…-normal.webp"] },
  "deckIds": { "deck name": "publicId" },
  "formats": { "deck name": "commander" },
  "missing": {}
}
```

---

## Why a browser is required

Moxfield sits behind Cloudflare, which rejects programmatic clients on **TLS fingerprint** rather than headers. Measured against the live API:

| Client | Result |
|---|---|
| `curl` (HTTP/1.1) | 200 |
| `curl` (HTTP/2) | 200 |
| Node `fetch` | 403 |
| Node `https` | 403 |
| Node with spoofed browser headers | 403 |
| Headless Chrome | 403 |
| Visible Chrome | 200 |

So no header tweaking helps, and headless mode defeats the purpose. Every request therefore runs inside a real, visible, logged-in Chrome via `page.evaluate`. That browser does the TLS handshake and carries the cookies; the app just reads the results.

This also explains the project's shape: it is a companion to your browser session, not a standalone server-side scraper.

---

## Components

| File | Role |
|---|---|
| `moxfield-api.js` | All Moxfield access: deck discovery, per-deck fetch, value computation, commander art. Runs every request inside the page. |
| `run.js` | Scrape entry point. Connects to Chrome, resolves your collection, prices each deck, writes one snapshot to MongoDB. |
| `decks.js` | Chart colours only. Deck selection is no longer configured here — set `MOXFIELD_USER` instead. |
| `server.js` | Express server. Serves the dashboard and a small JSON API. Port `3000` (override with `PORT`). |
| `public/index.html` | Dashboard UI — stat cards, Chart.js line chart, per-deck cards with prices and day-over-day change, deck preview modal. |
| `buh.js` | Seed script — inserts **fake** historical data so the dashboard has something to render. Destructive. |
| `scrub.js` | Deletes all snapshots for the current date, so you can re-run a scrape cleanly. |
| `start-chrome.bat` | Windows helper that launches Chrome with remote debugging on port `9222`. |
| `tracker.py` | Legacy Python scraper writing to Google Sheets. Not used by the app; kept for reference. |
| `moxfield_history.json`, `moxfield_prices_2026-08-11.csv` | Leftover data exports. Nothing in the app reads them. |

---

## Requirements

- **Node.js 18+**
- **MongoDB** running on `localhost:27017`
- **Google Chrome** (for the Puppeteer-based scraper)
- *Optional, for `tracker.py`:* Python 3, `requests`, `beautifulsoup4`, `gspread`, plus a Google service-account `credentials.json`

---

## Quick start

### 1. Start MongoDB

Install MongoDB natively and make sure it is running on `localhost:27017`.

- **Windows:** [MongoDB Community Server MSI](https://www.mongodb.com/try/download/community) (installs as a Windows service), or `winget install MongoDB.Server`
- **Debian/Ubuntu:** `sudo apt install mongodb-org && sudo systemctl enable --now mongod`
- **macOS:** `brew tap mongodb/brew && brew install mongodb-community`

Verify it is reachable:

```bash
mongosh --eval "db.runCommand({ping:1})"
```

Data lives at the server's configured `dbPath` — typically `/var/lib/mongodb` on a Linux package install, or `C:\Program Files\MongoDB\Server\<version>\data` on Windows. The database name is `moxfield_tracker`.

### 2. Launch Chrome with remote debugging

The scraper **attaches to an existing Chrome** rather than launching its own. This is deliberate — Moxfield blocks headless automation, and a real browser profile gets through. The login session lives in the profile directory, so you log in once and later runs reuse it.

This is also **why the project has no Docker setup**. A container cannot reach the host's Chrome, and running Chrome inside one reintroduces the headless fingerprint the approach exists to avoid. The scraper, database, and dashboard are meant to run natively on the same machine.

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

Two ways to say whose collection to track. The dashboard is the normal one.

**From the dashboard.** Start the server, then type a Moxfield username into the
**Moxfield username** field and press **Track**. That saves the username, imports
every public deck on that profile, and you press **Scrape Now** to price them.
Changing the username switches tracking: the previous user's decks are marked
inactive but their price history is kept.

**From the command line.** Set the environment variable or pass the flag:

```bash
MOXFIELD_USER=yourname npm run scrape
# or
npm run scrape -- --user yourname
```

Your username is the last part of your profile URL: `https://moxfield.com/users/<name>`.

Each run discovers **every deck you own** and keeps the Commander ones. Add `--all-formats` to price everything.

Output looks like:

```
Connecting to Chrome at http://localhost:9222...
Reusing existing tab: https://moxfield.com/

Checking Moxfield API reachability...
API reachable.

Fetching decks for "yourname"...
Found 25 decks.
Pricing 19 commander decks.

  samurai greg            $   122.08  (71 cards, 1 img)
  shakira shakira         $   221.27  (80 cards, 1 img)
  ...

Saving snapshot: 19 priced, 0 failed...
Saved as ObjectId('...').
```

A deck that fails is listed under `missing` in the snapshot and reported in the output — it is **not** recorded as `$0.00`.

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

Everything is environment-driven; no source edits needed.

| Variable | Default | Used by |
|---|---|---|
| `MOXFIELD_USER` | *(required)* | `run.js` — whose collection to track |
| `MONGO_URL` | `mongodb://localhost:27017` | all scripts |
| `DB_NAME` | `moxfield_tracker` | all scripts |
| `CHROME_URL` | `http://localhost:9222` | `run.js` |
| `PORT` | `3000` | `server.js` |

`run.js` also accepts `--user <name>` and `--all-formats`. The flag wins over `MOXFIELD_USER`.

**Deck names are the join key.** They link the database, the chart legend, and the UI. Renaming a deck on Moxfield starts it as a new series; historical snapshots keep the old name and the chart treats them as separate decks. Prices are not carried across a rename.

---

## Design notes and gotchas

**Values are computed from card prices, not read off the page.** Each deck's total is the sum of `prices.usd` (or `usd_foil` for foils) across the mainboard plus the commander, with basic lands excluded — matching how the deck page reports it. Cross-checked against recorded history: a deck the chart shows at $86.61 computes to $90.73, and one at $1054.17 computes to $1045.24. Those gaps are real card-price drift, not error.

**A deck that fails is recorded under `missing`, not as `$0.00`.** Writing a zero would make a broken scrape indistinguishable from a worthless deck. Failures appear in the console and in the snapshot; that deck simply has no point for that run.

**The deck list is whatever you currently own.** Adding, deleting, or renaming a deck changes the next snapshot. The chart unions deck names across all snapshots, so a deck you stop tracking keeps its history instead of disappearing.

**`buh.js` writes fake data.** It clears `price_logs` and inserts five backdated snapshots with randomised values around a hardcoded set of prices. Never run it against a database you care about.

**Tracking is per-deck, not per-card.** You get the portfolio total over time, not which card moved.

**The API is undocumented.** `api2.moxfield.com` is what Moxfield's own web client calls; it can change without notice. If discovery breaks, `moxfield-api.js` is where to look. Note that only the `authorUserNames` filter works — `userName`, `author`, and `createdByUser` are silently ignored and return the entire site, which is why the code rejects any `totalResults` of 10000.

---

## Status

Working tool, no tests, no CI. `node_modules/` is committed, `.gitignore` covers only `credentials.json` and `*.json.bak`.

Known rough edges:

- `tracker.py` is legacy: it writes to Google Sheets, not MongoDB, and is unrelated to the current pipeline.
- `buh.js` is named as if it were a utility; it's a destructive seed script that clears `price_logs`.
- `GET /api/latest` is implemented but never called — the UI derives the latest snapshot client-side from `/api/history`.
- Headless Chrome does not work. The browser must be visible, so on a server you need Xvfb or similar.
- Verified on Chrome 155 / Node 22. Puppeteer 22 bundles Chrome 127, which is untested against Moxfield's current Cloudflare config.
