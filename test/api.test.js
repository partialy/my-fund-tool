import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
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
