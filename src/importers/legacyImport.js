import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const importerDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(importerDir, '../..');

export const defaultLegacyDir = path.resolve(projectRoot, '..', 'fund-sim');

const KNOWN_TABLES = [
  'source_refs',
  'data_sources',
  'snapshot_positions',
  'account_snapshots',
  'pnl_entries',
  'positions',
  'orders',
  'decisions',
  'market_quotes',
  'fund_navs',
  'funds',
  'trading_calendar',
  'cash_ledger',
  'accounts',
];

export async function importLegacyData({
  db,
  ledger,
  legacyDir = defaultLegacyDir,
  reset = false,
} = {}) {
  if (!db && !ledger) {
    throw new Error('importLegacyData requires db or ledger.');
  }

  const dataset = await parseLegacyData({ legacyDir });
  if (reset && db) {
    resetDatabase(db);
  }

  const service = ledger ?? await createService(db);
  if (service) {
    importWithLedgerService(service, dataset);
    syncLegacyPositions(db, dataset);
    service.createSnapshot?.({
      snapshotDate: dataset.latestUpdatedAt?.slice(0, 10) ?? '2026-07-28',
      note: 'Legacy import current account snapshot.',
    });
    persistSupplementalRows(db, dataset);
  } else if (db) {
    persistRawRows(db, dataset);
  }

  return buildImportResult(dataset, {
    reset,
    legacyDir,
    persisted: Boolean(db || service),
  });
}

export async function parseLegacyData({ legacyDir = defaultLegacyDir } = {}) {
  const [operations, account, pnlEntries, actionDetails] = await Promise.all([
    parseOperationLog(path.join(legacyDir, 'operation-log.html')),
    parseAccountInfo(path.join(legacyDir, 'account-info.html')),
    parseProfitLog(path.join(legacyDir, 'profit-log.html')),
    parseActionDetails(path.join(legacyDir, 'actions'), legacyDir),
  ]);

  const actionByNo = new Map(actionDetails.map((action) => [action.decisionNo, action]));
  const decisions = operations.map((operation) => {
    const action = actionByNo.get(operation.orderNo);
    return {
      decisionNo: operation.orderNo,
      submittedAt: operation.submittedAt,
      submittedDate: operation.submittedDate,
      submittedTime: operation.submittedTime,
      action: operation.actionType,
      actionText: operation.actionText,
      fundCode: singleCode(operation.fundCodes),
      fundName: singleCode(operation.fundCodes) ? operation.fundName : null,
      amount: operation.amount,
      shares: operation.shares,
      nav: operation.confirmNav,
      fee: operation.fee,
      reason: action?.reason || operation.reason,
      countsDaily: true,
      dailySequence: inferDailySequence(operation.orderNo),
      actionPath: action?.relativePath ?? null,
      status: operation.statusText,
      sources: operation.sources,
    };
  });

  const orders = operations
    .filter((operation) => operation.actionType === 'buy' || operation.actionType === 'sell')
    .map((operation) => ({
      orderNo: operation.orderNo,
      decisionNo: operation.orderNo,
      submittedAt: operation.submittedAt,
      side: operation.actionType,
      fundCode: singleCode(operation.fundCodes),
      fundName: operation.fundName,
      amount: operation.amount,
      shares: operation.shares,
      fee: operation.fee,
      tradeDate: nullableDate(operation.applicationTradeDate),
      confirmDate: nullableDate(operation.confirmDate),
      settleDate: nullableDate(operation.settleDate),
      confirmNav: operation.confirmNav,
      status: operation.statusText.includes('已确认') ? 'confirmed' : 'submitted',
      note: operation.reason,
    }));

  const funds = collectFunds({ operations, account });

  return {
    legacyDir,
    latestUpdatedAt: account.latestUpdatedAt ?? operations.at(-1)?.submittedAt ?? null,
    account,
    funds,
    positions: account.positions,
    operations,
    decisions,
    orders,
    pnlEntries,
    actionDetails,
  };
}

