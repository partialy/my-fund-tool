import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { openDatabase } from './connection.js';

const schemaUrl = new URL('./schema.sql', import.meta.url);

export function initializeDatabase(db) {
  const schema = readFileSync(schemaUrl, 'utf8');
  db.exec(schema);
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
