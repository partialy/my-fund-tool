import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './connection.js';

const schemaUrl = new URL('./schema.sql', import.meta.url);

export function initializeDatabase(db) {
  const schema = readFileSync(schemaUrl, 'utf8');
  db.exec(schema);
  normalizeDecisionCounts(db);
}

function normalizeDecisionCounts(db) {
  db.exec(`
    UPDATE decisions
    SET counts_daily = 0,
        daily_sequence = NULL
    WHERE counts_daily = 1
      AND LOWER(action) NOT IN ('buy', 'sell', 'switch', 'cancel_order');

    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY account_id, decision_date
          ORDER BY submitted_at ASC, id ASC
        ) AS sequence
      FROM decisions
      WHERE counts_daily = 1
    )
    UPDATE decisions
    SET daily_sequence = (
      SELECT sequence
      FROM ranked
      WHERE ranked.id = decisions.id
    )
    WHERE id IN (
      SELECT id
      FROM ranked
    );
  `);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDatabase(parseDbPath(process.argv.slice(2)));
  initializeDatabase(db);
  db.close();
  console.log('Database initialized.');
}

function parseDbPath(argv) {
  if (argv[0] === '--db') {
    return argv[1];
  }

  return argv[0];
}
