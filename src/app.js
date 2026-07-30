import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/connection.js';
import { initializeDatabase } from './db/init.js';
import { createLedgerService } from './services/ledgerService.js';
import { createApiRouter, sendErrorResponse } from './routes/api.js';
import { createPagesRouter } from './routes/pages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  dbPath,
  db,
  ledger,
  initialize = true,
  importLegacyData,
} = {}) {
  const app = express();
  const database = db ?? openDatabase(dbPath);

  if (initialize) {
    initializeDatabase(database);
  }

  const ledgerService = ledger ?? createLedgerService(database);
  if (typeof ledgerService.setupDefaultAccount === 'function') {
    ledgerService.setupDefaultAccount();
  }

  app.locals.db = database;
  app.locals.ledger = ledgerService;

  app.set('views', path.join(__dirname, 'views'));
  app.set('view engine', 'ejs');

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api', createApiRouter({
    db: database,
    ledger: ledgerService,
    importLegacyData,
  }));
  app.use('/', createPagesRouter({ ledger: ledgerService }));

  app.use((error, request, response, next) => {
    if (request.path.startsWith('/api')) {
      sendErrorResponse(response, error);
      return;
    }

    next(error);
  });

  return app;
}

export default createApp;