function importWithLedgerService(service, dataset) {
  service.setupDefaultAccount?.({
    initialCash: dataset.account.initialCash ?? '10000.00',
    occurredAt: `${dataset.operations[0]?.submittedDate ?? '2026-07-23'}T09:00:00+08:00`,
  });

  for (const fund of dataset.funds) {
    service.upsertFund?.({
      code: fund.code,
      name: fund.name,
      category: fund.category,
    });
  }

  const decisionRowsByNo = new Map();

  for (const decision of dataset.decisions) {
    const decisionRow = service.recordDecision?.({
      decisionDate: decision.submittedDate,
      submittedAt: decision.submittedAt,
      action: decision.action,
      fundCode: decision.fundCode,
      fundName: decision.fundName,
      amount: decision.amount,
      shares: decision.shares,
      nav: decision.nav,
      reason: decision.reason,
      countsDaily: decision.countsDaily,
      legacyPath: decision.actionPath,
      note: decision.decisionNo,
    });
    if (decisionRow) {
      decisionRowsByNo.set(decision.decisionNo, decisionRow);
    }

    const order = dataset.orders.find((item) => item.orderNo === decision.decisionNo);
    if (!order) {
      continue;
    }

    const orderRow = service.createOrder?.({
      orderNo: order.orderNo,
      decisionId: decisionRow?.id,
      side: order.side,
      fundCode: order.fundCode,
      fundName: order.fundName,
      amount: order.amount,
      shares: order.shares,
      fee: order.fee,
      submittedAt: order.submittedAt,
      tradeDate: order.tradeDate,
      note: order.note,
    });

    if (orderRow && order.status === 'confirmed' && order.confirmNav) {
      service.confirmOrder?.({
        orderNo: order.orderNo,
        confirmDate: order.confirmDate,
        settleDate: order.settleDate ?? order.confirmDate,
        nav: order.confirmNav,
      });
    }
  }

  for (const position of dataset.positions) {
    if (position.latestNav && position.navDate) {
      service.writeFundNav?.({
        fundCode: position.code,
        fundName: position.name,
        nav: position.latestNav,
        navDate: position.navDate,
        source: 'legacy/account-info.html',
      });
    }
  }

  return decisionRowsByNo;
}

function persistSupplementalRows(db, dataset) {
  if (!db) {
    return;
  }

  persistPnlEntries(db, dataset);
  persistSources(db, dataset);
}

function persistRawRows(db, dataset) {
  persistFunds(db, dataset);
  persistPnlEntries(db, dataset);
  persistSources(db, dataset);
}

