import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function createFixture(name) {
  const root = path.join(os.tmpdir(), `fund-sim-tool-admin-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const [{ openDatabase }, { initializeDatabase }, { createLedgerService }, { createAdminAnalysisService }] =
    await Promise.all([
      import('../src/db/connection.js'),
      import('../src/db/init.js'),
      import('../src/services/ledgerService.js'),
      import('../src/services/adminAnalysisService.js'),
    ]);

  const db = openDatabase(path.join(root, 'admin.sqlite'));
  initializeDatabase(db);
  const ledger = createLedgerService(db);
  ledger.setupDefaultAccount({
    initialCash: '10000.00',
    occurredAt: '2026-01-01T09:00:00+08:00',
  });

  return {
    db,
    ledger,
    createService(options = {}) {
      return createAdminAnalysisService(db, options);
    },
    async cleanup() {
      db.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function seedPosition(ledger, {
  accountCode,
  fundCode,
  fundName,
  amount,
  latestNav,
  orderNo,
}) {
  ledger.writeFundNav({
    code: fundCode,
    fundName,
    navDate: '2026-01-02',
    nav: '1.0000',
    source: '测试买入净值源',
  });
  const decision = ledger.recordDecision({
    accountCode,
    decisionDate: '2026-01-01',
    submittedAt: '2026-01-01T14:30:00+08:00',
    action: 'buy',
    fundCode,
    fundName,
    amount,
    reason: `${accountCode} 买入 ${fundName}`,
  });
  ledger.createOrder({
    accountCode,
    orderNo,
    decisionId: decision.id,
    submittedAt: '2026-01-01T14:30:00+08:00',
    side: 'buy',
    fundCode,
    fundName,
    amount,
    tradeDate: '2026-01-02',
    fee: '0.00',
  });
  ledger.confirmOrder({
    accountCode,
    orderNo,
    confirmDate: '2026-01-03',
    settleDate: '2026-01-03',
    nav: '1.0000',
  });
  ledger.writeFundNav({
    code: fundCode,
    fundName,
    navDate: '2026-01-04',
    nav: latestNav,
    source: '测试最新净值源',
  });
}

test('admin analysis service aggregates all accounts with return risk and concentration metrics', async () => {
  const fixture = await createFixture('aggregate');

  try {
    fixture.ledger.createAccount({
      accountCode: 'alt',
      name: '备用账户',
      initialCash: '10000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
    });
    seedPosition(fixture.ledger, {
      accountCode: 'account-codex',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '2000.00',
      latestNav: '1.2000',
      orderNo: 'account-codex-20260101-001',
    });
    seedPosition(fixture.ledger, {
      accountCode: 'alt',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1000.00',
      latestNav: '1.2000',
      orderNo: 'alt-20260101-001',
    });
    seedPosition(fixture.ledger, {
      accountCode: 'alt',
      fundCode: 'B001',
      fundName: '测试基金B',
      amount: '3000.00',
      latestNav: '0.9000',
      orderNo: 'alt-20260101-002',
    });
    fixture.ledger.createSnapshot({ accountCode: 'account-codex', snapshotDate: '2026-01-03' });
    fixture.ledger.createSnapshot({ accountCode: 'alt', snapshotDate: '2026-01-03' });
    fixture.ledger.createSnapshot({ accountCode: 'account-codex', snapshotDate: '2026-01-04' });
    fixture.ledger.createSnapshot({ accountCode: 'alt', snapshotDate: '2026-01-04' });

    const dashboard = fixture.createService().getAdminViewModel();

    assert.deepEqual(
      dashboard.accounts.map((account) => account.accountCode),
      ['account-codex', 'alt'],
    );
    const codex = dashboard.accounts.find((account) => account.accountCode === 'account-codex');
    const alt = dashboard.accounts.find((account) => account.accountCode === 'alt');
    assert.equal(codex.totalAssets, 10400);
    assert.equal(codex.accumulatedPnl, 400);
    assert.equal(codex.returnRate, 0.04);
    assert.equal(codex.positionCount, 1);
    assert.equal(codex.concentrationRate, 1);
    assert.equal(codex.operationCount, 1);
    assert.equal(alt.positionCount, 2);
    assert.ok(alt.pnlVolatility > 0);
    assert.equal(dashboard.funds[0].fundCode, 'A001');
    assert.equal(dashboard.funds[0].holdingAccountCount, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('admin analysis service handles empty accounts without snapshots or positions', async () => {
  const fixture = await createFixture('empty');

  try {
    fixture.ledger.createAccount({
      accountCode: 'empty',
      name: '空账户',
      initialCash: '5000.00',
      occurredAt: '2026-01-01T09:00:00+08:00',
    });

    const dashboard = fixture.createService().getAdminViewModel();
    const empty = dashboard.accounts.find((account) => account.accountCode === 'empty');

    assert.equal(empty.totalAssets, 5000);
    assert.equal(empty.positionCount, 0);
    assert.equal(empty.maxDrawdownRate, null);
    assert.equal(empty.pnlVolatility, null);
    assert.equal(empty.concentrationRate, null);
    assert.deepEqual(dashboard.funds, []);
  } finally {
    await fixture.cleanup();
  }
});

test('admin analysis service saves mock DeepSeek analysis and exposes latest run', async () => {
  const fixture = await createFixture('ai-run');
  const calls = [];
  const deepSeekClient = {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          return {
            choices: [
              { message: { content: 'AI分析：A001 值得多关注，account-codex 风控更稳。' } },
            ],
          };
        },
      },
    },
  };

  try {
    seedPosition(fixture.ledger, {
      accountCode: 'account-codex',
      fundCode: 'A001',
      fundName: '测试基金A',
      amount: '1000.00',
      latestNav: '1.1000',
      orderNo: 'account-codex-20260101-001',
    });
    fixture.ledger.createSnapshot({ accountCode: 'account-codex', snapshotDate: '2026-01-04' });

    const service = fixture.createService({ deepSeekClient });
    const run = await service.runAiAnalysis();
    const latest = service.getLatestAiAnalysis();

    assert.equal(run.status, 'success');
    assert.match(run.content, /A001 值得多关注/);
    assert.equal(latest.id, run.id);
    assert.equal(latest.status, 'success');
    assert.equal(calls[0].model, 'deepseek-v4-pro');
    assert.deepEqual(calls[0].thinking, { type: 'enabled' });
    assert.equal(calls[0].reasoning_effort, 'high');
    assert.match(calls[0].messages[0].content, /只能使用用户消息中的本地账本数据/);
    assert.match(calls[0].messages[1].content, /测试基金A/);
  } finally {
    await fixture.cleanup();
  }
});
