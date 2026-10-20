/**
 * Moxfield data access, executed inside the user's own Chrome session.
 *
 * Why it works this way:
 *
 * Moxfield sits behind Cloudflare. The API rejects programmatic clients on TLS
 * fingerprint (JA3), not on headers. Verified against the live service:
 *
 *   curl  HTTP/1.1  -> 200
 *   curl  HTTP/2    -> 200
 *   node  fetch     -> 403   (Cloudflare "Attention Required")
 *   node  https     -> 403
 *   node + spoofed browser headers -> 403
 *
 * So no header tweaking helps. Every request is made from inside a real page
 * instead, where the TLS handshake and cookies are the browser's own. That is
 * also why this tool needs an already-running, logged-in Chrome rather than
 * being a standalone script.
 */

const API_BASE = 'https://api2.moxfield.com';

// The API reports an unfiltered result set as this value. Treat it as an error.
const UNFILTERED_SENTINEL = 10000;

/**
 * Run a GET against the Moxfield API inside the page's own context.
 * The page must already be on a moxfield.com origin so cookies apply.
 */
async function apiGetInPage(page, path) {
  const result = await page.evaluate(async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: await res.json() };
  }, `${API_BASE}${path}`);

  if (!result.ok) {
    throw new Error(`${path} -> HTTP ${result.status}`);
  }
  return result.body;
}

/**
 * Discover every deck authored by a user, paginated to exhaustion.
 *
 * The only working filter is `authorUserNames`. `userName`, `author`, and
 * `createdByUser` are silently ignored and return the whole site. A username
 * that does not exist is likewise ignored rather than yielding zero results,
 * which is why the sentinel check below matters.
 */
async function fetchUserDecks(page, userName, { pageSize = 100, onPage } = {}) {
  const decks = [];
  let pageNumber = 1;
  let total = null;

  while (true) {
    const q = new URLSearchParams({
      pageSize: String(pageSize),
      pageNumber: String(pageNumber),
      authorUserNames: userName,
    });

    const body = await apiGetInPage(page, `/v2/decks/search-sfw?${q}`);
    total = body.totalResults ?? 0;

    if (total >= UNFILTERED_SENTINEL) {
      throw new Error(
        `Deck lookup for "${userName}" was not filtered (totalResults=${total}). ` +
          `That value means the API ignored the username. Verify the user exists.`
      );
    }

    const batch = body.data ?? [];
    if (batch.length === 0) break;

    for (const d of batch) {
      decks.push({
        name: d.name,
        publicId: d.publicId,
        format: d.format,
        lastUpdated: d.lastUpdatedAtUtc,
        lastUpdatedAt: d.lastUpdatedAtUtc,
      });
    }

    if (onPage) onPage({ pageNumber, received: batch.length, total, decks: decks.length });

    if (decks.length >= total) break;
    pageNumber += 1;
    await new Promise((r) => setTimeout(r, 250));
  }

  return decks;
}

/** Full deck document, including per-card prices. */
async function fetchDeck(page, publicId) {
  return apiGetInPage(page, `/v2/decks/all/${publicId}`);
}

/**
 * Total market value, computed from per-card prices.
 *
 * Mirrors the deck page's own settings: basic lands excluded, commanders and
 * signature spells included. Non-foil entries use `prices.usd`; foil entries use
 * `prices.usd_foil`.
 *
 * Cross-checked against real history: this reports $89.70 for
 * "villain kindred", whose recorded value on the chart is $86.61 — within
 * normal card-price drift.
 */
function deckValue(deck) {
  const sumBoard = (board) => {
    let total = 0;
    for (const entry of Object.values(board || {})) {
      const card = entry.card || {};
      if (card.isBasicLand) continue;
      const prices = card.prices || {};
      const raw = entry.isFoil ? prices.usd_foil : prices.usd;
      const value = Number.parseFloat(raw);
      if (Number.isFinite(value)) total += value * (entry.quantity || 1);
    }
    return total;
  };

  const total =
    sumBoard(deck.mainboard) +
    sumBoard(deck.commanders) +
    sumBoard(deck.signatureSpells);

  return Math.round(total * 100) / 100;
}

/**
 * Commander art URLs from the `commanders` board.
 *
 * Building the URL requires the card's own ID, not `image_seq` — the rendered page
 * serves `card-face-<cardId>-normal.webp`. Verified against live assets: an
 * `image_seq`-based URL returns 404.
 *
 * Tries the face form first (double-faced cards and modern printing layouts)
 * and falls back to the plain form. Only the primary face is used; the back of a
 * transforming commander is not useful as a thumbnail.
 */
async function commanderImages(page, deck) {
  const urls = [];

  for (const entry of Object.values(deck.commanders || {})) {
    const card = entry.card || {};

    // Candidate IDs, in preference order. A double-faced card's own id often has
    // no artwork of its own — only its faces do — so every id is tried rather
    // than trusting the first.
    const ids = [];
    if (card.id) ids.push(card.id);
    for (const face of card.card_faces || []) {
      if (face.id) ids.push(face.id);
    }
    if (ids.length === 0) continue;

    const candidates = [];
    for (const id of ids) {
      candidates.push(`card-face-${id}-normal.webp`, `card-${id}-normal.webp`);
    }

    const found = await page.evaluate(async (names) => {
      for (const name of names) {
        const url = `https://assets.moxfield.net/cards/${name}`;
        try {
          const res = await fetch(url, { method: 'HEAD' });
          if (res.ok) return url;
        } catch {
          // try the next candidate
        }
      }
      return null;
    }, candidates);

    if (found && !urls.includes(found)) urls.push(found);
  }

  return urls;
}

module.exports = {
  API_BASE,
  UNFILTERED_SENTINEL,
  apiGetInPage,
  fetchUserDecks,
  fetchDeck,
  deckValue,
  commanderImages,
};
