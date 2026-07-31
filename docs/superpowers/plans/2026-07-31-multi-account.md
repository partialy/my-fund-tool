# Multi Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight multi-account support so local users can keep independent fund simulation ledgers without login or security features.

**Architecture:** Keep the existing `accounts` table and account-scoped tables as the data model. Add one account resolver inside `ledgerService` so every account-scoped method accepts `accountCode`, `account`, or numeric `accountId`, while omitted account input still uses `default`.

**Tech Stack:** Node v22, Express, EJS, SQLite via `node:sqlite`, node:test, Supertest.

## Global Constraints

- No login, auth, permission, or security workflow.
- `accountCode` is the preferred external account selector for API query strings and JSON bodies.
- Missing account input must continue to resolve to the existing `default` account.
- Fund NAVs and market quotes remain global market data, not account-owned data.
- Account-owned ledgers, decisions, orders, positions, snapshots, and cash entries must not leak across accounts.
- Order numbers remain globally unique; generated order numbers include the account code to avoid cross-account collisions.
- Update `README.md`, `AGENTS.md`, and `E:\资料\money\games\redme.md` after behavior changes.

---

### Task 1: Account Resolver And Account Management

**Files:**
- Modify: `src/services/ledgerService.js`
- Modify: `src/routes/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `ledger.createAccount(input)`, `ledger.listAccounts()`
- Produces: account resolver accepting `accountId`, `account_id`, `accountCode`, `account_code`, `account`

- [x] Add failing API tests for creating and listing accounts.
- [x] Add failing API tests proving `GET /api/account/balance?accountCode=alt` returns the alt account balance.
- [x] Implement `resolveAccountSelector`, `getAccountByCode`, `createAccount`, and `listAccounts`.
- [x] Add `GET /api/accounts` and `POST /api/accounts`.
- [x] Run `node --experimental-sqlite --test test/api.test.js`.

### Task 2: Account-Scoped Ledger Isolation

**Files:**
- Modify: `src/services/ledgerService.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: resolver from Task 1
- Produces: existing methods accept `accountCode` everywhere account-owned data is read or written

- [x] Add failing tests for separate daily decision counts per account.
- [x] Add failing tests for separate cash ledger, orders, positions, and snapshots per account.
- [x] Replace direct `input.accountId ?? input.account_id` calls with the resolver input.
- [x] Make generated order numbers account-prefixed, such as `alt-ORD-20260731-0001`.
- [x] Ensure confirm and settle reject mismatched `accountCode`.
- [x] Run API and ledger tests.

### Task 3: Page Account Selector

**Files:**
- Modify: `src/routes/pages.js`
- Modify: `src/views/partials/nav.ejs`
- Modify: `src/views/dashboard.ejs`
- Modify: `src/views/account.ejs`
- Modify: `src/views/operations.ejs`
- Modify: `src/views/pnl.ejs`
- Modify: `src/views/action.ejs`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: account list and active account in page view models
- Produces: pages preserve `accountCode` across navigation, pagination, action links, and position history fetches

- [x] Add failing page tests for account selector rendering and account-preserving links.
- [x] Add account list and active account to page view models.
- [x] Render a topbar account selector.
- [x] Preserve `accountCode` in nav links, detail links, and account page fetch calls.
- [x] Run page-related tests.

### Task 4: Documentation And Deployment Notes

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `E:\资料\money\games\redme.md`

**Interfaces:**
- Produces: documented accountCode usage for future game execution

- [x] Document account endpoints.
- [x] Document accountCode query/body convention.
- [x] Document default account compatibility and per-account game execution rules.
- [x] Run full tests.
- [x] Commit and push with a Chinese commit message.
