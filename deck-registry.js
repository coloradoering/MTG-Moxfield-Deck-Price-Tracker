/**
 * Deck registry.
 *
 * The set of tracked decks used to live in a hardcoded array. It now lives in
 * MongoDB so that the dashboard, the scraper, and any number of users all read
 * the same source of truth, and so that decks can appear and disappear as a
 * collection changes.
 *
 * One document per deck per user:
 *
 *   {
 *     user:      "letsloiter",          // whose collection this belongs to
 *     name:      "villain kindred",     // Moxfield deck name, the display key
 *     publicId:  "l8aeASsn2Xae-Tfg_2qO8w",
 *     format:    "commander",
 *     active:    true,                  // false once gone from the profile
 *     firstSeen: "2026-10-20T20:46:00Z",
 *     lastSeen:  "2026-10-20T20:46:00Z",
 *   }
 *
 * Decks are never deleted on scrape. A deck that disappears from a profile is
 * marked `active: false` instead, so its price history keeps a name to attach
 * to and the chart can still draw it.
 */

const COLLECTION = 'decks';

/**
 * Reconcile the registry against a freshly discovered deck list.
 *
 * Upserts everything found, and deactivates rows for this user that weren't.
 * Returns counts so the caller can report what changed.
 */
async function syncDecks(db, user, discovered) {
  const col = db.collection(COLLECTION);
  const now = new Date().toISOString();
  const seenIds = [];

  let added = 0;
  let updated = 0;

  for (const deck of discovered) {
    seenIds.push(deck.publicId);
    const existing = await col.findOne({ user, publicId: deck.publicId });

    if (!existing) {
      await col.insertOne({
        user,
        name: deck.name,
        publicId: deck.publicId,
        format: deck.format || null,
        active: true,
        firstSeen: now,
        lastSeen: now,
      });
      added += 1;
      continue;
    }

    // Name can change on Moxfield; publicId cannot. Track the rename.
    const changed = existing.name !== deck.name || existing.active !== true;
    await col.updateOne(
      { _id: existing._id },
      {
        $set: {
          name: deck.name,
          format: deck.format || existing.format || null,
          active: true,
          lastSeen: now,
        },
      }
    );
    if (changed) updated += 1;
  }

  const deactivated = await col.updateMany(
    { user, publicId: { $nin: seenIds }, active: true },
    { $set: { active: false } }
  );

  return { added, updated, deactivated: deactivated.modifiedCount, total: discovered.length };
}

/** Active decks for a user, in a stable order. */
async function listDecks(db, user) {
  return db
    .collection(COLLECTION)
    .find({ user, active: true })
    .sort({ name: 1 })
    .toArray();
}

/** Every user that has at least one tracked deck. */
async function listUsers(db) {
  return db.collection(COLLECTION).distinct('user', { active: true });
}

module.exports = { COLLECTION, syncDecks, listDecks, listUsers };