function resetDatabase(db) {
  const existingTables = getExistingTables(db);
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    for (const table of KNOWN_TABLES) {
      if (existingTables.has(table)) {
        db.prepare(`DELETE FROM ${quoteIdentifier(table)}`).run();
      }
    }

    if (existingTables.has('sqlite_sequence')) {
      const sequenceStatement = db.prepare('DELETE FROM sqlite_sequence WHERE name = :name');
      for (const name of KNOWN_TABLES) {
        sequenceStatement.run({ name });
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

function syncLegacyPositions(db, dataset) {
  if (!db) {
    return;
  }

  const tables = getExistingTables(db);
  if (!tables.has('accounts') || !tables.has('positions')) {
    return;
  }

  const account = db.prepare("SELECT id FROM accounts WHERE code = 'default'").get();
  if (!account) {
    return;
  }

  const statement = db.prepare(
    `INSERT INTO positions (
      account_id,
      fund_code,
      shares_int,
      cost_cents,
      avg_cost_nav_int,
      last_nav_int,
      last_nav_date,
      market_value_cents
    ) VALUES (
      :accountId,
      :fundCode,
      :sharesInt,
      :costCents,
      :avgCostNavInt,
      :lastNavInt,
      :lastNavDate,
      :marketValueCents
    )
    ON CONFLICT(account_id, fund_code) DO UPDATE SET
      shares_int = excluded.shares_int,
      cost_cents = excluded.cost_cents,
      avg_cost_nav_int = excluded.avg_cost_nav_int,
      last_nav_int = excluded.last_nav_int,
      last_nav_date = excluded.last_nav_date,
      market_value_cents = excluded.market_value_cents,
      updated_at = datetime('now')`,
  );

  for (const position of dataset.positions) {
    statement.run({
      accountId: account.id,
      fundCode: position.code,
      sharesInt: sharesToInt(position.shares),
      costCents: moneyToCents(position.cost),
      avgCostNavInt: navToInt(position.avgCostNav),
      lastNavInt: navToInt(position.latestNav),
      lastNavDate: position.navDate,
      marketValueCents: moneyToCents(position.marketValue),
    });
  }
}

function persistFunds(db, dataset) {
  if (!getExistingTables(db).has('funds')) {
    return;
  }

  const statement = db.prepare(
    `INSERT INTO funds (code, name, category)
     VALUES (:code, :name, :category)
     ON CONFLICT(code) DO UPDATE SET
       name = excluded.name,
       category = COALESCE(excluded.category, funds.category)`,
  );

  for (const fund of dataset.funds) {
    statement.run({
      code: fund.code,
      name: fund.name,
      category: fund.category ?? null,
    });
  }
}

function persistPnlEntries(db, dataset) {
  const tables = getExistingTables(db);
  if (!tables.has('pnl_entries') || !tables.has('accounts')) {
    return;
  }

  const account = db.prepare("SELECT id FROM accounts WHERE code = 'default'").get();
  if (!account) {
    return;
  }

  const statement = db.prepare(
    `INSERT INTO pnl_entries (
      account_id,
      fund_code,
      entry_date,
      type,
      amount_cents,
      basis_cents,
      related_order_no,
      note
    ) VALUES (
      :accountId,
      NULL,
      :entryDate,
      'legacy_snapshot',
      :amountCents,
      :basisCents,
      NULL,
      :note
    )`,
  );

  for (const entry of dataset.pnlEntries) {
    statement.run({
      accountId: account.id,
      entryDate: entry.date,
      amountCents: moneyToCents(entry.dailyPnl ?? '0.00'),
      basisCents: moneyToCents(entry.endingAssets ?? '0.00'),
      note: entry.review,
    });
  }
}

function persistSources(db, dataset) {
  const tables = getExistingTables(db);
  if (!tables.has('data_sources') || !tables.has('source_refs')) {
    return;
  }

  const sourceStatement = db.prepare(
    `INSERT INTO data_sources (name, source_type, url, fetched_at, raw_text)
     VALUES (:name, :sourceType, :url, :fetchedAt, :rawText)`,
  );
  const refStatement = db.prepare(
    `INSERT INTO source_refs (source_id, entity_type, entity_id, ref_path, quote)
     VALUES (:sourceId, :entityType, :entityId, :refPath, :quote)`,
  );

  for (const operation of dataset.operations) {
    for (const source of operation.sources) {
      const result = sourceStatement.run({
        name: source.text || source.href || 'legacy source',
        sourceType: source.href ? 'url' : 'text',
        url: source.href ?? null,
        fetchedAt: operation.submittedAt,
        rawText: source.text,
      });
      refStatement.run({
        sourceId: Number(result.lastInsertRowid),
        entityType: 'decision',
        entityId: operation.orderNo,
        refPath: 'operation-log.html',
        quote: operation.reason,
      });
    }
  }

  for (const action of dataset.actionDetails) {
    const result = sourceStatement.run({
      name: action.title || action.decisionNo,
      sourceType: 'legacy_action',
      url: action.relativePath,
      fetchedAt: action.submittedAt,
      rawText: action.text,
    });
    refStatement.run({
      sourceId: Number(result.lastInsertRowid),
      entityType: 'decision',
      entityId: action.decisionNo,
      refPath: action.relativePath,
      quote: action.reason,
    });
  }
}

async function createService(db) {
  if (!db) {
    return null;
  }

  const { createLedgerService } = await import('../services/ledgerService.js');
  return createLedgerService(db);
}

async function parseOperationLog(filePath) {
  const $ = await loadHtml(filePath);
  const table = $('table.ledger').first();
  const rows = parseTable(table, $);

  return rows.map((row) => {
    const amountAndShares = row['金额/份额'] ?? '';
    const fundCodes = splitCodes(row['基金代码']);
    return {
      orderNo: cleanText(row['订单编号']),
      submittedDate: cleanText(row['提交日期']),
      submittedTime: cleanText(row['提交时间']),
      submittedAt: toChinaIso(cleanText(row['提交日期']), cleanText(row['提交时间'])),
      actionText: cleanText(row['操作']),
      actionType: normalizeAction(cleanText(row['操作'])),
      amount: moneyString(amountAndShares),
      shares: sharesString(amountAndShares),
      fundCodeRaw: cleanText(row['基金代码']),
      fundCodes,
      fundName: cleanText(row['基金名称']),
      applicationTradeDate: cleanText(row['申请交易日']),
      confirmDate: cleanText(row['确认日期']),
      settleDate: cleanText(row['到账日期']),
      confirmNav: navString(row['确认净值']),
      fee: moneyString(row['手续费']) ?? '0.00',
      statusText: cleanText(row['状态']),
      reason: cleanText(row['理由']),
      sources: parseSourceCell(row.__cells?.['数据来源']),
    };
  });
}

async function parseAccountInfo(filePath) {
  const $ = await loadHtml(filePath);
  const metrics = parseMetrics($);
  const cashRows = parseKeyValueTable($, '资金账户');
  const positions = parsePositionRows($);
  const latestUpdatedAt = parseLatestUpdatedAt($('.eyebrow').first().text());

  return {
    latestUpdatedAt,
    initialCash: moneyString(metrics['初始资金']) ?? '10000.00',
    totalAssets: moneyString(metrics['总资产'] ?? cashRows['总资产']),
    cash: moneyString(metrics['可用资金'] ?? cashRows['可用资金']),
    pendingBuy: moneyString(cashRows['待确认买入']) ?? '0.00',
    pendingSell: moneyString(cashRows['待到账卖出']) ?? '0.00',
    holdingValue: moneyString(cashRows['持仓市值']),
    invested: moneyString(cashRows['已确认投入']),
    cumulativePnl: signedMoneyString(cashRows['累计收益']),
    totalReturnPercent: percentString(metrics['总收益率']),
    maxDrawdownPercent: percentString(cashRows['最大回撤']),
    positions,
  };
}

async function parseProfitLog(filePath) {
  const $ = await loadHtml(filePath);
  const rows = parseTableByHeading($, '每日盈亏记录');

  return rows.map((row) => ({
    label: cleanText(row['日期']),
    date: cleanText(row['日期']).slice(0, 10),
    beginningAssets: moneyString(row['期初总资产']),
    endingAssets: moneyString(row['期末总资产']),
    dailyPnl: signedMoneyString(row['当日账面盈亏']),
    dailyReturnPercent: percentString(row['当日收益率']),
    cumulativePnl: signedMoneyString(row['累计收益']),
    cumulativeReturnPercent: percentString(row['累计收益率']),
    maxDrawdownPercent: percentString(row['最大回撤']),
    cash: moneyString(row['可用资金']),
    pendingBuy: moneyString(row['待确认买入']),
    holdingValue: moneyString(row['持仓市值']),
    review: cleanText(row['复盘']),
  }));
}

async function parseActionDetails(actionsDir, legacyDir) {
  const names = (await readdir(actionsDir))
    .filter((name) => name.endsWith('.html'))
    .sort();
  const details = [];

  for (const name of names) {
    const fullPath = path.join(actionsDir, name);
    const $ = await loadHtml(fullPath);
    const eyebrow = cleanText($('.eyebrow').first().text());
    const decisionNo = eyebrow.match(/20\d{6}-\d{3}/)?.[0];
    if (!decisionNo) {
      continue;
    }

    const fields = parseAllKeyValueRows($);
    const relativePath = normalizeRelativePath(path.relative(legacyDir, fullPath));
    const reason = parseSectionParagraphs($, '决策理由');

    details.push({
      decisionNo,
      submittedAt: parseActionSubmittedAt(eyebrow),
      title: cleanText($('h1').first().text()),
      relativePath,
      fields,
      reason,
      text: cleanText($('body').text()),
    });
  }

  return details.sort((left, right) => left.decisionNo.localeCompare(right.decisionNo));
}

function parseMetrics($) {
  const metrics = {};
  $('.metric').each((_index, element) => {
    const label = cleanText($(element).find('.label').first().text());
    const value = cleanText($(element).find('.value').first().text());
    if (label) {
      metrics[label] = value;
    }
  });
  return metrics;
}

function parsePositionRows($) {
  return parseTableByHeading($, '当前持仓').map((row) => ({
    code: cleanText(row['基金代码']),
    name: cleanText(row['基金名称']),
    category: cleanText(row['类型']),
    shares: sharesString(row['持有份额']),
    cost: moneyString(row['持仓成本']),
    avgCostNav: navString(row['平均成本净值']),
    latestNav: navString(row['最新净值']),
    navDate: cleanText(row['净值日期']),
    marketValue: moneyString(row['市值']),
    pnl: signedMoneyString(row['收益']),
    returnPercent: percentString(row['收益率']),
    status: cleanText(row['状态']),
  }));
}

function parseKeyValueTable($, heading) {
  const section = findSectionByHeading($, heading);
  const values = {};

  section.find('table').first().find('tbody tr').each((_index, row) => {
    const key = cleanText($(row).find('th').first().text());
    const value = cleanText($(row).find('td').first().text());
    if (key) {
      values[key] = value;
    }
  });

  return values;
}

function parseAllKeyValueRows($) {
  const values = {};
  $('table.ledger tbody tr').each((_index, row) => {
    const key = cleanText($(row).find('th').first().text());
    const value = cleanText($(row).find('td').first().text());
    if (key) {
      values[key] = value;
    }
  });
  return values;
}

function parseSectionParagraphs($, heading) {
  const section = findSectionByHeading($, heading);
  return section
    .find('p')
    .toArray()
    .map((item) => cleanText($(item).text()))
    .filter(Boolean)
    .join('\n\n');
}

function parseTableByHeading($, heading) {
  const section = findSectionByHeading($, heading);
  return parseTable(section.find('table').first(), $);
}

function findSectionByHeading($, heading) {
  const h2 = $('h2')
    .toArray()
    .find((element) => cleanText($(element).text()) === heading);
  return h2 ? $(h2).closest('section, article, div') : cheerio.load('<section></section>')('section');
}

function parseTable(table, $) {
  const headers = table.find('thead th').toArray().map((item) => cleanText($(item).text()));
  return table.find('tbody tr').toArray().map((row) => {
    const cells = {};
    const record = { __cells: cells };
    $(row).find('td').each((index, cell) => {
      const key = headers[index] ?? String(index);
      cells[key] = $(cell);
      record[key] = cleanText($(cell).text());
    });
    return record;
  });
}

function parseSourceCell(cell) {
  if (!cell) {
    return [];
  }

  const sources = [];
  cell.find('a').each((_index, link) => {
    const href = cell.find(link).attr('href');
    const text = cleanText(cell.find(link).text());
    if (href || text) {
      sources.push({ text, href });
    }
  });

  const textOnly = cleanText(cell.clone().find('a').remove().end().text())
    .split(/[；;]/)
    .map((text) => cleanText(text))
    .filter(Boolean);

  for (const text of textOnly) {
    sources.push({ text, href: null });
  }

  return sources;
}

async function loadHtml(filePath) {
  const html = await readFile(filePath, 'utf8');
  return cheerio.load(html);
}

function collectFunds({ operations, account }) {
  const byCode = new Map();

  for (const position of account.positions) {
    if (position.code) {
      byCode.set(position.code, {
        code: position.code,
        name: position.name,
        category: position.category,
      });
    }
  }

  for (const operation of operations) {
    const code = singleCode(operation.fundCodes);
    if (code && !byCode.has(code)) {
      byCode.set(code, {
        code,
        name: operation.fundName || code,
        category: null,
      });
    }
  }

  return [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code));
}

function buildImportResult(dataset, options) {
  return {
    legacyDir: options.legacyDir,
    reset: options.reset,
    persisted: options.persisted,
    importedAt: new Date().toISOString(),
    counts: {
      funds: dataset.funds.length,
      operations: dataset.operations.length,
      decisions: dataset.decisions.length,
      orders: dataset.orders.length,
      positions: dataset.positions.length,
      pnlEntries: dataset.pnlEntries.length,
      actionFiles: dataset.actionDetails.length,
    },
    account: dataset.account,
    balance: {
      cash: dataset.account.cash,
      availableCash: dataset.account.cash,
      totalAssets: dataset.account.totalAssets,
      holdingValue: dataset.account.holdingValue,
      pendingBuy: dataset.account.pendingBuy,
      pendingSell: dataset.account.pendingSell,
      positions: dataset.positions,
    },
    funds: dataset.funds,
    positions: dataset.positions,
    decisions: dataset.decisions,
    orders: dataset.orders,
    pnlEntries: dataset.pnlEntries,
  };
}

function getExistingTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all();
  return new Set(rows.map((row) => row.name));
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function splitCodes(value) {
  return cleanText(value)
    .split('/')
    .map((code) => cleanText(code))
    .filter((code) => /^\d{6}$/.test(code));
}

function singleCode(codes) {
  return codes.length === 1 ? codes[0] : null;
}

function normalizeAction(value) {
  if (value.includes('买入')) return 'buy';
  if (value.includes('卖出')) return 'sell';
  if (value.includes('转换')) return 'switch';
  if (value.includes('不操作')) return 'hold';
  return value || 'hold';
}

function inferDailySequence(decisionNo) {
  return Number(decisionNo.split('-').at(-1));
}

function nullableDate(value) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function toChinaIso(date, time = '00:00:00') {
  return `${date}T${time || '00:00:00'}+08:00`;
}

function parseActionSubmittedAt(eyebrow) {
  const match = eyebrow.match(/(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  return match ? toChinaIso(match[1], match[2]) : null;
}

function parseLatestUpdatedAt(text) {
  const match = cleanText(text).match(/(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
  return match ? toChinaIso(match[1], match[2]) : null;
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join('/');
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function moneyString(value) {
  const number = extractNumber(value);
  return number === null ? null : number.toFixed(2);
}

function signedMoneyString(value) {
  const number = extractNumber(value);
  return number === null ? null : number.toFixed(2);
}

function sharesString(value) {
  const numbers = extractNumbers(value);
  if (numbers.length === 0) {
    return null;
  }
  const shareNumber = numbers.length > 1 ? numbers[1] : numbers[0];
  return shareNumber.toFixed(4);
}

function navString(value) {
  const text = cleanText(value);
  if (!/\d/.test(text) || text.includes('无新增交易')) {
    return null;
  }
  const number = extractNumber(text);
  return number === null ? null : number.toFixed(4);
}

function percentString(value) {
  const number = extractNumber(value);
  return number === null ? null : number.toFixed(4);
}

function moneyToCents(value) {
  return scaledInteger(value, 2);
}

function navToInt(value) {
  return scaledInteger(value, 4);
}

function sharesToInt(value) {
  return scaledInteger(value, 4);
}

function extractNumber(value) {
  return extractNumbers(value)[0] ?? null;
}

function extractNumbers(value) {
  const text = cleanText(value).replaceAll(',', '');
  return [...text.matchAll(/[-+]?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
}

function scaledInteger(value, digits) {
  const text = cleanText(value).replaceAll(',', '');
  const match = text.match(/([-+]?)(\d+)(?:\.(\d+))?/);
  if (!match) {
    return 0;
  }

  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = (match[3] ?? '').padEnd(digits + 1, '0');
  const base = whole * 10 ** digits + Number(fraction.slice(0, digits));
  const rounded = Number(fraction[digits]) >= 5 ? base + 1 : base;
  return sign * rounded;
}
