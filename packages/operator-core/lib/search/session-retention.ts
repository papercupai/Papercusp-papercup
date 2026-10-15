/**
 * Retention windows for the indexed-transcript tables, in a leaf module so the
 * pruner (session-ingest.ts) and the storage-growth alarm's retention-lag leg
 * read ONE value. The alarm must not import session-ingest.ts for two numbers.
 */

/** Retention for indexed turns (the JSONL remains the archive past this). */
export const SESSION_TURN_RETENTION_DAYS = 45;

/** Retention for faithful parts. It is SHORTER than SESSION_TURN_RETENTION_DAYS
 * by design (D-002): recent sessions render faithfully, older ones degrade to
 * the text turns in session_turns, and older still to session_archives. */
export const SESSION_TURN_PART_RETENTION_DAYS = 14;
