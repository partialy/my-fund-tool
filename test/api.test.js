import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as cheerio from 'cheerio';
import request from 'supertest';

const CODEX_ACCOUNT_CODE = 'account-codex';

async function createAppFixture(name, options = {}) {
  const root = path.join(os.tmpdir(), `fund-sim-tool-api-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const { createApp } = await import('../src/app.js');
  const dbPath = path.join(root, 'api.sqlite');

  const app = createApp({ dbPath, ...options });
  app.locals.ledger?.setupDefaultAccount?.({
    initialCash: '0.00',
    occurredAt: '2026-07-23T09:00:00+08:00',
  });

  return {
    app,
    async cleanup() {
      app.locals.db?.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function unwrapBody(response) {
  assert.equal(response.body.ok, true, JSON.stringify(response.body));
  return response.body.data ?? response.body;
}

function asMoney(value) {
  if (value == null) return value;
  if (typeof value === 'number') return value.toFixed(2);

  const text = String(value).trim();
  if (/^-?\d+$/.test(text) && Math.abs(Number(text)) > 100000) {
    return (Number(text) / 100).toFixed(2);
  }

  const match = text.replaceAll(',', '').match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]).toFixed(2) : text;
}

function pickMoney(source, keys) {
  const value = keys.map((key) => source?.[key]).find((item) => item != null);
  return asMoney(value);
}

async function seedDecisionRows(app, count, accountCode = CODEX_ACCOUNT_CODE) {
  for (let index = 1; index <= count; index += 1) {
    const day = String(index).padStart(2, '0');
    const note = `D-${day}`;
    const response = await request(app)
      .post('/api/decisions')
      .send({
        accountCode,
        note,
        submittedAt: `2026-07-${day}T09:30:00+08:00`,
        action: 'hold',
        reason: `pagination seed ${day}`,
        countsDaily: false,
      })
      .expect((res) => assert.ok([200, 201].includes(res.status), res.text));
    unwrapBody(response);
  }
}

function seedConfirmedPosition(ledger, {
  accountCode = CODEX_ACCOUNT_CODE,
  code = 'A001',
  fundName = '测试基金A',
  amount = '1000.00',
  orderNo = '20260101-001',
  tradeDate = '2026-01-02',
  confirmDate = '2026-01-03',
  buyNav = '1.0000',
  latestDate = '2026-01-03',
  latestNav = '1.1000',
} = {}) {
  ledger.adjustCash({
    accountCode,
    type: 'deposit',
    amount: '2000.00',
    occurredAt: '2026-01-01T09:00:00+08:00',
    note: '测试资金',
  });
  ledger.writeFundNav({
    code,
    fundName,
    navDate: tradeDate,
    nav: buyNav,
    source: '测试买入净值源',
  });
  const decision = ledger.recordDecision({
    accountCode,
    decisionDate: '2026-01-01',
    submittedAt: '2026-01-01T14:30:00+08:00',
    action: 'buy',
    fundCode: code,
    fundName,
    amount,
    reason: '测试买入',
  });
  ledger.createOrder({
    accountCode,
    orderNo,
    decisionId: decision.id,
    submittedAt: '2026-01-01T14:30:00+08:00',
    side: 'buy',
    fundCode: code,
    fundName,
    amount,
    tradeDate,
    fee: '0.00',
  });
  ledger.confirmOrder({
    accountCode,
    orderNo,
    confirmDate,
    settleDate: confirmDate,
    nav: buyNav,
  });
  ledger.writeFundNav({
    code,
    fundName,
    navDate: latestDate,
    nav: latestNav,
    source: '测试最新净值源',
  });
  ledger.createSnapshot({ accountCode, snapshotDate: latestDate });
}

test('cash adjustment endpoint applies deposit, withdraw, and correction', async () => {
  const fixture = await createAppFixture('cash-adjustments');

  try {
    const missingAccountWrite = await request(fixture.app)
      .post('/api/account/cash-adjustments')
      .send({
        type: 'deposit',
        amount: '1.00',
        occurredAt: '2026-07-23T08:59:00+08:00',
      });
    assert.equal(missingAccountWrite.body.ok, false);

    for (const payload of [
      {
        accountCode: CODEX_ACCOUNT_CODE,
        type: 'deposit',
        amount: '10000.00',
        occurredAt: '2026-07-23T09:00:00+08:00',
        reason: '初始资金',
      },
      {
        accountCode: CODEX_ACCOUNT_CODE,
        type: 'withdraw',
        amount: '1200.50',
        occurredAt: '2026-07-23T10:00:00+08:00',
        reason: '测试减少现金',
      },
      {
        accountCode: CODEX_ACCOUNT_CODE,
        type: 'correction',
        amount: '5000.00',
        occurredAt: '2026-07-23T11:00:00+08:00',
        reason: '按实际账户修正可用资金',
      },
    ]) {
      const response = await request(fixture.app)
        .post('/api/account/cash-adjustments')
        .send(payload)
        .expect((res) => assert.ok([200, 201].includes(res.status), res.text));
      unwrapBody(response);
    }

    const missingAccount = await request(fixture.app).get('/api/account/balance');
    assert.equal(missingAccount.body.ok, false);
    assert.match(String(missingAccount.body.error?.message ?? ''), /account/i);

    const balance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(
      pickMoney(balance, ['availableCash', 'cash', 'cashAvailable', 'available_cash']),
      '5000.00',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('accounts endpoint creates and lists independent accounts', async () => {
  const fixture = await createAppFixture('accounts');

  try {
    const created = unwrapBody(
      await request(fixture.app)
        .post('/api/accounts')
        .send({
          accountCode: 'alt',
          name: '备用账户',
          initialCash: '1234.00',
          occurredAt: '2026-07-31T09:30:00+08:00',
        })
        .expect(200),
    );

    assert.equal(created.accountCode, 'alt');
    assert.equal(created.name, '备用账户');
    assert.equal(created.balance.cashAvailable, 1234);

    const accounts = unwrapBody(await request(fixture.app).get('/api/accounts').expect(200));
    assert.deepEqual(
      accounts.map((account) => account.accountCode),
      ['account-codex', 'alt'],
    );

    const missingBalance = await request(fixture.app).get('/api/account/balance');
    assert.equal(missingBalance.body.ok, false);

    const codexBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(codexBalance.accountCode, 'account-codex');

    const balance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: 'alt' })
        .expect(200),
    );
    assert.equal(balance.accountCode, 'alt');
    assert.equal(balance.cashAvailable, 1234);
  } finally {
    await fixture.cleanup();
  }
});

test('accountCode isolates balances decisions orders and positions', async () => {
  const fixture = await createAppFixture('account-isolation');

  try {
    await request(fixture.app)
      .post('/api/accounts')
      .send({
        accountCode: 'alt',
        name: '备用账户',
        initialCash: '0.00',
        occurredAt: '2026-07-31T09:00:00+08:00',
      })
      .expect(200);

    const startingDefaultBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );

    for (const payload of [
      {
        accountCode: CODEX_ACCOUNT_CODE,
        type: 'deposit',
        amount: '1000.00',
        note: '默认账户入金',
      },
      {
        accountCode: 'alt',
        type: 'deposit',
        amount: '2000.00',
        note: '备用账户入金',
      },
    ]) {
      unwrapBody(
        await request(fixture.app)
          .post('/api/account/cash-adjustments')
          .send(payload)
          .expect(200),
      );
    }

    const defaultBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    const altBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: 'alt' })
        .expect(200),
    );
    assert.equal(defaultBalance.cashAvailable, startingDefaultBalance.cashAvailable + 1000);
    assert.equal(altBalance.cashAvailable, 2000);

    await request(fixture.app)
      .post('/api/market/funds/A001/nav')
      .send({
        fundName: '测试基金A',
        navDate: '2026-07-31',
        nav: '1.0000',
        source: '测试净值源',
      })
      .expect(200);

    const defaultDecision = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionDate: '2026-07-31',
          submittedAt: '2026-07-31T09:30:00+08:00',
          action: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '100.00',
          reason: '默认账户买入',
        })
        .expect(200),
    );
    const altDecision = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: 'alt',
          decisionDate: '2026-07-31',
          submittedAt: '2026-07-31T09:35:00+08:00',
          action: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '200.00',
          reason: '备用账户买入',
        })
        .expect(200),
    );

    const defaultToday = unwrapBody(
      await request(fixture.app)
        .get('/api/today')
        .query({ date: '2026-07-31T10:00:00+08:00', accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    const altToday = unwrapBody(
      await request(fixture.app)
        .get('/api/today')
        .query({ date: '2026-07-31T10:00:00+08:00', accountCode: 'alt' })
        .expect(200),
    );
    assert.equal(defaultToday.decisionCount, 1);
    assert.equal(altToday.decisionCount, 1);

    const defaultOrder = unwrapBody(
      await request(fixture.app)
        .post('/api/orders')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionId: defaultDecision.id,
          submittedAt: '2026-07-31T09:30:00+08:00',
          side: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '100.00',
          tradeDate: '2026-07-31',
          fee: '0.00',
        })
        .expect(200),
    );
    const altOrder = unwrapBody(
      await request(fixture.app)
        .post('/api/orders')
        .send({
          accountCode: 'alt',
          decisionId: altDecision.id,
          submittedAt: '2026-07-31T09:35:00+08:00',
          side: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '200.00',
          tradeDate: '2026-07-31',
          fee: '0.00',
        })
        .expect(200),
    );

    assert.match(defaultOrder.order_no, /^account-codex-ORD-20260731-\d{4}$/);
    assert.match(altOrder.order_no, /^alt-ORD-20260731-\d{4}$/);

    await request(fixture.app)
      .post(`/api/orders/${encodeURIComponent(defaultOrder.order_no)}/confirm`)
      .send({
        accountCode: CODEX_ACCOUNT_CODE,
        confirmDate: '2026-08-03',
        settleDate: '2026-08-03',
        nav: '1.0000',
      })
      .expect(200);
    await request(fixture.app)
      .post(`/api/orders/${encodeURIComponent(altOrder.order_no)}/confirm`)
      .send({
        accountCode: 'alt',
        confirmDate: '2026-08-03',
        settleDate: '2026-08-03',
        nav: '1.0000',
      })
      .expect(200);

    const mismatch = await request(fixture.app)
      .post(`/api/orders/${encodeURIComponent(defaultOrder.order_no)}/confirm`)
      .send({
        accountCode: 'alt',
        confirmDate: '2026-08-03',
        settleDate: '2026-08-03',
        nav: '1.0000',
      });
    assert.equal(mismatch.body.ok, false);

    const defaultPositions = unwrapBody(
      await request(fixture.app)
        .get('/api/positions')
        .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
        .expect(200),
    );
    const altPositions = unwrapBody(
      await request(fixture.app)
        .get('/api/positions')
        .query({ accountCode: 'alt', page: 1, pageSize: 10 })
        .expect(200),
    );
    assert.equal(defaultPositions.items[0].marketValue, 100);
    assert.equal(altPositions.items[0].marketValue, 200);
  } finally {
    await fixture.cleanup();
  }
});

test('submitted buy order can be cancelled and refunded before confirmation', async () => {
  const fixture = await createAppFixture('cancel-submitted-buy');

  try {
    await request(fixture.app)
      .post('/api/market/funds/A001/nav')
      .send({
        fundName: '测试基金A',
        navDate: '2026-07-31',
        nav: '1.0000',
        source: '测试净值源',
      })
      .expect(200);

    const decision = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionDate: '2026-07-31',
          submittedAt: '2026-07-31T14:30:00+08:00',
          action: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '1000.00',
          reason: '测试撤回未确认买入',
        })
        .expect(200),
    );

    const order = unwrapBody(
      await request(fixture.app)
        .post('/api/orders')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionId: decision.id,
          submittedAt: '2026-07-31T14:30:00+08:00',
          side: 'buy',
          fundCode: 'A001',
          fundName: '测试基金A',
          amount: '1000.00',
          tradeDate: '2026-07-31',
          fee: '0.00',
        })
        .expect(200),
    );

    const afterOrderBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(afterOrderBalance.cashAvailable, 9000);

    const cancelled = unwrapBody(
      await request(fixture.app)
        .post(`/api/orders/${encodeURIComponent(order.order_no)}/cancel`)
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          cancelledAt: '2026-07-31T14:45:00+08:00',
          note: '测试撤回未确认订单',
        })
        .expect(200),
    );
    assert.equal(cancelled.status, 'cancelled');

    const afterCancelBalance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(afterCancelBalance.cashAvailable, 10000);

    const orders = unwrapBody(
      await request(fixture.app)
        .get('/api/orders')
        .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
        .expect(200),
    );
    assert.equal(orders.items[0].status, 'cancelled');

    const cashLedger = unwrapBody(
      await request(fixture.app)
        .get('/api/account/cash-ledger')
        .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
        .expect(200),
    );
    const refundLedger = cashLedger.items.find((item) => item.type === 'refund');
    assert.ok(refundLedger);
    assert.equal(refundLedger.amount_cents, 100000);

    const decisions = unwrapBody(
      await request(fixture.app)
        .get('/api/decisions')
        .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
        .expect(200),
    );
    assert.equal(decisions.items[0].status, 'cancelled');
    assert.equal(decisions.items[0].counts_daily, 1);
  } finally {
    await fixture.cleanup();
  }
});

test('account pages preserve accountCode in navigation and position history requests', async () => {
  const fixture = await createAppFixture('account-page-code');

  try {
    const { ledger } = fixture.app.locals;
    ledger.createAccount({
      accountCode: 'alt',
      name: '备用账户',
      initialCash: '2000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
    });
    ledger.writeFundNav({
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-02',
      nav: '1.1000',
      source: '测试净值源',
    });
    const decision = ledger.recordDecision({
      accountCode: 'alt',
      decisionDate: '2026-01-01',
      submittedAt: '2026-01-01T14:30:00+08:00',
      action: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      reason: '备用账户测试买入',
    });
    const order = ledger.createOrder({
      accountCode: 'alt',
      decisionId: decision.id,
      submittedAt: '2026-01-01T14:30:00+08:00',
      side: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      tradeDate: '2026-01-02',
      fee: '0.00',
    });
    ledger.confirmOrder({
      accountCode: 'alt',
      orderNo: order.order_no,
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    ledger.createSnapshot({ accountCode: 'alt', snapshotDate: '2026-01-02' });

    const response = await request(fixture.app)
      .get('/account')
      .query({ accountCode: 'alt' })
      .expect(200);
    const $ = cheerio.load(response.text);

    assert.equal($('select[name="accountCode"] option[selected][value="alt"]').length, 1);
    assert.ok($('a[href="/?accountCode=alt"]').length > 0);
    assert.ok($('a[href="/operations?accountCode=alt"]').length > 0);
    assert.match(response.text, /accountCode=alt/);
    assert.match(response.text, /historyUrl\.searchParams\.set\('accountCode', accountCode\)/);
  } finally {
    await fixture.cleanup();
  }
});

test('pages default to the Codex account when opened without accountCode', async () => {
  const fixture = await createAppFixture('page-default-account');

  try {
    for (const pagePath of ['/', '/account', '/operations', '/pnl']) {
      const response = await request(fixture.app).get(pagePath).expect(200);
      const $ = cheerio.load(response.text);

      assert.equal(
        $('select[name="accountCode"] option[selected][value="account-codex"]').length,
        1,
        `${pagePath} should select the Codex account`,
      );
      assert.doesNotMatch(response.text, /Account code is required/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('decisions endpoint returns a requested page with pagination metadata', async () => {
  const fixture = await createAppFixture('decision-pagination');

  try {
    await seedDecisionRows(fixture.app, 12);

    const response = await request(fixture.app)
      .get('/api/decisions')
      .query({ accountCode: CODEX_ACCOUNT_CODE, page: 2, pageSize: 5 })
      .expect(200);
    const data = unwrapBody(response);

    assert.deepEqual(
      data.items.map((row) => row.note),
      ['D-07', 'D-06', 'D-05', 'D-04', 'D-03'],
    );
    assert.deepEqual(data.pagination, {
      page: 2,
      pageSize: 5,
      totalItems: 12,
      totalPages: 3,
      hasPrev: true,
      hasNext: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('operations page defaults the timeline to ten rows and exposes pagination links', async () => {
  const fixture = await createAppFixture('operations-pagination');

  try {
    await seedDecisionRows(fixture.app, 12);

    const firstPage = await request(fixture.app)
      .get('/operations')
      .query({ accountCode: CODEX_ACCOUNT_CODE })
      .expect(200);
    const $first = cheerio.load(firstPage.text);
    const firstTimeline = $first('section.glass-panel').first();

    assert.equal(firstTimeline.find('tbody tr.click-row').length, 10);
    assert.match(firstTimeline.text(), /第\s*1\s*\/\s*2\s*页/);
    assert.ok(firstTimeline.find('a[href*="decisionPage=2"]').length > 0);

    const secondPage = await request(fixture.app)
      .get('/operations')
      .query({ accountCode: CODEX_ACCOUNT_CODE, decisionPage: 2 })
      .expect(200);
    const $second = cheerio.load(secondPage.text);
    const secondTimeline = $second('section.glass-panel').first();

    assert.equal(secondTimeline.find('tbody tr.click-row').length, 2);
    assert.match(secondTimeline.text(), /第\s*2\s*\/\s*2\s*页/);
    assert.ok(secondTimeline.find('a[href*="decisionPage=1"]').length > 0);
  } finally {
    await fixture.cleanup();
  }
});

test('decision endpoint records more than three fund operations on one date', async () => {
  const fixture = await createAppFixture('decision-limit');

  try {
    for (const [index, time] of ['09:30:00', '12:01:04', '14:50:15'].entries()) {
      const response = await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionNo: `20260728-00${index + 1}`,
          submittedAt: `2026-07-28T${time}+08:00`,
          action: 'buy',
          reason: `第 ${index + 1} 次基金操作`,
          countsDaily: true,
        })
        .expect((res) => assert.ok([200, 201].includes(res.status), res.text));
      unwrapBody(response);
    }

    const fourth = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          decisionNo: '20260728-004',
          submittedAt: '2026-07-28T14:59:59+08:00',
          action: 'buy',
          reason: '第四次基金操作仍允许记录',
          countsDaily: true,
        })
        .expect(200),
    );
    assert.equal(fourth.counts_daily, 1);
    assert.equal(fourth.daily_sequence, 4);
  } finally {
    await fixture.cleanup();
  }
});

test('hold does not count by default while fund operations keep counting without a hard limit', async () => {
  const fixture = await createAppFixture('cancel-order-counts');

  try {
    const hold = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          submittedAt: '2026-07-28T09:30:00+08:00',
          action: 'hold',
          reason: '只是观察，不做基金操作',
          countsDaily: true,
        })
        .expect(200),
    );
    assert.equal(hold.counts_daily, 0);
    assert.equal(hold.daily_sequence, null);

    for (const [index, time] of ['10:00:00', '11:00:00', '13:00:00'].entries()) {
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          submittedAt: `2026-07-28T${time}+08:00`,
          action: 'buy',
          reason: `第 ${index + 1} 次基金操作`,
        })
        .expect(200);
    }

    const cancelDecision = unwrapBody(
      await request(fixture.app)
        .post('/api/decisions')
        .send({
          accountCode: CODEX_ACCOUNT_CODE,
          submittedAt: '2026-07-28T14:20:00+08:00',
          action: 'cancel_order',
          reason: '撤回一笔未确认订单',
        })
        .expect(200),
    );
    assert.equal(cancelDecision.counts_daily, 1);
    assert.equal(cancelDecision.daily_sequence, 4);
  } finally {
    await fixture.cleanup();
  }
});

test('market quote endpoint records index quotes without requiring a fund', async () => {
  const fixture = await createAppFixture('market-quotes');

  try {
    const response = await request(fixture.app)
      .post('/api/market/quotes')
      .send({
        quotes: [
          {
            symbol: '000905',
            name: '中证500',
            marketType: 'index',
            quoteDate: '2026-07-28',
            quoteTime: '14:50:15',
            quoteType: 'intraday',
            price: '7422.62',
            changePpm: -38600,
            source: '东方财富指数行情',
          },
        ],
      })
      .expect(200);

    const data = unwrapBody(response);
    assert.equal(data[0].symbol, '000905');
    assert.equal(data[0].name, '中证500');
    assert.equal(data[0].market_type, 'index');
    assert.equal(data[0].fund_code, null);
  } finally {
    await fixture.cleanup();
  }
});

test('positions endpoint and pages show holding return rates', async () => {
  const fixture = await createAppFixture('position-return-rates');

  try {
    seedConfirmedPosition(fixture.app.locals.ledger);

    const positions = unwrapBody(
      await request(fixture.app)
        .get('/api/positions')
        .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
        .expect(200),
    );
    assert.equal(positions.items[0].fundCode, 'A001');
    assert.equal(positions.items[0].returnPpm, 100000);
    assert.equal(positions.items[0].returnRate, 0.1);

    for (const path of ['/', '/account']) {
      const response = await request(fixture.app)
        .get(path)
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200);
      const $ = cheerio.load(response.text);
      assert.equal($('td.num.positive').filter((_, element) => $(element).text().trim() === '10.00%').length, 1);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('stylesheet uses red for gains and green for losses', async () => {
  const css = await readFile(new URL('../src/public/app.css', import.meta.url), 'utf8');

  assert.match(css, /\.positive\s*{\s*color:\s*var\(--red\);\s*}/);
  assert.match(css, /\.negative\s*{\s*color:\s*var\(--green\);\s*}/);
});

test('position history endpoint returns current holding daily details', async () => {
  const fixture = await createAppFixture('position-history');

  try {
    const { ledger } = fixture.app.locals;
    ledger.adjustCash({
      accountCode: CODEX_ACCOUNT_CODE,
      type: 'deposit',
      amount: '2000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
      note: '测试资金',
    });
    ledger.writeFundNav({
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-01',
      nav: '1.0000',
      source: '测试净值源',
    });
    ledger.writeFundNav({
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-02',
      nav: '1.1000',
      source: '测试净值源',
    });
    const decision = ledger.recordDecision({
      accountCode: CODEX_ACCOUNT_CODE,
      decisionNo: '20260101-001',
      decisionDate: '2026-01-01',
      submittedAt: '2026-01-01T14:30:00+08:00',
      action: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      reason: '测试买入',
    });
    ledger.createOrder({
      accountCode: CODEX_ACCOUNT_CODE,
      orderNo: '20260101-001',
      decisionId: decision.id,
      submittedAt: '2026-01-01T14:30:00+08:00',
      side: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      tradeDate: '2026-01-02',
      fee: '0.00',
    });
    ledger.confirmOrder({
      accountCode: CODEX_ACCOUNT_CODE,
      orderNo: '20260101-001',
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    ledger.createSnapshot({ accountCode: CODEX_ACCOUNT_CODE, snapshotDate: '2026-01-02' });

    const response = await request(fixture.app)
      .get('/api/positions/A001/history')
      .query({ accountCode: CODEX_ACCOUNT_CODE, page: 1, pageSize: 10 })
      .expect(200);
    const data = unwrapBody(response);

    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].fundCode, 'A001');
    assert.equal(data.items[0].fundName, '测试基金A');
    assert.equal(data.items[0].snapshotDate, '2026-01-02');
    assert.equal(data.items[0].nav, 1.1);
    assert.equal(data.items[0].navChangePpm, 100000);
    assert.equal(data.items[0].marketValue, 1100);
  } finally {
    await fixture.cleanup();
  }
});

test('account page exposes position history detail controls', async () => {
  const fixture = await createAppFixture('account-position-history');

  try {
    const { ledger } = fixture.app.locals;
    ledger.adjustCash({
      accountCode: CODEX_ACCOUNT_CODE,
      type: 'deposit',
      amount: '2000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
      note: '测试资金',
    });
    ledger.writeFundNav({
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-02',
      nav: '1.1000',
      source: '测试净值源',
    });
    const decision = ledger.recordDecision({
      accountCode: CODEX_ACCOUNT_CODE,
      decisionDate: '2026-01-01',
      submittedAt: '2026-01-01T14:30:00+08:00',
      action: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      reason: '测试买入',
    });
    ledger.createOrder({
      accountCode: CODEX_ACCOUNT_CODE,
      orderNo: '20260101-001',
      decisionId: decision.id,
      submittedAt: '2026-01-01T14:30:00+08:00',
      side: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      tradeDate: '2026-01-02',
      fee: '0.00',
    });
    ledger.confirmOrder({
      accountCode: CODEX_ACCOUNT_CODE,
      orderNo: '20260101-001',
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    ledger.createSnapshot({ accountCode: CODEX_ACCOUNT_CODE, snapshotDate: '2026-01-02' });

    const response = await request(fixture.app)
      .get('/account')
      .query({ accountCode: CODEX_ACCOUNT_CODE })
      .expect(200);
    const $ = cheerio.load(response.text);

    assert.equal($('[data-position-history-button][data-fund-code="A001"]').length, 1);
    assert.equal($('[data-position-history-modal]').length, 1);
    assert.match(response.text, /\/api\/positions\/.*\/history/);
    assert.match(response.text, /payload\?\.data\?\.items/);
  } finally {
    await fixture.cleanup();
  }
});

test('admin page shows all-account analysis panels and latest AI analysis area', async () => {
  const fixture = await createAppFixture('admin-page');

  try {
    const { ledger } = fixture.app.locals;
    ledger.createAccount({
      accountCode: 'alt',
      name: '备用账户',
      initialCash: '5000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
    });

    const response = await request(fixture.app).get('/admin').expect(200);
    const $ = cheerio.load(response.text);

    assert.match($('h1').text(), /管理后台/);
    assert.match(response.text, /AI分析/);
    assert.match(response.text, /account-codex/);
    assert.match(response.text, /备用账户/);
    assert.equal($('[data-admin-ai-button]').length, 1);
    assert.equal($('[data-admin-ai-result]').length, 1);
    assert.ok($('a[href="/admin"]').length > 0);
  } finally {
    await fixture.cleanup();
  }
});

test('admin AI analysis endpoint requires a DeepSeek API key or injected client', async () => {
  const fixture = await createAppFixture('admin-ai-no-key', {
    env: { DEEPSEEK_API_KEY: '' },
  });

  try {
    const response = await request(fixture.app)
      .post('/api/admin/ai-analysis')
      .expect(500);

    assert.equal(response.body.ok, false);
    assert.match(response.body.error.message, /DEEPSEEK_API_KEY/);

    const latest = await request(fixture.app)
      .get('/api/admin/ai-analysis/latest')
      .expect(200);
    assert.equal(latest.body.ok, true);
    assert.equal(latest.body.data, null);
  } finally {
    await fixture.cleanup();
  }
});

test('admin AI analysis endpoint saves mock DeepSeek response and exposes latest run', async () => {
  const calls = [];
  const fixture = await createAppFixture('admin-ai-mock', {
    deepSeekClient: {
      chat: {
        completions: {
          create: async (payload) => {
            calls.push(payload);
            return {
              choices: [
                { message: { content: 'AI分析：备用账户收益更激进，A001 推荐多关注。' } },
              ],
            };
          },
        },
      },
    },
  });

  try {
    const { ledger } = fixture.app.locals;
    ledger.createAccount({
      accountCode: 'alt',
      name: '备用账户',
      initialCash: '10000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
    });
    seedConfirmedPosition(ledger, {
      accountCode: 'alt',
      code: 'A001',
      fundName: '测试基金A',
      amount: '1000.00',
      orderNo: 'alt-20260101-001',
      latestDate: '2026-01-04',
      latestNav: '1.1000',
    });

    const generated = unwrapBody(
      await request(fixture.app)
        .post('/api/admin/ai-analysis')
        .expect(200),
    );
    const latest = unwrapBody(
      await request(fixture.app)
        .get('/api/admin/ai-analysis/latest')
        .expect(200),
    );

    assert.equal(generated.status, 'success');
    assert.match(generated.content, /A001 推荐多关注/);
    assert.equal(latest.id, generated.id);
    assert.equal(calls[0].model, 'deepseek-v4-pro');
    assert.match(calls[0].messages[1].content, /备用账户/);
  } finally {
    await fixture.cleanup();
  }
});

test('admin SQL endpoint executes update statements', async () => {
  const fixture = await createAppFixture('admin-sql-update');

  try {
    const result = unwrapBody(
      await request(fixture.app)
        .post('/api/admin/sql')
        .send({
          sql: "UPDATE accounts SET name = 'manual-edit' WHERE code = 'account-codex';",
        })
        .expect(200),
    );

    assert.equal(result.executed, true);
    assert.equal(typeof result.elapsedMs, 'number');
    assert.ok(result.elapsedMs >= 0);

    const accounts = unwrapBody(await request(fixture.app).get('/api/accounts').expect(200));
    assert.equal(
      accounts.find((account) => account.accountCode === CODEX_ACCOUNT_CODE).name,
      'manual-edit',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('admin SQL endpoint executes multi-statement and caller-managed transaction SQL', async () => {
  const fixture = await createAppFixture('admin-sql-multi');

  try {
    unwrapBody(
      await request(fixture.app)
        .post('/api/admin/sql')
        .send({
          sql: [
            "UPDATE accounts SET cash_available_cents = 12345 WHERE code = 'account-codex';",
            "UPDATE accounts SET cash_frozen_cents = 678 WHERE code = 'account-codex';",
          ].join('\n'),
        })
        .expect(200),
    );

    let balance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(balance.cashAvailable, 123.45);
    assert.equal(balance.cashFrozen, 6.78);

    unwrapBody(
      await request(fixture.app)
        .post('/api/admin/sql')
        .send({
          sql: [
            'BEGIN IMMEDIATE;',
            "UPDATE accounts SET cash_available_cents = 22222 WHERE code = 'account-codex';",
            "UPDATE accounts SET cash_frozen_cents = 0 WHERE code = 'account-codex';",
            'COMMIT;',
          ].join('\n'),
        })
        .expect(200),
    );

    balance = unwrapBody(
      await request(fixture.app)
        .get('/api/account/balance')
        .query({ accountCode: CODEX_ACCOUNT_CODE })
        .expect(200),
    );
    assert.equal(balance.cashAvailable, 222.22);
    assert.equal(balance.cashFrozen, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('admin SQL endpoint validates sql payload', async () => {
  const fixture = await createAppFixture('admin-sql-validation');

  try {
    for (const payload of [{}, { sql: '' }, { sql: '   ' }, { sql: 123 }]) {
      const response = await request(fixture.app)
        .post('/api/admin/sql')
        .send(payload)
        .expect(400);

      assert.equal(response.body.ok, false);
      assert.equal(response.body.error.code, 'BAD_REQUEST');
      assert.match(response.body.error.message, /sql/i);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('admin SQL endpoint returns SQL_EXECUTION_FAILED for invalid SQL without crashing', async () => {
  const fixture = await createAppFixture('admin-sql-invalid');

  try {
    const response = await request(fixture.app)
      .post('/api/admin/sql')
      .send({ sql: 'UPDATE accounts SET WHERE;' })
      .expect(400);

    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'SQL_EXECUTION_FAILED');
    assert.match(response.body.error.message, /syntax|near|SQLITE/i);

    unwrapBody(await request(fixture.app).get('/api/health').expect(200));
  } finally {
    await fixture.cleanup();
  }
});
