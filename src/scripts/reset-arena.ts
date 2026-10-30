import 'dotenv/config';
import { pool } from '../db/pool.js';
import { updateBaitListing } from '../arena/service.js';

/** Clears Arena run history (the "times fooled" counter) and restores the default listing text. */
const res = await pool.query('DELETE FROM arena_runs');
await updateBaitListing(null);
console.log(`Cleared ${res.rowCount} Arena runs and restored the default listing.`);
await pool.end();
