import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacyDir = path.resolve(projectRoot, '..', 'fund-sim');

async function createDatabaseFixture(name) {
  const root = path.join(os.tmpdir(), `fund-sim-tool-import-${name}-${Date.now()}`);
  await mkdir(root, { recursive: true });

  const [{ openDatabase }, { initializeDatabase }] = await Promise.all([
    import('../src/db/connection.js'),
    import('../src/db/init.js'),
  ]);

  const db = openDatabase(path.join(root, 'import.sqlite'));
  initializeDatabase(db);

  return {
    db,
    async cleanup() {
      db.close?.();
      await rm(root, { recursive: true, force: true });
    },
  };
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

test('legacy import migrates the current account state and July 28 decisions', async () => {
  const fixture = await createDatabaseFixture('current-history');

  try {
    const { importLegacyData } = await import('../src/importers/legacyImport.js');
    const result = await importLegacyData({ db: fixture.db, legacyDir, reset: true });
    const balance = result.balance ?? result.account ?? result.summary;

    assert.equal(pickMoney(balance, ['cash', 'availableCash', 'available_cash']), '5000.00');
    assert.equal(pickMoney(balance, ['totalAssets', 'totalAsset', 'total_assets']), '10006.09');

    const positions = result.positions ?? balance.positions ?? [];
    assert.deepEqual(
      positions
        .map((position) => position.code ?? position.fundCode ?? position.fund_code)
        .sort(),
      ['006087', '007466'],
    );

    const july28Decisions = (result.decisions ?? []).filter((decision) => {
      const submittedDate =
        decision.submittedDate ??
        decision.submitted_date ??
        String(decision.submittedAt ?? decision.submitted_at ?? '').slice(0, 10);
      return submittedDate === '2026-07-28';
    });

    assert.equal(july28Decisions.length, 2);
    assert.deepEqual(
      july28Decisions.map((decision) => decision.decisionNo ?? decision.decision_no),
      ['20260728-001', '20260728-002'],
    );
    assert.ok(
      july28Decisions.every((decision) =>
        ['hold', 'none', 'noop', '不操作'].includes(decision.action ?? decision.actionType),
      ),
    );
    assert.ok(
      july28Decisions.every((decision) =>
        String(decision.actionPath ?? decision.action_path ?? '').startsWith('actions/'),
      ),
    );
  } finally {
    await fixture.cleanup();
  }
});
