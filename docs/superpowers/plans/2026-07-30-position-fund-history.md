# Position Fund History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a current-position fund detail view that shows each held fund's official daily NAV, change, market value, unrealized PnL, and return rate from the buy trade date onward.

**Architecture:** Reuse the existing ledger tables instead of adding a new daily-history ledger table. `fund_navs` remains the official NAV source, `snapshot_positions` remains the account-position state by snapshot date, and a new read-only service/API method joins them for the currently held fund only. The account page gets a details button per holding and a modal that fetches the history endpoint.

**Tech Stack:** Node v22 built-in `node:sqlite`, Express, EJS, vanilla browser JavaScript, existing CSS, node:test + Supertest.

## Global Constraints

- Do not write local legacy HTML files; server API / SQLite remains the only ledger source.
- Only current held funds expose detail history in this MVP.
- Show official disclosed NAV data only; do not mix intraday estimates into the detail table.
- The first displayed row for a buy starts at the order `trade_date`: before-15:00 buys are filled on the next execution using that day's NAV, after-15:00 buys shift to the next trade date and are filled on the following execution.
- Keep existing pagination behavior and liquid-glass visual style.
- Update `AGENTS.md` / `README.md` when adding the new API and UI behavior.

---

### Task 1: Add Position History Read Model

**Files:**
- Modify: `src/services/ledgerService.js`
- Test: `test/ledger.test.js`

**Interfaces:**
- Produces: `ledger.getPositionHistory({ accountId, fundCode, page, pageSize, paginated })`
- Returns: `{ items, pagination }` when paginated, otherwise an array.
- Each item shape:
  - `snapshotDate`, `fundCode`, `fundName`
  - `nav`, `navDate`, `navChangeRate`, `navChangePpm`, `navSource`
  - `shares`, `cost`, `marketValue`, `unrealizedPnl`, `returnRate`, `returnPpm`

- [ ] **Step 1: Write the failing service test**

```js
test('position history starts at buy trade date and calculates nav change and pnl rate', () => {
  const { ledger } = createTestLedger();

  ledger.writeFundNav({ code: 'A001', fundName: '测试基金A', navDate: '2026-01-01', nav: '1.0000' });
  ledger.writeFundNav({ code: 'A001', fundName: '测试基金A', navDate: '2026-01-02', nav: '1.1000' });
  ledger.writeFundNav({ code: 'A001', fundName: '测试基金A', navDate: '2026-01-03', nav: '1.2100' });
  const decision = ledger.recordDecision({
    decisionDate: '2026-01-01',
    submittedAt: '2026-01-01 14:30:00',
    action: 'buy',
    fundCode: 'A001',
    fundName: '测试基金A',
    amount: '1100.00',
    countsDaily: true,
  });
  ledger.createOrder({
    orderNo: '20260101-001',
    decisionId: decision.id,
    submittedAt: '2026-01-01 14:30:00',
    side: 'buy',
    fundCode: 'A001',
    fundName: '测试基金A',
    amount: '1100.00',
    tradeDate: '2026-01-02',
    fee: '0.00',
  });
  ledger.confirmOrder('20260101-001', {
    confirmDate: '2026-01-03',
    settleDate: '2026-01-03',
    nav: '1.1000',
  });
  ledger.createSnapshot({ snapshotDate: '2026-01-02' });
  ledger.createSnapshot({ snapshotDate: '2026-01-03' });

  const result = ledger.getPositionHistory({
    fundCode: 'A001',
    paginated: true,
    page: 1,
    pageSize: 10,
  });

  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].snapshotDate, '2026-01-03');
  assert.equal(result.items[1].snapshotDate, '2026-01-02');
  assert.equal(result.items[1].nav, 1.1);
  assert.equal(result.items[1].navChangePpm, 100000);
  assert.equal(result.items[1].marketValue, 1100);
  assert.equal(result.items[1].unrealizedPnl, 0);
  assert.equal(result.items[1].returnPpm, 0);
  assert.equal(result.items[0].nav, 1.21);
  assert.equal(result.items[0].navChangePpm, 100000);
  assert.equal(result.items[0].marketValue, 1210);
  assert.equal(result.items[0].unrealizedPnl, 110);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm test -- test/ledger.test.js`

Expected: FAIL because `getPositionHistory` is not implemented.

- [ ] **Step 3: Implement the minimal read method**

