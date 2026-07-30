import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as cheerio from 'cheerio';
import request from 'supertest';

async function createAppFixture(name) {
  const root = path.join(os.tmpdir(), `fund-sim-tool-api-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const { createApp } = await import('../src/app.js');
  const dbPath = path.join(root, 'api.sqlite');

  const app = createApp({ dbPath });
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

async function seedDecisionRows(app, count) {
  for (let index = 1; index <= count; index += 1) {
    const day = String(index).padStart(2, '0');
    const note = `D-${day}`;
    const response = await request(app)
      .post('/api/decisions')
      .send({
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
    decisionDate: '2026-01-01',
    submittedAt: '2026-01-01T14:30:00+08:00',
    action: 'buy',
    fundCode: code,
    fundName,
    amount,
    reason: '测试买入',
  });
  ledger.createOrder({
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
  ledger.createSnapshot({ snapshotDate: latestDate });
}

test('cash adjustment endpoint applies deposit, withdraw, and correction', async () => {
  const fixture = await createAppFixture('cash-adjustments');

  try {
    for (const payload of [
      {
        type: 'deposit',
        amount: '10000.00',
        occurredAt: '2026-07-23T09:00:00+08:00',
        reason: '初始资金',
      },
      {
        type: 'withdraw',
        amount: '1200.50',
        occurredAt: '2026-07-23T10:00:00+08:00',
        reason: '测试减少现金',
      },
      {
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

    const balance = unwrapBody(await request(fixture.app).get('/api/account/balance').expect(200));
    assert.equal(
      pickMoney(balance, ['availableCash', 'cash', 'cashAvailable', 'available_cash']),
      '5000.00',
    );
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
      .query({ page: 2, pageSize: 5 })
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

    const firstPage = await request(fixture.app).get('/operations').expect(200);
    const $first = cheerio.load(firstPage.text);
    const firstTimeline = $first('section.glass-panel').first();

    assert.equal(firstTimeline.find('tbody tr.click-row').length, 10);
    assert.match(firstTimeline.text(), /第\s*1\s*\/\s*2\s*页/);
    assert.ok(firstTimeline.find('a[href*="decisionPage=2"]').length > 0);

    const secondPage = await request(fixture.app).get('/operations?decisionPage=2').expect(200);
    const $second = cheerio.load(secondPage.text);
    const secondTimeline = $second('section.glass-panel').first();

    assert.equal(secondTimeline.find('tbody tr.click-row').length, 2);
    assert.match(secondTimeline.text(), /第\s*2\s*\/\s*2\s*页/);
    assert.ok(secondTimeline.find('a[href*="decisionPage=1"]').length > 0);
  } finally {
    await fixture.cleanup();
  }
});

test('decision endpoint rejects the fourth counted decision on one date', async () => {
  const fixture = await createAppFixture('decision-limit');

  try {
    for (const [index, time] of ['09:30:00', '12:01:04', '14:50:15'].entries()) {
      const response = await request(fixture.app)
        .post('/api/decisions')
        .send({
          decisionNo: `20260728-00${index + 1}`,
          submittedAt: `2026-07-28T${time}+08:00`,
          action: 'hold',
          reason: `第 ${index + 1} 次不操作`,
          countsDaily: true,
        })
        .expect((res) => assert.ok([200, 201].includes(res.status), res.text));
      unwrapBody(response);
    }

    const rejected = await request(fixture.app).post('/api/decisions').send({
      decisionNo: '20260728-004',
      submittedAt: '2026-07-28T14:59:59+08:00',
      action: 'hold',
      reason: '超过每日次数限制的不操作',
      countsDaily: true,
    });

    assert.ok([400, 409, 429].includes(rejected.status), rejected.text);
    assert.equal(rejected.body.ok, false);
    assert.match(
      String(rejected.body.error?.message ?? rejected.body.error ?? ''),
      /daily|limit|decision|次数|上限|最多|3/i,
    );
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
      await request(fixture.app).get('/api/positions?page=1&pageSize=10').expect(200),
    );
    assert.equal(positions.items[0].fundCode, 'A001');
    assert.equal(positions.items[0].returnPpm, 100000);
    assert.equal(positions.items[0].returnRate, 0.1);

    for (const path of ['/', '/account']) {
      const response = await request(fixture.app).get(path).expect(200);
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
      orderNo: '20260101-001',
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    ledger.createSnapshot({ snapshotDate: '2026-01-02' });

    const response = await request(fixture.app)
      .get('/api/positions/A001/history?page=1&pageSize=10')
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
      decisionDate: '2026-01-01',
      submittedAt: '2026-01-01T14:30:00+08:00',
      action: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      reason: '测试买入',
    });
    ledger.createOrder({
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
      orderNo: '20260101-001',
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    ledger.createSnapshot({ snapshotDate: '2026-01-02' });

    const response = await request(fixture.app).get('/account').expect(200);
    const $ = cheerio.load(response.text);

    assert.equal($('[data-position-history-button][data-fund-code="A001"]').length, 1);
    assert.equal($('[data-position-history-modal]').length, 1);
    assert.match(response.text, /\/api\/positions\/.*\/history/);
    assert.match(response.text, /payload\?\.data\?\.items/);
  } finally {
    await fixture.cleanup();
  }
});
