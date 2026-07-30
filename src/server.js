import { createApp } from './app.js';

const port = Number.parseInt(process.env.PORT ?? '53999', 10);
const host = process.env.HOST ?? '0.0.0.0';
const dbPath = process.env.FUND_SIM_DB_PATH;

const app = createApp({ dbPath });
const server = app.listen(port, host, () => {
  console.log(`Fund sim tool listening at http://${host}:${port}`);
});

function closeDatabase() {
  const db = app.locals.db;
  if (db && typeof db.close === 'function') {
    db.close();
  }
}

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down.`);
  server.close(() => {
    closeDatabase();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
