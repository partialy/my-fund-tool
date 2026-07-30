# Fund Sim Tool MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Node v22 + Express + SQLite fund simulation ledger with API recording, liquid-glass pages, tests, and legacy data migration.

**Architecture:** SQLite is the single source of truth. Express exposes JSON endpoints for Codex and renders server-side EJS pages for humans. The ledger module owns trade-date, T+1, cash, position, order, decision, and snapshot behavior.

**Tech Stack:** Node v22 built-in `node:sqlite`, pnpm, Express, EJS, Zod, Cheerio, node:test, Supertest.

## Global Constraints

- Project directory: `E:\资料\money\games\fund-sim-tool`.
- Existing manual ledger remains read-only at `E:\资料\money\games\fund-sim`.
- No auth or security hardening is required; this is a local toy.
- Amounts are stored as integer cents.
- NAV and shares are stored as integer values scaled by `10000`.
- Decisions count toward the daily limit only when `counts_daily = 1`.
- Daily decision limit defaults to 3.
- 15:00 or earlier uses the submitted date as application trade date; after 15:00 uses the next trading day.
- Buy confirmation uses `(amount - fee) / nav`; sell settlement goes to available cash after confirmation/settlement.
- Add balance endpoints for future cash increase/decrease/correction.
- Pages use a restrained liquid-glass style while keeping tables readable.

---

### Task 1: Database And Ledger Core

**Files:**
- Create: `src/db/schema.sql`
- Create: `src/db/connection.js`
- Create: `src/db/init.js`
- Create: `src/lib/units.js`
- Create: `src/lib/dates.js`
- Create: `src/services/ledgerService.js`

**Interfaces:**
- Produces: `openDatabase(dbPath?: string): Database`
- Produces: `initializeDatabase(db): void`
- Produces: `createLedgerService(db): LedgerService`
- Produces: conversion helpers `moneyToCents`, `centsToMoney`, `navToInt`, `intToNav`, `sharesToInt`, `intToShares`, `ppmToPercent`

- [ ] Create schema tables for accounts, cash ledger, trading calendar, funds, fund navs, market quotes, decisions, orders, positions, account snapshots, snapshot positions, pnl entries, data sources, source refs.
- [ ] Implement integer conversion helpers.
- [ ] Implement date helpers for local date extraction, 15:00 cutoff, weekday fallback trading dates, and next trading date from the calendar.
- [ ] Implement ledger service methods for setup, balance, cash adjustments, nav writing, market quote writing, decisions, orders, confirmation, settlement, snapshots, and summary queries.
- [ ] Verify with node import smoke test.

### Task 2: Express API And Pages

**Files:**
- Create: `src/app.js`
- Create: `src/server.js`
- Create: `src/routes/api.js`
- Create: `src/routes/pages.js`

**Interfaces:**
- Consumes: `createLedgerService(db)`
- Produces: `createApp({ dbPath } = {}): Express`

- [ ] Wire Express JSON middleware and static assets.
- [ ] Add API routes listed in README.
- [ ] Add page routes `/`, `/account`, `/operations`, `/pnl`, `/actions/:id`.
- [ ] Use consistent `{ ok, data }` and `{ ok:false, error }` responses.
- [ ] Keep route handlers thin; business logic remains in ledger service.

### Task 3: Liquid Glass Views

**Files:**
- Create: `src/views/dashboard.ejs`
- Create: `src/views/account.ejs`
- Create: `src/views/operations.ejs`
- Create: `src/views/pnl.ejs`
- Create: `src/views/action.ejs`
- Create: `src/views/partials/nav.ejs`
- Create: `src/public/app.css`

**Interfaces:**
- Consumes page view models from `pages.js`.

- [ ] Build dashboard, account, operation log, PnL, and action detail pages.
- [ ] Use a restrained liquid-glass style with readable tables.
- [ ] Make desktop layout dense and mobile layout stacked.
- [ ] Keep action rows clickable and expose the latest action from the dashboard.

### Task 4: Legacy Importer

**Files:**
- Create: `src/importers/legacyImport.js`
- Create: `src/importers/importLegacyCli.js`

**Interfaces:**
- Consumes: `createLedgerService(db)`
- Produces: `importLegacyData({ db, legacyDir, reset }): ImportResult`

- [ ] Parse existing `operation-log.html`, `profit-log.html`, `account-info.html`, and `actions/*.html`.
- [ ] Reset and seed the SQLite database with the first game state.
- [ ] Import funds, decisions, buy orders, positions, snapshots, PnL entries, and data sources.
- [ ] Preserve legacy action paths on decisions.
- [ ] Make `pnpm import:legacy` migrate from `../fund-sim` by default.

### Task 5: Tests And Verification

**Files:**
- Create: `test/ledger.test.js`
- Create: `test/api.test.js`
- Create: `test/importer.test.js`

**Interfaces:**
- Consumes: `createApp`, `openDatabase`, `initializeDatabase`, `importLegacyData`

- [ ] Test money/NAV/share conversion through ledger operations.
- [ ] Test buy flow: decision, order submit, cash decrease, confirm, position increase, snapshot.
- [ ] Test hold decision daily limit.
- [ ] Test cash adjustment interface for deposit, withdraw, and correction.
- [ ] Test legacy import produces current known account state: total assets 10006.09, cash 5000.00, positions 007466 and 006087, two 2026-07-28 decisions.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm db:init`, `pnpm import:legacy`, and start server for smoke check.