Add the method near `listPositions`. It should:
- resolve the default account;
- reject funds not currently in `positions` for that account;
- query `snapshot_positions` joined to `account_snapshots`, `funds`, `fund_navs`, and previous `fund_navs`;
- calculate `navChangePpm = round((nav_int - previous_nav_int) / previous_nav_int * 1000000)`;
- calculate `returnPpm = round(unrealized_pnl_cents / cost_cents * 1000000)`;
- apply existing pagination helpers.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `pnpm test -- test/ledger.test.js`

Expected: PASS.

### Task 2: Expose API Endpoint

**Files:**
- Modify: `src/routes/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Produces: `GET /api/positions/:fundCode/history?page=1&pageSize=20`
- Response shape: `{ ok: true, data: { items, pagination } }`

- [ ] **Step 1: Write the failing API test**

```js
test('GET /api/positions/:fundCode/history returns current holding daily details', async () => {
  const { app, ledger } = createTestApp();
  ledger.writeFundNav({ code: 'A001', fundName: '测试基金A', navDate: '2026-01-01', nav: '1.0000' });
  ledger.writeFundNav({ code: 'A001', fundName: '测试基金A', navDate: '2026-01-02', nav: '1.1000' });
  const decision = ledger.recordDecision({
    decisionDate: '2026-01-01',
    submittedAt: '2026-01-01 14:30:00',
    action: 'buy',
    fundCode: 'A001',
    fundName: '测试基金A',
    amount: '1100.00',
  });
  ledger.createOrder({
    orderNo: '20260101-001',
    decisionId: decision.id,
    submittedAt: '2026-01-01 14:30:00',
    side: 'buy',
    fundCode: 'A001',
    fundName: '测试基金A',
    amount: '1100.00',
    tradeDate: '2026-01-02',
  });
  ledger.confirmOrder('20260101-001', { confirmDate: '2026-01-03', nav: '1.1000' });
  ledger.createSnapshot({ snapshotDate: '2026-01-02' });

  const response = await request(app)
    .get('/api/positions/A001/history?page=1&pageSize=10')
    .expect(200);

  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.items[0].fundCode, 'A001');
  assert.equal(response.body.data.items[0].snapshotDate, '2026-01-02');
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm test -- test/api.test.js`

Expected: FAIL with 404 or route not found.

- [ ] **Step 3: Add route wiring**

Add `positionHistory` to `LEDGER_METHODS` and route:

```js
router.get('/positions/:fundCode/history', asyncHandler(async (request, response) => {
  const data = await callLedger(ledger, LEDGER_METHODS.positionHistory, {
    ...paginatedQueryPayload(request),
    fundCode: request.params.fundCode,
  });
  sendSuccessResponse(response, data);
}));
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `pnpm test -- test/api.test.js`

Expected: PASS.

### Task 3: Add Account Page Detail Modal

**Files:**
- Modify: `src/views/account.ejs`
- Modify: `src/public/app.css`
- Test: `test/api.test.js` or page smoke test in existing API suite

**Interfaces:**
- Consumes: `GET /api/positions/:fundCode/history`
- Produces: one detail button per holding and one reusable modal.

- [ ] **Step 1: Write failing page smoke test**

Assert `/account` includes:
- `data-position-history-button`
- `data-position-history-modal`
- `/api/positions/`

- [ ] **Step 2: Run test and verify RED**

Run: `pnpm test -- test/api.test.js`

Expected: FAIL because the markup is absent.

- [ ] **Step 3: Add button, modal markup, and browser script**

In the holding row, add a `详情` button with `data-fund-code` and `data-fund-name`. Add a modal below the page content. The script should fetch page 1 with `pageSize=20`, render table rows, show loading/error states, and close on backdrop, close button, or `Escape`.

- [ ] **Step 4: Style the modal**

Use existing glass-panel vocabulary: translucent surface, tight table, clear positive/negative colors, and responsive overflow.

- [ ] **Step 5: Run test and verify GREEN**

Run: `pnpm test -- test/api.test.js`

Expected: PASS.

### Task 4: Documentation, Verification, Commit

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Document `GET /api/positions/:fundCode/history`.
- Document that fund detail history starts on buy trade date after official NAV confirmation.

- [ ] **Step 1: Update docs**

Add the endpoint and behavior to README and AGENTS.

- [ ] **Step 2: Run full tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 3: Run page/API smoke checks**

Run:

```powershell
$env:PORT='54001'; pnpm start
```

Then verify:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:54001/account' -UseBasicParsing
Invoke-RestMethod -Uri 'http://127.0.0.1:54001/api/positions/006087/history?page=1&pageSize=20'
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "feat: 增加持仓基金每日明细"
```
