import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CODEX_ACCOUNT_CODE = 'account-codex';

async function createLedgerFixture(name) {
  const root = path.join(os.tmpdir(), `fund-sim-tool-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const [{ openDatabase }, { initializeDatabase }, { createLedgerService }] =
    await Promise.all([
      import('../src/db/connection.js'),
      import('../src/db/init.js'),
      import('../src/services/ledgerService.js'),
    ]);

  const db = openDatabase(path.join(root, 'ledger.sqlite'));
  initializeDatabase(db);
  const ledger = createLedgerService(db);
  await call(ledger, ['setupDefaultAccount', 'initializeAccount', 'createAccount'], {
    initialCash: '10000.00',
    occurredAt: '2026-07-23T09:00:00+08:00',
  });

  return {
    db,
    ledger,
    async cleanup() {
      db.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function requireMethod(target, names) {
  for (const name of names) {
    if (typeof target[name] === 'function') return target[name].bind(target);
  }

  assert.fail(`Ledger service is missing one of: ${names.join(', ')}`);
}

async function call(target, names, payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return requireMethod(target, names)({
      accountCode: CODEX_ACCOUNT_CODE,
      ...payload,
    });
  }

  return requireMethod(target, names)(payload);
}

function unwrap(value) {
  return value?.data ?? value;
}

function asMoney(value) {
  if (value == null) return value;
  if (typeof value === 'number') return value.toFixed(2);
  if (typeof value === 'bigint') return (Number(value) / 100).toFixed(2);

  const text = String(value).trim();
  if (/^-?\d+$/.test(text) && Math.abs(Number(text)) > 100000) {
    return (Number(text) / 100).toFixed(2);
  }

  const match = text.replaceAll(',', '').match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]).toFixed(2) : text;
}

function asShares(value) {
  if (value == null) return value;
  if (typeof value === 'number') return value.toFixed(4);

  const text = String(value).trim();
  if (/^-?\d+$/.test(text) && Math.abs(Number(text)) > 100000) {
    return (Number(text) / 10000).toFixed(4);
  }

  const match = text.replaceAll(',', '').match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]).toFixed(4) : text;
}

function pickMoney(source, keys) {
  const pools = [source, source?.balance, source?.account, source?.snapshot].filter(Boolean);
  for (const pool of pools) {
    for (const key of keys) {
      const value = pool?.[key];
      if (value == null) {
        continue;
      }
      return key.toLowerCase().includes('cents')
        ? (Number(value) / 100).toFixed(2)
        : asMoney(value);
    }
  }
  return undefined;
}

function findPosition(balance, code) {
  if (Array.isArray(balance)) {
    return balance.find((position) => {
      const positionCode = position.code ?? position.fundCode ?? position.fund_code;
      return positionCode === code;
    });
  }

  const positions =
    balance?.positions ??
    balance?.holdings ??
    balance?.snapshot?.positions ??
    balance?.account?.positions ??
    [];

  return positions.find((position) => {
    const positionCode = position.code ?? position.fundCode ?? position.fund_code;
    return positionCode === code;
  });
}

test('setupDefaultAccount migrates legacy default account to account-codex', async () => {
  const root = path.join(os.tmpdir(), `fund-sim-tool-default-migration-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const [{ openDatabase }, { initializeDatabase }, { createLedgerService }] =
    await Promise.all([
      import('../src/db/connection.js'),
      import('../src/db/init.js'),
      import('../src/services/ledgerService.js'),
    ]);

  const db = openDatabase(path.join(root, 'ledger.sqlite'));
  try {
    initializeDatabase(db);
    db.prepare(
      `INSERT INTO accounts (
        code,
        name,
        initial_cash_cents,
        cash_available_cents
      ) VALUES (
        'default',
        '模拟账户',
        1000000,
        400000
      )`,
    ).run();

    const ledger = createLedgerService(db);
    ledger.setupDefaultAccount({
      initialCash: '10000.00',
      occurredAt: '2026-07-31T09:00:00+08:00',
    });

    const accounts = db.prepare('SELECT code, name FROM accounts ORDER BY id').all()
      .map((account) => ({ ...account }));
    assert.deepEqual(accounts, [{ code: 'account-codex', name: 'account-codex' }]);
    assert.throws(() => ledger.getAccountBalance(), /account/i);
    assert.equal(
      ledger.getAccountBalance({ accountCode: CODEX_ACCOUNT_CODE }).accountCode,
      CODEX_ACCOUNT_CODE,
    );
    assert.equal(ledger.getAccountBalance({ accountCode: CODEX_ACCOUNT_CODE }).cashAvailable, 4000);
  } finally {
    db.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('buy order confirmation decreases cash, confirms shares, and snapshots assets', async () => {
  const fixture = await createLedgerFixture('buy-flow');

  try {
    await call(fixture.ledger, ['recordDecision', 'createDecision'], {
      decisionNo: '20260723-001',
      submittedAt: '2026-07-23T16:14:37+08:00',
      action: 'buy',
      fundCode: '007466',
      fundName: '华泰柏瑞中证红利低波ETF联接A',
      amount: '3000.00',
      reason: '收盘后先建 30% 红利低波底仓',
      countsDaily: true,
    });

    await call(fixture.ledger, ['submitOrder', 'createOrder', 'recordOrder'], {
      orderNo: '20260723-001',
      decisionNo: '20260723-001',
      submittedAt: '2026-07-23T16:14:37+08:00',
      action: 'buy',
      fundCode: '007466',
      fundName: '华泰柏瑞中证红利低波ETF联接A',
      amount: '3000.00',
      fee: '3.60',
      applyTradeDate: '2026-07-24',
    });

    const afterSubmit = unwrap(
      await call(fixture.ledger, ['getAccountSummary', 'getBalance', 'getAccountBalance'], {}),
    );
    assert.equal(
      pickMoney(afterSubmit, ['availableCash', 'cash', 'cashAvailable', 'available_cash']),
      '7000.00',
    );

    await call(fixture.ledger, ['confirmOrder', 'confirmBuyOrder'], {
      orderNo: '20260723-001',
      confirmedAt: '2026-07-27T09:37:08+08:00',
      confirmDate: '2026-07-27',
      navDate: '2026-07-24',
      nav: '1.6081',
      fee: '3.60',
    });

    const afterConfirm = unwrap(
      await call(fixture.ledger, ['getAccountSummary', 'getBalance', 'getAccountBalance'], {}),
    );
    const positions = unwrap(
      await call(fixture.ledger, ['listPositions', 'getPositions'], {}),
    );
    const position = findPosition(positions, '007466');

    assert.ok(position, 'confirmed buy should create a 007466 position');
    assert.equal(asShares(position.shares ?? position.shareAmount ?? position.sharesInt), '1863.3170');
    assert.equal(asMoney(position.marketValue ?? position.marketValueCents), '2996.40');
    assert.equal(
      pickMoney(afterConfirm, ['availableCash', 'cash', 'cashAvailable', 'available_cash']),
      '7000.00',
    );
    assert.equal(
      pickMoney(afterConfirm, ['totalAssets', 'totalAsset', 'total_assets_cents']),
      '9996.40',
    );

    const snapshot = unwrap(
      await call(fixture.ledger, ['createSnapshot', 'recordSnapshot', 'writeSnapshot'], {
        snapshotDate: '2026-07-27',
        navs: [{ fundCode: '007466', nav: '1.6081', navDate: '2026-07-24' }],
      }),
    );

    assert.equal(
      pickMoney(snapshot, ['totalAssets', 'totalAsset', 'total_assets_cents']),
      '9996.40',
    );
  } finally {
    await fixture.cleanup();
  }
});

test('counted decisions are limited to three per local date', async () => {
  const fixture = await createLedgerFixture('daily-limit');

  try {
    for (const [index, time] of ['09:30:00', '12:01:04', '14:50:15'].entries()) {
      await call(fixture.ledger, ['recordDecision', 'createDecision'], {
        decisionNo: `20260728-00${index + 1}`,
        submittedAt: `2026-07-28T${time}+08:00`,
        action: 'hold',
        reason: `第 ${index + 1} 次不操作`,
        countsDaily: true,
      });
    }

    await assert.rejects(
      () =>
        call(fixture.ledger, ['recordDecision', 'createDecision'], {
          decisionNo: '20260728-004',
          submittedAt: '2026-07-28T14:59:59+08:00',
          action: 'hold',
          reason: '超过每日次数限制的不操作',
          countsDaily: true,
        }),
      /daily|limit|decision|次数|上限|最多|3/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('position history starts at buy trade date and calculates nav change and pnl rate', async () => {
  const fixture = await createLedgerFixture('position-history');

  try {
    await call(fixture.ledger, ['writeFundNav', 'recordFundNav'], {
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-01',
      nav: '1.0000',
      source: '测试净值源',
    });
    await call(fixture.ledger, ['writeFundNav', 'recordFundNav'], {
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-02',
      nav: '1.1000',
      source: '测试净值源',
    });
    await call(fixture.ledger, ['writeFundNav', 'recordFundNav'], {
      code: 'A001',
      fundName: '测试基金A',
      navDate: '2026-01-03',
      nav: '1.2100',
      source: '测试净值源',
    });

    const decision = await call(fixture.ledger, ['recordDecision', 'createDecision'], {
      decisionNo: '20260101-001',
      decisionDate: '2026-01-01',
      submittedAt: '2026-01-01T14:30:00+08:00',
      action: 'buy',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1100.00',
      reason: '15点前买入，下一日按买入交易日净值确认',
      countsDaily: true,
    });

    await call(fixture.ledger, ['submitOrder', 'createOrder', 'recordOrder'], {
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
    await call(fixture.ledger, ['confirmOrder', 'confirmBuyOrder'], {
      orderNo: '20260101-001',
      confirmDate: '2026-01-03',
      settleDate: '2026-01-03',
      nav: '1.1000',
    });
    await call(fixture.ledger, ['createSnapshot', 'recordSnapshot', 'writeSnapshot'], {
      snapshotDate: '2026-01-02',
      note: '补买入交易日净值快照',
    });
    await call(fixture.ledger, ['createSnapshot', 'recordSnapshot', 'writeSnapshot'], {
      snapshotDate: '2026-01-03',
      note: '次日持仓快照',
    });

    const history = await call(fixture.ledger, ['getPositionHistory', 'listPositionHistory'], {
      fundCode: 'A001',
      paginated: true,
      page: 1,
      pageSize: 10,
    });

    assert.equal(history.items.length, 2);
    assert.equal(history.items[0].snapshotDate, '2026-01-03');
    assert.equal(history.items[1].snapshotDate, '2026-01-02');
    assert.equal(history.items[1].nav, 1.1);
    assert.equal(history.items[1].navChangePpm, 100000);
    assert.equal(history.items[1].shares, 1000);
    assert.equal(history.items[1].marketValue, 1100);
    assert.equal(history.items[1].unrealizedPnl, 0);
    assert.equal(history.items[1].returnPpm, 0);
    assert.equal(history.items[0].nav, 1.21);
    assert.equal(history.items[0].navChangePpm, 100000);
    assert.equal(history.items[0].marketValue, 1210);
    assert.equal(history.items[0].unrealizedPnl, 110);
    assert.equal(history.items[0].returnPpm, 100000);
  } finally {
    await fixture.cleanup();
  }
});
