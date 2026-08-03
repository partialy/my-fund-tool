import { centsToMoney, intToNav } from '../lib/units.js';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-pro';

function plain(row) {
  return row ? { ...row } : null;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return Number((numerator / denominator).toFixed(6));
}

function money(cents) {
  return centsToMoney(Number(cents ?? 0));
}

function nav(value) {
  return value === null || value === undefined ? null : intToNav(value);
}

function safeJsonParse(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function standardDeviation(values) {
  if (!values.length) {
    return null;
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
  return Number(Math.sqrt(variance).toFixed(2));
}

function maxDrawdownRate(snapshots) {
  if (snapshots.length < 2) {
    return null;
  }

  let peak = snapshots[0].total_assets_cents;
  let worst = 0;
  for (const snapshot of snapshots.slice(1)) {
    const total = snapshot.total_assets_cents;
    if (total > peak) {
      peak = total;
    }
    if (peak > 0) {
      worst = Math.min(worst, (total - peak) / peak);
    }
  }

  return Number(Math.abs(worst).toFixed(6));
}

function latestByDate(rows, dateKey) {
  return rows.reduce((latest, row) => {
    if (!latest) {
      return row;
    }
    const currentDate = String(row[dateKey] ?? '');
    const latestDate = String(latest[dateKey] ?? '');
    return currentDate >= latestDate ? row : latest;
  }, null);
}

function sortFunds(left, right) {
  return (
    right.holdingAccountCount - left.holdingAccountCount ||
    right.totalMarketValueCents - left.totalMarketValueCents ||
    String(left.fundCode).localeCompare(String(right.fundCode), 'zh-CN')
  );
}

export function createAdminAnalysisService(db, options = {}) {
  const env = options.env ?? process.env;
  const deepSeekClient = options.deepSeekClient;
  const model = options.model ?? DEEPSEEK_MODEL;

  function get(sql, params = {}) {
    return plain(db.prepare(sql).get(params));
  }

  function all(sql, params = {}) {
    return db.prepare(sql).all(params).map(plain);
  }

  function run(sql, params = {}) {
    return db.prepare(sql).run(params);
  }

  function listAccounts() {
    const accounts = all('SELECT * FROM accounts ORDER BY id ASC');
    const positionsByAccount = groupBy(
      all(
        `SELECT
           p.*,
           f.name AS fund_name,
           f.category AS fund_category,
           f.company AS fund_company,
           f.manager AS fund_manager
         FROM positions p
         JOIN funds f ON f.code = p.fund_code
         ORDER BY p.market_value_cents DESC, p.fund_code ASC`,
      ),
      'account_id',
    );
    const snapshotsByAccount = groupBy(
      all(
        `SELECT *
         FROM account_snapshots
         ORDER BY account_id ASC, snapshot_date ASC, id ASC`,
      ),
      'account_id',
    );
    const operationsByAccount = countByAccount(
      all(
        `SELECT account_id, COUNT(*) AS count
         FROM decisions
         WHERE counts_daily = 1
         GROUP BY account_id`,
      ),
    );

    return accounts.map((account) => formatAccountAnalysis({
      account,
      positions: positionsByAccount.get(account.id) ?? [],
      snapshots: snapshotsByAccount.get(account.id) ?? [],
      operationCount: operationsByAccount.get(account.id) ?? 0,
    }));
  }

  function formatAccountAnalysis({ account, positions, snapshots, operationCount }) {
    const latestSnapshot = latestByDate(snapshots, 'snapshot_date');
    const positionsMarketValueCents = positions.reduce((sum, position) => sum + position.market_value_cents, 0);
    const cashTotalCents = account.cash_available_cents + account.cash_frozen_cents;
    const totalAssetsCents = latestSnapshot?.total_assets_cents ?? cashTotalCents + positionsMarketValueCents;
    const accumulatedPnlCents = totalAssetsCents - account.initial_cash_cents;
    const dailyPnlValues = snapshots
      .map((snapshot) => snapshot.daily_pnl_cents)
      .filter((value) => Number.isFinite(value));
    const topPositionValueCents = positions.reduce(
      (max, position) => Math.max(max, position.market_value_cents),
      0,
    );
    const pnlVolatilityCents = dailyPnlValues.length === 1
      ? Math.abs(dailyPnlValues[0])
      : standardDeviation(dailyPnlValues);

    return {
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      currency: account.currency,
      initialCashCents: account.initial_cash_cents,
      initialCash: money(account.initial_cash_cents),
      cashAvailableCents: account.cash_available_cents,
      cashAvailable: money(account.cash_available_cents),
      cashFrozenCents: account.cash_frozen_cents,
      cashFrozen: money(account.cash_frozen_cents),
      cashTotalCents,
      cashTotal: money(cashTotalCents),
      positionsMarketValueCents,
      positionsMarketValue: money(positionsMarketValueCents),
      totalAssetsCents,
      totalAssets: money(totalAssetsCents),
      accumulatedPnlCents,
      accumulatedPnl: money(accumulatedPnlCents),
      returnRate: ratio(accumulatedPnlCents, account.initial_cash_cents),
      cashRatio: ratio(cashTotalCents, totalAssetsCents),
      positionCount: positions.length,
      concentrationRate: positionsMarketValueCents > 0
        ? ratio(topPositionValueCents, positionsMarketValueCents)
        : null,
      maxDrawdownRate: maxDrawdownRate(snapshots),
      pnlVolatilityCents,
      pnlVolatility: pnlVolatilityCents === null ? null : money(pnlVolatilityCents),
      operationCount,
      latestSnapshotDate: latestSnapshot?.snapshot_date ?? null,
      positions: positions.map(formatPosition),
    };
  }

  function formatPosition(position) {
    const unrealizedPnlCents = position.market_value_cents - position.cost_cents;
    return {
      fundCode: position.fund_code,
      fundName: position.fund_name,
      category: position.fund_category,
      company: position.fund_company,
      manager: position.fund_manager,
      sharesInt: position.shares_int,
      costCents: position.cost_cents,
      cost: money(position.cost_cents),
      marketValueCents: position.market_value_cents,
      marketValue: money(position.market_value_cents),
      unrealizedPnlCents,
      unrealizedPnl: money(unrealizedPnlCents),
      returnRate: ratio(unrealizedPnlCents, position.cost_cents),
      lastNav: nav(position.last_nav_int),
      lastNavDate: position.last_nav_date,
    };
  }

  function listFunds(accounts) {
    const funds = new Map();
    for (const account of accounts) {
      for (const position of account.positions) {
        const existing = funds.get(position.fundCode) ?? {
          fundCode: position.fundCode,
          fundName: position.fundName,
          category: position.category,
          company: position.company,
          manager: position.manager,
          accountCodes: new Set(),
          totalMarketValueCents: 0,
          totalCostCents: 0,
          returns: [],
          latestNavDate: null,
          latestNav: null,
        };
        existing.accountCodes.add(account.accountCode);
        existing.totalMarketValueCents += position.marketValueCents;
        existing.totalCostCents += position.costCents;
        if (position.returnRate !== null) {
          existing.returns.push(position.returnRate);
        }
        if (
          position.lastNavDate &&
          (!existing.latestNavDate || position.lastNavDate > existing.latestNavDate)
        ) {
          existing.latestNavDate = position.lastNavDate;
          existing.latestNav = position.lastNav;
        }
        funds.set(position.fundCode, existing);
      }
    }

    return [...funds.values()].map((fund) => {
      const unrealizedPnlCents = fund.totalMarketValueCents - fund.totalCostCents;
      return {
        fundCode: fund.fundCode,
        fundName: fund.fundName,
        category: fund.category,
        company: fund.company,
        manager: fund.manager,
        holdingAccountCount: fund.accountCodes.size,
        accountCodes: [...fund.accountCodes].sort(),
        totalMarketValueCents: fund.totalMarketValueCents,
        totalMarketValue: money(fund.totalMarketValueCents),
        totalCostCents: fund.totalCostCents,
        totalCost: money(fund.totalCostCents),
        unrealizedPnlCents,
        unrealizedPnl: money(unrealizedPnlCents),
        averageReturnRate: fund.returns.length
          ? Number((fund.returns.reduce((sum, value) => sum + value, 0) / fund.returns.length).toFixed(6))
          : null,
        latestNav: fund.latestNav,
        latestNavDate: fund.latestNavDate,
      };
    }).sort(sortFunds);
  }

  function getLatestAiAnalysis() {
    const row = get(
      `SELECT *
       FROM ai_analysis_runs
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    );
    return formatAnalysisRun(row);
  }

  function getAdminViewModel() {
    const accounts = listAccounts();
    const funds = listFunds(accounts);
    return {
      generatedAt: new Date().toISOString(),
      aiEnabled: Boolean(deepSeekClient || env.DEEPSEEK_API_KEY),
      aiModel: model,
      accounts,
      funds,
      latestAnalysis: getLatestAiAnalysis(),
      summary: {
        accountCount: accounts.length,
        fundCount: funds.length,
        totalAssetsCents: accounts.reduce((sum, account) => sum + account.totalAssetsCents, 0),
        totalAssets: money(accounts.reduce((sum, account) => sum + account.totalAssetsCents, 0)),
        totalPnlCents: accounts.reduce((sum, account) => sum + account.accumulatedPnlCents, 0),
        totalPnl: money(accounts.reduce((sum, account) => sum + account.accumulatedPnlCents, 0)),
      },
    };
  }

  async function runAiAnalysis() {
    const client = await resolveDeepSeekClient();
    const snapshot = getAdminViewModel();
    const prompt = buildSystemPrompt();
    const userContent = buildUserPrompt(snapshot);
    const started = insertAnalysisRun({
      status: 'running',
      snapshot,
      prompt,
      model,
    });

    try {
      const completion = await client.chat.completions.create({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userContent },
        ],
        model,
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
        stream: false,
      });
      const content = completion?.choices?.[0]?.message?.content ?? '';
      if (!content) {
        throw new Error('DeepSeek returned an empty analysis response.');
      }

      updateAnalysisRun({
        id: started.id,
        status: 'success',
        content,
        errorMessage: null,
      });
      return getAnalysisRunById(started.id);
    } catch (error) {
      updateAnalysisRun({
        id: started.id,
        status: 'failed',
        content: null,
        errorMessage: error?.message ?? String(error),
      });
      throw error;
    }
  }

  async function resolveDeepSeekClient() {
    if (deepSeekClient) {
      return deepSeekClient;
    }

    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw {
        status: 500,
        code: 'DEEPSEEK_API_KEY_MISSING',
        message: 'DEEPSEEK_API_KEY is required to generate AI analysis.',
      };
    }

    const { default: OpenAI } = await import('openai');
    return new OpenAI({
      baseURL: DEEPSEEK_BASE_URL,
      apiKey,
    });
  }

  function insertAnalysisRun({ status, snapshot, prompt, model }) {
    run(
      `INSERT INTO ai_analysis_runs (
        status,
        model,
        input_snapshot_json,
        prompt
      ) VALUES (
        :status,
        :model,
        :snapshot,
        :prompt
      )`,
      {
        status,
        model,
        snapshot: JSON.stringify(trimSnapshotForStorage(snapshot)),
        prompt,
      },
    );
    return get('SELECT * FROM ai_analysis_runs WHERE id = last_insert_rowid()');
  }

  function updateAnalysisRun({ id, status, content, errorMessage }) {
    run(
      `UPDATE ai_analysis_runs
       SET status = :status,
           content = :content,
           error_message = :errorMessage,
           completed_at = datetime('now')
       WHERE id = :id`,
      {
        id,
        status,
        content,
        errorMessage,
      },
    );
  }

  function getAnalysisRunById(id) {
    return formatAnalysisRun(get('SELECT * FROM ai_analysis_runs WHERE id = :id', { id }));
  }

  return {
    getAdminViewModel,
    getLatestAiAnalysis,
    runAiAnalysis,
  };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[key];
    const group = groups.get(value) ?? [];
    group.push(row);
    groups.set(value, group);
  }
  return groups;
}

function countByAccount(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.account_id, Number(row.count ?? 0));
  }
  return counts;
}

function formatAnalysisRun(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    model: row.model,
    inputSnapshot: safeJsonParse(row.input_snapshot_json, null),
    prompt: row.prompt,
    content: row.content,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function buildSystemPrompt() {
  return [
    '你是基金模拟玩法的管理后台分析助手。',
    '只能使用用户消息中的本地账本数据，不要编造外部行情、基金业绩或不存在的账户。',
    '如果数据不足，请明确写出“数据不足”和需要补充的数据。',
    '请用中文输出，结构固定为：总览结论、收益表现、风险控制排名、账户风格差异、基金关注建议、需要补充的数据。',
    '这只是游戏复盘和观察，不构成真实投资建议。',
  ].join('\n');
}

function buildUserPrompt(snapshot) {
  return [
    '请分析以下所有账户的持仓、收益、风险控制、操作节奏，并指出已有基金里哪些更值得多关注。',
    '本地账本数据如下：',
    JSON.stringify(trimSnapshotForPrompt(snapshot), null, 2),
  ].join('\n');
}

function trimSnapshotForPrompt(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    accounts: snapshot.accounts.map((account) => ({
      accountCode: account.accountCode,
      accountName: account.accountName,
      totalAssets: account.totalAssets,
      accumulatedPnl: account.accumulatedPnl,
      returnRate: account.returnRate,
      cashRatio: account.cashRatio,
      positionsMarketValue: account.positionsMarketValue,
      positionCount: account.positionCount,
      concentrationRate: account.concentrationRate,
      maxDrawdownRate: account.maxDrawdownRate,
      pnlVolatility: account.pnlVolatility,
      operationCount: account.operationCount,
      latestSnapshotDate: account.latestSnapshotDate,
      positions: account.positions.map((position) => ({
        fundCode: position.fundCode,
        fundName: position.fundName,
        marketValue: position.marketValue,
        cost: position.cost,
        unrealizedPnl: position.unrealizedPnl,
        returnRate: position.returnRate,
        lastNav: position.lastNav,
        lastNavDate: position.lastNavDate,
      })),
    })),
    funds: snapshot.funds,
  };
}

function trimSnapshotForStorage(snapshot) {
  return {
    generatedAt: snapshot.generatedAt,
    summary: snapshot.summary,
    accounts: snapshot.accounts,
    funds: snapshot.funds,
  };
}
