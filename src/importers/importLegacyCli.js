import { openDatabase } from '../db/connection.js';
import { initializeDatabase } from '../db/init.js';
import { defaultLegacyDir, importLegacyData } from './legacyImport.js';

function parseArgs(argv) {
  const options = {
    legacyDir: defaultLegacyDir,
    dbPath: undefined,
    reset: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--legacy-dir') {
      options.legacyDir = argv[++index];
    } else if (arg === '--db') {
      options.dbPath = argv[++index];
    } else if (arg === '--reset') {
      options.reset = true;
    } else if (arg === '--no-reset') {
      options.reset = false;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node --experimental-sqlite src/importers/importLegacyCli.js [options]

Options:
  --legacy-dir <path>  Legacy fund-sim directory. Defaults to ../fund-sim.
  --db <path>          SQLite database path. Defaults to the DB layer default.
  --reset              Clear current ledger tables before import. Default.
  --no-reset           Import without clearing existing rows.
  -h, --help           Show this help.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const db = openDatabase(options.dbPath);
  try {
    initializeDatabase(db);
    const result = await importLegacyData({
      db,
      legacyDir: options.legacyDir,
      reset: options.reset,
    });

    console.log(`Legacy import complete: ${result.legacyDir}`);
    console.log(`Reset database: ${result.reset ? 'yes' : 'no'}`);
    console.log(`Account cash: ${result.balance.cash}`);
    console.log(`Total assets: ${result.balance.totalAssets}`);
    console.log(`Positions: ${result.positions.map((position) => position.code).join(', ')}`);
    console.log(`Decisions: ${result.counts.decisions}, orders: ${result.counts.orders}, PnL entries: ${result.counts.pnlEntries}`);
  } finally {
    db.close?.();
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
