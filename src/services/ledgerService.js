import {
  amountCentsFromSharesAndNav,
  centsToMoney,
  centsToNavInt,
  intToNav,
  intToShares,
  moneyToCents,
  navToInt,
  sharesIntFromAmountAndNav,
  sharesToInt
} from '../lib/units.js';
import {
  nextTradingDateFromCalendar,
  resolveApplicationTradeDate,
  toLocalDate,
  toLocalDateTime
} from '../lib/dates.js';
import {
  buildPaginationMeta,
  normalizePagination,
  shouldPaginate
} from '../lib/pagination.js';

const DEFAULT_ACCOUNT_CODE = 'default';
const DEFAULT_ACCOUNT_NAME = '模拟账户';
const DEFAULT_INITIAL_CASH_CENTS = 1000000;
const COUNTING_ACTIONS = new Set(['buy', 'sell', 'switch', 'hold']);

function plain(row) {
  return row ? { ...row } : null;
}

function normalizeAccountId(value) {
  if (value && typeof value === 'object') {
    return value.accountId ?? value.account_id ?? value.id;
  }
  return value;
}

function readCents(input, keys, defaultValue = null) {
  for (const key of keys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      return key.toLowerCase().includes('cents') ? Number(input[key]) : moneyToCents(input[key]);
    }
  }
  return defaultValue;
}

function readInt(input, intKeys, decimalKeys, converter, defaultValue = null) {
  for (const key of intKeys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      return Number(input[key]);
    }
  }

  for (const key of decimalKeys) {
    if (input[key] !== undefined && input[key] !== null && input[key] !== '') {
      return converter(input[key]);
    }
  }

  return defaultValue;
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
}

function maybeJson(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function pickInput(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return undefined;
}

function paginationInput(input, pageKeys, pageSizeKeys) {
  return {
    accountId: input.accountId ?? input.account_id,
    paginated: true,
    page: pickInput(input, ...pageKeys, 'page'),
    pageSize: pickInput(input, ...pageSizeKeys, 'pageSize', 'page_size')
  };
}

function pageItems(result) {
  return Array.isArray(result) ? result : result?.items ?? [];
}

function pageMeta(result) {
  return Array.isArray(result) ? null : result?.pagination ?? null;
}

function ratioPpm(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }

  return Math.round((numerator * 1000000) / denominator);
}

export function createLedgerService(db) {
  function get(sql, params = {}) {
    return plain(db.prepare(sql).get(params));
  }

  function all(sql, params = {}) {
    return db.prepare(sql).all(params).map(plain);
  }

  function run(sql, params = {}) {
    return db.prepare(sql).run(params);
  }

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const result = callback();
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  function listRows({ input, selectSql, countSql, params = {}, mapRow = (row) => row }) {
    if (!shouldPaginate(input)) {
      return all(selectSql, params).map(mapRow);
    }

    const { page, pageSize } = normalizePagination(input);
    const totalRow = get(countSql, params);
    const pagination = buildPaginationMeta({
      page,
      pageSize,
      totalItems: totalRow?.totalItems ?? totalRow?.count ?? 0
    });
    const items = all(
      `${selectSql}
       LIMIT :pageSize OFFSET :offset`,
      {
        ...params,
        pageSize: pagination.pageSize,
        offset: (pagination.page - 1) * pagination.pageSize
      }
    ).map(mapRow);

    return { items, pagination };
  }

  function getDefaultAccount() {
    return get('SELECT * FROM accounts WHERE code = :code', { code: DEFAULT_ACCOUNT_CODE });
  }

  function requireAccount(accountId) {
    const normalized = normalizeAccountId(accountId);
    const account = normalized
      ? get('SELECT * FROM accounts WHERE id = :id', { id: normalized })
      : getDefaultAccount();

    if (!account) {
      throw new Error('Account is not initialized.');
    }

    return account;
  }

  function getCalendarRows(fromDate) {
    return all(
      `SELECT trade_date, is_open
       FROM trading_calendar
       WHERE trade_date >= :fromDate
       ORDER BY trade_date ASC`,
      { fromDate: toLocalDate(fromDate) }
    );
  }

  function nextTradeDate(date, options = {}) {
    return nextTradingDateFromCalendar(date, getCalendarRows(date), options);
  }

  function applicationTradeDate(submittedAt) {
    return resolveApplicationTradeDate(submittedAt, getCalendarRows(toLocalDate(submittedAt)));
  }

  function latestNav(fundCode, date = toLocalDate()) {
    return get(
      `SELECT *
       FROM fund_navs
       WHERE fund_code = :fundCode AND nav_date <= :date
       ORDER BY nav_date DESC
       LIMIT 1`,
      { fundCode, date }
    );
  }

  function ensureFund(input) {
    const fundCode = input.fundCode ?? input.fund_code ?? input.code;
    if (!fundCode) {
      throw new Error('Fund code is required.');
    }

    return upsertFund({
      code: fundCode,
      name: input.name ?? input.fundName ?? input.fund_name ?? fundCode,
      category: input.category,
      company: input.company,
      manager: input.manager
    });
  }

  function insertCashLedger({
    account,
    occurredAt,
    type,
    direction,
    amountCents,
    balanceBeforeCents,
    balanceAfterCents,
    relatedType = null,
    relatedId = null,
    note = null
  }) {
    run(
      `INSERT INTO cash_ledger (
        account_id,
        occurred_at,
        occurred_on,
        type,
        direction,
        amount_cents,
        balance_before_cents,
        balance_after_cents,
        cash_available_after_cents,
        cash_frozen_after_cents,
        related_type,
        related_id,
        note
      ) VALUES (
        :accountId,
        :occurredAt,
        :occurredOn,
        :type,
        :direction,
        :amountCents,
        :balanceBeforeCents,
        :balanceAfterCents,
        :cashAvailableAfterCents,
        :cashFrozenAfterCents,
        :relatedType,
        :relatedId,
        :note
      )`,
      {
        accountId: account.id,
        occurredAt,
        occurredOn: toLocalDate(occurredAt),
        type,
        direction,
        amountCents,
        balanceBeforeCents,
        balanceAfterCents,
        cashAvailableAfterCents: account.cash_available_cents,
        cashFrozenAfterCents: account.cash_frozen_cents,
        relatedType,
        relatedId,
        note
      }
    );

    return get('SELECT * FROM cash_ledger WHERE id = last_insert_rowid()');
  }

  function updateAccountCash({ account, nextAvailableCents, nextFrozenCents = account.cash_frozen_cents }) {
    if (nextAvailableCents < 0 || nextFrozenCents < 0) {
      throw new RangeError('Cash balance cannot be negative.');
    }

    run(
      `UPDATE accounts
       SET cash_available_cents = :available,
           cash_frozen_cents = :frozen,
           updated_at = datetime('now')
       WHERE id = :id`,
      {
        id: account.id,
        available: nextAvailableCents,
        frozen: nextFrozenCents
      }
    );

    return requireAccount(account.id);
  }

  function applyCashChange({
    accountId,
    type,
    amountCents,
    targetBalanceCents = null,
    occurredAt = toLocalDateTime(),
    relatedType = null,
    relatedId = null,
    note = null
  }) {
    const account = requireAccount(accountId);
    const before = account.cash_available_cents;
    let after = before;
    let direction = 'set';
    let ledgerAmount = amountCents;

    if (type === 'deposit' || type === 'sell_settlement' || type === 'refund' || type === 'import') {
      assertPositiveInteger(amountCents, 'amountCents');
      after = before + amountCents;
      direction = 'in';
    } else if (type === 'withdraw' || type === 'buy_order' || type === 'fee') {
      assertPositiveInteger(amountCents, 'amountCents');
      after = before - amountCents;
      direction = 'out';
    } else if (type === 'correction') {
      if (targetBalanceCents === null) {
        if (!Number.isInteger(amountCents)) {
          throw new TypeError('Correction requires amountCents or targetBalanceCents.');
        }
        after = before + amountCents;
      } else {
        after = targetBalanceCents;
        ledgerAmount = targetBalanceCents - before;
      }
      direction = 'set';
    } else {
      throw new Error(`Unsupported cash ledger type: ${type}`);
    }

    const updatedAccount = updateAccountCash({
      account,
      nextAvailableCents: after
    });
    const ledger = insertCashLedger({
      account: updatedAccount,
      occurredAt,
      type,
      direction,
      amountCents: ledgerAmount,
      balanceBeforeCents: before,
      balanceAfterCents: after,
      relatedType,
      relatedId,
      note
    });

    return {
      ledger,
      balance: getAccountBalance(updatedAccount.id)
    };
  }

  function setupDefaultAccount(options = {}) {
    const existing = getDefaultAccount();
    if (existing) {
      return existing;
    }

    return transaction(() => {
      const initialCashCents = readCents(
        options,
        ['initialCashCents', 'initial_cash_cents', 'initialCash', 'cash'],
        DEFAULT_INITIAL_CASH_CENTS
      );
      const code = options.code ?? DEFAULT_ACCOUNT_CODE;
      const name = options.name ?? DEFAULT_ACCOUNT_NAME;
      const limit = Number(options.dailyDecisionLimit ?? options.daily_decision_limit ?? 3);

      run(
        `INSERT INTO accounts (
          code,
          name,
          initial_cash_cents,
          cash_available_cents,
          daily_decision_limit
        ) VALUES (:code, :name, :initialCashCents, :initialCashCents, :limit)`,
        { code, name, initialCashCents, limit }
      );

      const account = get('SELECT * FROM accounts WHERE code = :code', { code });
      insertCashLedger({
        account,
        occurredAt: toLocalDateTime(options.occurredAt ?? options.occurred_at ?? new Date()),
        type: 'deposit',
        direction: 'in',
        amountCents: initialCashCents,
        balanceBeforeCents: 0,
        balanceAfterCents: initialCashCents,
        note: '默认初始资金'
      });

      return account;
    });
  }

  function getAccountBalance(accountId) {
    const account = requireAccount(accountId);
    return {
      accountId: account.id,
      accountCode: account.code,
      cashAvailableCents: account.cash_available_cents,
      cashFrozenCents: account.cash_frozen_cents,
      cashTotalCents: account.cash_available_cents + account.cash_frozen_cents,
      cashAvailable: centsToMoney(account.cash_available_cents),
      cashFrozen: centsToMoney(account.cash_frozen_cents),
      cashTotal: centsToMoney(account.cash_available_cents + account.cash_frozen_cents)
    };
  }

  function adjustCash(input = {}) {
    return transaction(() => {
      const type = input.type;
      if (!['deposit', 'withdraw', 'correction'].includes(type)) {
        throw new Error('Cash adjustment type must be deposit, withdraw, or correction.');
      }

      const amountCents = readCents(input, ['amountCents', 'amount_cents', 'amount'], null);
      const targetBalanceCents = readCents(
        input,
        ['targetBalanceCents', 'target_balance_cents', 'targetBalance', 'balance'],
        null
      );

      return applyCashChange({
        accountId: input.accountId ?? input.account_id,
        type,
        amountCents,
        targetBalanceCents,
        occurredAt: toLocalDateTime(input.occurredAt ?? input.occurred_at ?? new Date()),
        note: input.note ?? null
      });
    });
  }

  function upsertFund(input = {}) {
    const code = input.code ?? input.fundCode ?? input.fund_code;
    if (!code) {
      throw new Error('Fund code is required.');
    }

    const name = input.name ?? input.fundName ?? input.fund_name ?? code;
    run(
      `INSERT INTO funds (code, name, category, company, manager)
       VALUES (:code, :name, :category, :company, :manager)
       ON CONFLICT(code) DO UPDATE SET
         name = COALESCE(excluded.name, funds.name),
         category = COALESCE(excluded.category, funds.category),
         company = COALESCE(excluded.company, funds.company),
         manager = COALESCE(excluded.manager, funds.manager),
         updated_at = datetime('now')`,
      {
        code,
        name,
        category: input.category ?? null,
        company: input.company ?? null,
        manager: input.manager ?? null
      }
    );

    return get('SELECT * FROM funds WHERE code = :code', { code });
  }

  function recalculatePositionMarketValue(accountId, fundCode, date = toLocalDate()) {
    const position = get(
      'SELECT * FROM positions WHERE account_id = :accountId AND fund_code = :fundCode',
      { accountId, fundCode }
    );
    if (!position) {
      return null;
    }

    const nav = latestNav(fundCode, date);
    const marketValueCents = nav ? amountCentsFromSharesAndNav(position.shares_int, nav.nav_int) : 0;
    run(
      `UPDATE positions
       SET last_nav_int = :navInt,
           last_nav_date = :navDate,
           market_value_cents = :marketValueCents,
           updated_at = datetime('now')
       WHERE account_id = :accountId AND fund_code = :fundCode`,
      {
        accountId,
        fundCode,
        navInt: nav?.nav_int ?? null,
        navDate: nav?.nav_date ?? null,
        marketValueCents
      }
    );

    return get('SELECT * FROM positions WHERE account_id = :accountId AND fund_code = :fundCode', {
      accountId,
      fundCode
    });
  }

  function writeFundNav(input = {}) {
    return transaction(() => {
      const fund = ensureFund(input);
      const navDate = toLocalDate(input.navDate ?? input.nav_date ?? input.date ?? new Date());
      const navInt = readInt(input, ['navInt', 'nav_int'], ['nav'], navToInt);
      const accumulatedNavInt = readInt(
        input,
        ['accumulatedNavInt', 'accumulated_nav_int'],
        ['accumulatedNav', 'accumulated_nav'],
        navToInt,
        null
      );
      assertPositiveInteger(navInt, 'navInt');

      run(
        `INSERT INTO fund_navs (
          fund_code,
          nav_date,
          nav_int,
          accumulated_nav_int,
          source
        ) VALUES (
          :fundCode,
          :navDate,
          :navInt,
          :accumulatedNavInt,
          :source
        )
        ON CONFLICT(fund_code, nav_date) DO UPDATE SET
          nav_int = excluded.nav_int,
          accumulated_nav_int = excluded.accumulated_nav_int,
          source = excluded.source,
          updated_at = datetime('now')`,
        {
          fundCode: fund.code,
          navDate,
          navInt,
          accumulatedNavInt,
          source: input.source ?? null
        }
      );

      for (const position of all('SELECT account_id FROM positions WHERE fund_code = :fundCode', {
        fundCode: fund.code
      })) {
        recalculatePositionMarketValue(position.account_id, fund.code, navDate);
      }

      return get('SELECT * FROM fund_navs WHERE fund_code = :fundCode AND nav_date = :navDate', {
        fundCode: fund.code,
        navDate
      });
    });
  }

  function writeMarketQuotes(input = {}) {
    const quotes = Array.isArray(input) ? input : input.quotes ?? [input];

    return transaction(() => {
      const rows = [];
      for (const quote of quotes) {
        const explicitFundCode = quote.fundCode ?? quote.fund_code;
        const marketType = quote.marketType ?? quote.market_type ?? (explicitFundCode ? 'fund' : 'index');
        const symbol = quote.symbol ?? quote.indexCode ?? quote.index_code ?? quote.code ?? explicitFundCode;
        if (!symbol) {
          throw new Error('Market quote symbol is required.');
        }

        const fund = explicitFundCode
          ? ensureFund({
              code: explicitFundCode,
              name: quote.fundName ?? quote.fund_name ?? quote.name ?? explicitFundCode
            })
          : null;
        const quoteDate = toLocalDate(quote.quoteDate ?? quote.quote_date ?? quote.date ?? new Date());
        const priceInt = readInt(quote, ['priceInt', 'price_int'], ['price'], navToInt, null);
        const navInt = readInt(quote, ['navInt', 'nav_int'], ['nav'], navToInt, null);
        const quoteTime = quote.quoteTime ?? quote.quote_time ?? '';
        const quoteType = quote.quoteType ?? quote.quote_type ?? 'estimate';

        run(
          `INSERT INTO market_quotes (
            symbol,
            name,
            market_type,
            fund_code,
            quote_date,
            quote_time,
            quote_type,
            price_int,
            nav_int,
            change_ppm,
            source,
            raw_json
          ) VALUES (
            :symbol,
            :name,
            :marketType,
            :fundCode,
            :quoteDate,
            :quoteTime,
            :quoteType,
            :priceInt,
            :navInt,
            :changePpm,
            :source,
            :rawJson
          )
          ON CONFLICT(symbol, quote_date, quote_time, quote_type) DO UPDATE SET
            name = excluded.name,
            market_type = excluded.market_type,
            fund_code = excluded.fund_code,
            price_int = excluded.price_int,
            nav_int = excluded.nav_int,
            change_ppm = excluded.change_ppm,
            source = excluded.source,
            raw_json = excluded.raw_json,
            updated_at = datetime('now')`,
          {
            symbol,
            name: quote.name ?? quote.title ?? fund?.name ?? symbol,
            marketType,
            fundCode: fund?.code ?? null,
            quoteDate,
            quoteTime,
            quoteType,
            priceInt,
            navInt,
            changePpm: quote.changePpm ?? quote.change_ppm ?? null,
            source: quote.source ?? null,
            rawJson: maybeJson(quote.raw ?? quote.rawJson ?? quote.raw_json)
          }
        );

        rows.push(
          get(
            `SELECT *
             FROM market_quotes
             WHERE symbol = :symbol
               AND quote_date = :quoteDate
               AND quote_time = :quoteTime
               AND quote_type = :quoteType`,
            { symbol, quoteDate, quoteTime, quoteType }
          )
        );
      }

      return rows;
    });
  }

  function recordDecision(input = {}) {
    return transaction(() => {
      const account = requireAccount(input.accountId ?? input.account_id);
      const submittedAt = toLocalDateTime(input.submittedAt ?? input.submitted_at ?? new Date());
      const decisionDate = toLocalDate(input.decisionDate ?? input.decision_date ?? submittedAt);
      const action = String(input.action ?? input.kind ?? input.type ?? '').trim();
      if (!action) {
        throw new Error('Decision action is required.');
      }

      const fundCode = input.fundCode ?? input.fund_code ?? input.code ?? null;
      if (fundCode) {
        ensureFund({ code: fundCode, name: input.fundName ?? input.fund_name ?? fundCode });
      }

      const countsDaily = input.countsDaily ?? input.counts_daily;
      const shouldCount = countsDaily === undefined ? COUNTING_ACTIONS.has(action) : Number(Boolean(countsDaily));
      let dailySequence = null;

      if (shouldCount) {
        const countRow = get(
          `SELECT COUNT(*) AS count
           FROM decisions
           WHERE account_id = :accountId
             AND decision_date = :decisionDate
             AND counts_daily = 1`,
          { accountId: account.id, decisionDate }
        );
        const currentCount = Number(countRow.count);
        if (currentCount >= account.daily_decision_limit) {
          throw new Error(`Daily decision limit exceeded for ${decisionDate}.`);
        }
        dailySequence = currentCount + 1;
      }

      const amountCents = readCents(input, ['amountCents', 'amount_cents', 'amount'], null);
      const sharesInt = readInt(input, ['sharesInt', 'shares_int'], ['shares'], sharesToInt, null);
      const navInt = readInt(input, ['navInt', 'nav_int'], ['nav'], navToInt, null);

      run(
        `INSERT INTO decisions (
          account_id,
          decision_date,
          submitted_at,
          action,
          fund_code,
          amount_cents,
          shares_int,
          nav_int,
          reason,
          confidence,
          counts_daily,
          daily_sequence,
          status,
          legacy_path,
          note
        ) VALUES (
          :accountId,
          :decisionDate,
          :submittedAt,
          :action,
          :fundCode,
          :amountCents,
          :sharesInt,
          :navInt,
          :reason,
          :confidence,
          :countsDaily,
          :dailySequence,
          :status,
          :legacyPath,
          :note
        )`,
        {
          accountId: account.id,
          decisionDate,
          submittedAt,
          action,
          fundCode,
          amountCents,
          sharesInt,
          navInt,
          reason: input.reason ?? null,
          confidence: input.confidence ?? null,
          countsDaily: shouldCount ? 1 : 0,
          dailySequence,
          status: input.status ?? 'recorded',
          legacyPath: input.legacyPath ?? input.legacy_path ?? null,
          note: input.note ?? null
        }
      );

      return get('SELECT * FROM decisions WHERE id = last_insert_rowid()');
    });
  }

  function makeOrderNo(date) {
    const prefix = `ORD-${date.replaceAll('-', '')}`;
    const row = get(
      `SELECT COUNT(*) AS count
       FROM orders
       WHERE order_no LIKE :prefix`,
      { prefix: `${prefix}-%` }
    );
    return `${prefix}-${String(Number(row.count) + 1).padStart(4, '0')}`;
  }

  function createOrder(input = {}) {
    return transaction(() => {
      const account = requireAccount(input.accountId ?? input.account_id);
      const fund = ensureFund(input);
      const side = String(input.side ?? input.action ?? '').trim();
      if (!['buy', 'sell'].includes(side)) {
        throw new Error('Order side must be buy or sell.');
      }

      const submittedAt = toLocalDateTime(input.submittedAt ?? input.submitted_at ?? new Date());
      const tradeDate = toLocalDate(input.tradeDate ?? input.trade_date ?? applicationTradeDate(submittedAt));
      const amountCents = readCents(input, ['amountCents', 'amount_cents', 'amount'], null);
      const sharesInt = readInt(input, ['sharesInt', 'shares_int'], ['shares'], sharesToInt, null);
      const feeCents = readCents(input, ['feeCents', 'fee_cents', 'fee'], 0);
      const orderNo = input.orderNo ?? input.order_no ?? makeOrderNo(tradeDate);
      const decisionId = input.decisionId ?? input.decision_id ?? null;

      if (side === 'buy') {
        assertPositiveInteger(amountCents, 'amountCents');
        applyCashChange({
          accountId: account.id,
          type: 'buy_order',
          amountCents,
          occurredAt: submittedAt,
          relatedType: 'order',
          relatedId: orderNo,
          note: input.note ?? `买入申请 ${fund.code}`
        });
      } else {
        assertPositiveInteger(sharesInt, 'sharesInt');
        const position = get(
          'SELECT * FROM positions WHERE account_id = :accountId AND fund_code = :fundCode',
          { accountId: account.id, fundCode: fund.code }
        );
        if (!position || position.shares_int < sharesInt) {
          throw new RangeError('Position shares are insufficient for sell order.');
        }
      }

      run(
        `INSERT INTO orders (
          order_no,
          account_id,
          decision_id,
          fund_code,
          side,
          status,
          amount_cents,
          shares_int,
          fee_cents,
          submitted_at,
          trade_date,
          note
        ) VALUES (
          :orderNo,
          :accountId,
          :decisionId,
          :fundCode,
          :side,
          'submitted',
          :amountCents,
          :sharesInt,
          :feeCents,
          :submittedAt,
          :tradeDate,
          :note
        )`,
        {
          orderNo,
          accountId: account.id,
          decisionId,
          fundCode: fund.code,
          side,
          amountCents,
          sharesInt,
          feeCents,
          submittedAt,
          tradeDate,
          note: input.note ?? null
        }
      );

      if (decisionId) {
        run(
          `UPDATE decisions
           SET order_no = :orderNo, status = 'ordered'
           WHERE id = :decisionId`,
          { orderNo, decisionId }
        );
      }

      return get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo });
    });
  }

  function upsertPositionBuy({ accountId, fundCode, sharesInt, costCents, navInt, navDate }) {
    const existing = get(
      'SELECT * FROM positions WHERE account_id = :accountId AND fund_code = :fundCode',
      { accountId, fundCode }
    );
    const nextShares = (existing?.shares_int ?? 0) + sharesInt;
    const nextCost = (existing?.cost_cents ?? 0) + costCents;
    const avgCostNavInt = centsToNavInt(nextCost, nextShares);
    const marketValueCents = amountCentsFromSharesAndNav(nextShares, navInt);

    run(
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
        :navInt,
        :navDate,
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
      {
        accountId,
        fundCode,
        sharesInt: nextShares,
        costCents: nextCost,
        avgCostNavInt,
        navInt,
        navDate,
        marketValueCents
      }
    );
  }

  function applyPositionSell({ accountId, fundCode, sharesInt, navInt, navDate, feeCents }) {
    const position = get(
      'SELECT * FROM positions WHERE account_id = :accountId AND fund_code = :fundCode',
      { accountId, fundCode }
    );
    if (!position || position.shares_int < sharesInt) {
      throw new RangeError('Position shares are insufficient for sell confirmation.');
    }

    const grossCents = amountCentsFromSharesAndNav(sharesInt, navInt);
    const settledAmountCents = grossCents - feeCents;
    const costBasisCents = Math.floor((position.cost_cents * sharesInt) / position.shares_int);
    const nextShares = position.shares_int - sharesInt;
    const nextCost = position.cost_cents - costBasisCents;
    const avgCostNavInt = centsToNavInt(nextCost, nextShares);
    const marketValueCents = nextShares ? amountCentsFromSharesAndNav(nextShares, navInt) : 0;

    if (nextShares === 0) {
      run(
        `DELETE FROM positions
         WHERE account_id = :accountId AND fund_code = :fundCode`,
        { accountId, fundCode }
      );
    } else {
      run(
        `UPDATE positions
         SET shares_int = :sharesInt,
             cost_cents = :costCents,
             avg_cost_nav_int = :avgCostNavInt,
             last_nav_int = :navInt,
             last_nav_date = :navDate,
             market_value_cents = :marketValueCents,
             updated_at = datetime('now')
         WHERE account_id = :accountId AND fund_code = :fundCode`,
        {
          accountId,
          fundCode,
          sharesInt: nextShares,
          costCents: nextCost,
          avgCostNavInt,
          navInt,
          navDate,
          marketValueCents
        }
      );
    }

    return {
      confirmedSharesInt: sharesInt,
      settledAmountCents,
      costBasisCents,
      realizedPnlCents: settledAmountCents - costBasisCents
    };
  }

  function confirmOrder(orderNoOrInput, maybeInput = {}) {
    const orderNo = typeof orderNoOrInput === 'object'
      ? orderNoOrInput.orderNo ?? orderNoOrInput.order_no
      : orderNoOrInput;
    const input = typeof orderNoOrInput === 'object' ? orderNoOrInput : maybeInput;

    return transaction(() => {
      const order = get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo });
      if (!order) {
        throw new Error(`Order not found: ${orderNo}`);
      }
      if (order.status !== 'submitted') {
        throw new Error(`Only submitted orders can be confirmed. Current status: ${order.status}`);
      }

      const navInt = readInt(input, ['navInt', 'nav_int'], ['nav'], navToInt, order.nav_int);
      assertPositiveInteger(navInt, 'navInt');
      const confirmDate = toLocalDate(input.confirmDate ?? input.confirm_date ?? nextTradeDate(order.trade_date));
      const settleDate = toLocalDate(input.settleDate ?? input.settle_date ?? confirmDate);
      let confirmedSharesInt = order.confirmed_shares_int;
      let settledAmountCents = order.settled_amount_cents;
      let costBasisCents = order.cost_basis_cents;

      if (order.side === 'buy') {
        const netCents = order.amount_cents - order.fee_cents;
        assertPositiveInteger(netCents, 'net buy amount');
        confirmedSharesInt = sharesIntFromAmountAndNav(netCents, navInt);
        settledAmountCents = 0;
        costBasisCents = order.amount_cents;
        upsertPositionBuy({
          accountId: order.account_id,
          fundCode: order.fund_code,
          sharesInt: confirmedSharesInt,
          costCents: order.amount_cents,
          navInt,
          navDate: confirmDate
        });
      } else {
        const sellResult = applyPositionSell({
          accountId: order.account_id,
          fundCode: order.fund_code,
          sharesInt: order.shares_int,
          navInt,
          navDate: confirmDate,
          feeCents: order.fee_cents
        });
        confirmedSharesInt = sellResult.confirmedSharesInt;
        settledAmountCents = sellResult.settledAmountCents;
        costBasisCents = sellResult.costBasisCents;
      }

      run(
        `UPDATE orders
         SET status = 'confirmed',
             confirm_date = :confirmDate,
             settle_date = :settleDate,
             nav_int = :navInt,
             confirmed_shares_int = :confirmedSharesInt,
             settled_amount_cents = :settledAmountCents,
             cost_basis_cents = :costBasisCents,
             updated_at = datetime('now')
         WHERE order_no = :orderNo`,
        {
          orderNo,
          confirmDate,
          settleDate,
          navInt,
          confirmedSharesInt,
          settledAmountCents,
          costBasisCents
        }
      );

      return get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo });
    });
  }

  function settleOrder(orderNoOrInput, maybeInput = {}) {
    const orderNo = typeof orderNoOrInput === 'object'
      ? orderNoOrInput.orderNo ?? orderNoOrInput.order_no
      : orderNoOrInput;
    const input = typeof orderNoOrInput === 'object' ? orderNoOrInput : maybeInput;

    return transaction(() => {
      const order = get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo });
      if (!order) {
        throw new Error(`Order not found: ${orderNo}`);
      }
      if (order.status !== 'confirmed') {
        throw new Error(`Only confirmed orders can be settled. Current status: ${order.status}`);
      }

      const settleDate = toLocalDate(input.settleDate ?? input.settle_date ?? order.settle_date ?? nextTradeDate(order.trade_date));
      if (order.side === 'sell') {
        applyCashChange({
          accountId: order.account_id,
          type: 'sell_settlement',
          amountCents: order.settled_amount_cents,
          occurredAt: `${settleDate} 15:00:00`,
          relatedType: 'order',
          relatedId: order.order_no,
          note: input.note ?? `卖出到账 ${order.fund_code}`
        });

        run(
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
            :fundCode,
            :entryDate,
            'realized',
            :amountCents,
            :basisCents,
            :orderNo,
            :note
          )`,
          {
            accountId: order.account_id,
            fundCode: order.fund_code,
            entryDate: settleDate,
            amountCents: order.settled_amount_cents - order.cost_basis_cents,
            basisCents: order.cost_basis_cents,
            orderNo: order.order_no,
            note: input.note ?? null
          }
        );
      }

      run(
        `UPDATE orders
         SET status = 'settled',
             settle_date = :settleDate,
             updated_at = datetime('now')
         WHERE order_no = :orderNo`,
        { orderNo, settleDate }
      );

      return get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo });
    });
  }

  function createSnapshot(input = {}) {
    return transaction(() => {
      const account = requireAccount(input.accountId ?? input.account_id);
      const snapshotDate = toLocalDate(input.snapshotDate ?? input.snapshot_date ?? input.date ?? new Date());
      const positions = all(
        `SELECT *
         FROM positions
         WHERE account_id = :accountId
         ORDER BY fund_code ASC`,
        { accountId: account.id }
      ).map((position) => {
        const nav = latestNav(position.fund_code, snapshotDate);
        const navInt = nav?.nav_int ?? position.last_nav_int;
        const marketValueCents = navInt ? amountCentsFromSharesAndNav(position.shares_int, navInt) : position.market_value_cents;

        run(
          `UPDATE positions
           SET last_nav_int = :navInt,
               last_nav_date = :navDate,
               market_value_cents = :marketValueCents,
               updated_at = datetime('now')
           WHERE account_id = :accountId AND fund_code = :fundCode`,
          {
            accountId: account.id,
            fundCode: position.fund_code,
            navInt,
            navDate: nav?.nav_date ?? position.last_nav_date,
            marketValueCents
          }
        );

        return {
          ...position,
          nav_int: navInt,
          nav_date: nav?.nav_date ?? position.last_nav_date,
          market_value_cents: marketValueCents,
          unrealized_pnl_cents: marketValueCents - position.cost_cents
        };
      });
      const positionsMarketValueCents = positions.reduce((sum, position) => sum + position.market_value_cents, 0);
      const totalAssetsCents = account.cash_available_cents + account.cash_frozen_cents + positionsMarketValueCents;
      const previous = get(
        `SELECT *
         FROM account_snapshots
         WHERE account_id = :accountId AND snapshot_date < :snapshotDate
         ORDER BY snapshot_date DESC
         LIMIT 1`,
        { accountId: account.id, snapshotDate }
      );
      const dailyPnlCents = previous ? totalAssetsCents - previous.total_assets_cents : null;
      const accumulatedPnlCents = totalAssetsCents - account.initial_cash_cents;

      run(
        `INSERT INTO account_snapshots (
          account_id,
          snapshot_date,
          cash_available_cents,
          cash_frozen_cents,
          positions_market_value_cents,
          total_assets_cents,
          daily_pnl_cents,
          accumulated_pnl_cents,
          note
        ) VALUES (
          :accountId,
          :snapshotDate,
          :cashAvailableCents,
          :cashFrozenCents,
          :positionsMarketValueCents,
          :totalAssetsCents,
          :dailyPnlCents,
          :accumulatedPnlCents,
          :note
        )
        ON CONFLICT(account_id, snapshot_date) DO UPDATE SET
          cash_available_cents = excluded.cash_available_cents,
          cash_frozen_cents = excluded.cash_frozen_cents,
          positions_market_value_cents = excluded.positions_market_value_cents,
          total_assets_cents = excluded.total_assets_cents,
          daily_pnl_cents = excluded.daily_pnl_cents,
          accumulated_pnl_cents = excluded.accumulated_pnl_cents,
          note = excluded.note`,
        {
          accountId: account.id,
          snapshotDate,
          cashAvailableCents: account.cash_available_cents,
          cashFrozenCents: account.cash_frozen_cents,
          positionsMarketValueCents,
          totalAssetsCents,
          dailyPnlCents,
          accumulatedPnlCents,
          note: input.note ?? null
        }
      );

      const snapshot = get(
        `SELECT *
         FROM account_snapshots
         WHERE account_id = :accountId AND snapshot_date = :snapshotDate`,
        { accountId: account.id, snapshotDate }
      );
      run('DELETE FROM snapshot_positions WHERE snapshot_id = :snapshotId', { snapshotId: snapshot.id });

      for (const position of positions) {
        run(
          `INSERT INTO snapshot_positions (
            snapshot_id,
            fund_code,
            shares_int,
            cost_cents,
            nav_int,
            market_value_cents,
            unrealized_pnl_cents
          ) VALUES (
            :snapshotId,
            :fundCode,
            :sharesInt,
            :costCents,
            :navInt,
            :marketValueCents,
            :unrealizedPnlCents
          )`,
          {
            snapshotId: snapshot.id,
            fundCode: position.fund_code,
            sharesInt: position.shares_int,
            costCents: position.cost_cents,
            navInt: position.nav_int,
            marketValueCents: position.market_value_cents,
            unrealizedPnlCents: position.unrealized_pnl_cents
          }
        );
      }

      return {
        ...snapshot,
        positions
      };
    });
  }

  function getToday(input = {}) {
    const submittedAt = input.submittedAt ?? input.submitted_at ?? input.date ?? new Date();
    const today = toLocalDate(submittedAt);
    const account = requireAccount(input.accountId ?? input.account_id);
    const decisionCount = get(
      `SELECT COUNT(*) AS count
       FROM decisions
       WHERE account_id = :accountId
         AND decision_date = :today
         AND counts_daily = 1`,
      { accountId: account.id, today }
    );

    return {
      date: today,
      submittedAt: toLocalDateTime(submittedAt),
      applicationTradeDate: applicationTradeDate(submittedAt),
      nextTradeDate: nextTradeDate(today),
      decisionCount: Number(decisionCount.count),
      decisionLimit: account.daily_decision_limit
    };
  }

  function listPositions(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT
         p.*,
         f.name AS fund_name
       FROM positions p
       JOIN funds f ON f.code = p.fund_code
       WHERE p.account_id = :accountId
       ORDER BY p.market_value_cents DESC, p.fund_code ASC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM positions
        WHERE account_id = :accountId`,
      params: { accountId: account.id },
      mapRow: (position) => {
        const unrealizedPnlCents = position.market_value_cents - position.cost_cents;
        const returnPpm = ratioPpm(unrealizedPnlCents, position.cost_cents);

        return {
          ...position,
          fundCode: position.fund_code,
          fundName: position.fund_name,
          shares: intToShares(position.shares_int),
          cost: centsToMoney(position.cost_cents),
          lastNav: position.last_nav_int === null ? null : intToNav(position.last_nav_int),
          marketValue: centsToMoney(position.market_value_cents),
          unrealizedPnlCents,
          unrealizedPnl: centsToMoney(unrealizedPnlCents),
          pnlPpm: returnPpm,
          pnlRate: returnPpm === null ? null : returnPpm / 1000000,
          returnPpm,
          returnRate: returnPpm === null ? null : returnPpm / 1000000
        };
      }
    });
  }

  function getPositionHistory(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const fundCode = input.fundCode ?? input.fund_code ?? input.code;
    if (!fundCode) {
      throw new Error('Fund code is required.');
    }

    const position = get(
      `SELECT *
       FROM positions
       WHERE account_id = :accountId AND fund_code = :fundCode`,
      { accountId: account.id, fundCode }
    );
    if (!position) {
      throw new Error(`Position not found: ${fundCode}`);
    }

    return listRows({
      input,
      selectSql: `SELECT
         s.snapshot_date,
         sp.fund_code,
         f.name AS fund_name,
         sp.shares_int,
         sp.cost_cents,
         sp.nav_int,
         sp.market_value_cents,
         sp.unrealized_pnl_cents,
         fn.nav_date,
         fn.source AS nav_source,
         prev.nav_int AS previous_nav_int
       FROM snapshot_positions sp
       JOIN account_snapshots s ON s.id = sp.snapshot_id
       JOIN funds f ON f.code = sp.fund_code
       LEFT JOIN fund_navs fn
         ON fn.id = (
           SELECT current_nav.id
           FROM fund_navs current_nav
           WHERE current_nav.fund_code = sp.fund_code
             AND current_nav.nav_date <= s.snapshot_date
           ORDER BY current_nav.nav_date DESC
           LIMIT 1
         )
       LEFT JOIN fund_navs prev
         ON prev.id = (
           SELECT previous_nav.id
           FROM fund_navs previous_nav
           WHERE previous_nav.fund_code = sp.fund_code
             AND previous_nav.nav_date < fn.nav_date
           ORDER BY previous_nav.nav_date DESC
           LIMIT 1
         )
       WHERE s.account_id = :accountId
         AND sp.fund_code = :fundCode
       ORDER BY s.snapshot_date DESC, s.id DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
       FROM snapshot_positions sp
       JOIN account_snapshots s ON s.id = sp.snapshot_id
       WHERE s.account_id = :accountId
         AND sp.fund_code = :fundCode`,
      params: { accountId: account.id, fundCode },
      mapRow: (row) => {
        const navChangePpm = row.previous_nav_int === null
          ? null
          : ratioPpm(row.nav_int - row.previous_nav_int, row.previous_nav_int);
        const returnPpm = ratioPpm(row.unrealized_pnl_cents, row.cost_cents);

        return {
          ...row,
          snapshotDate: row.snapshot_date,
          fundCode: row.fund_code,
          fundName: row.fund_name,
          nav: row.nav_int === null ? null : intToNav(row.nav_int),
          navDate: row.nav_date ?? row.snapshot_date,
          navChangePpm,
          navChangeRate: navChangePpm === null ? null : navChangePpm / 1000000,
          navSource: row.nav_source,
          shares: intToShares(row.shares_int),
          cost: centsToMoney(row.cost_cents),
          marketValue: centsToMoney(row.market_value_cents),
          unrealizedPnl: centsToMoney(row.unrealized_pnl_cents),
          returnPpm,
          returnRate: returnPpm === null ? null : returnPpm / 1000000
        };
      }
    });
  }

  function getAccountSummary(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const balance = getAccountBalance(account.id);
    const positions = listPositions({ accountId: account.id });
    const positionsMarketValueCents = positions.reduce((sum, position) => sum + position.market_value_cents, 0);
    const latestSnapshot = get(
      `SELECT *
       FROM account_snapshots
       WHERE account_id = :accountId
       ORDER BY snapshot_date DESC
       LIMIT 1`,
      { accountId: account.id }
    );

    return {
      account,
      balance,
      positionCount: positions.length,
      positionsMarketValueCents,
      positionsMarketValue: centsToMoney(positionsMarketValueCents),
      totalAssetsCents: balance.cashTotalCents + positionsMarketValueCents,
      totalAssets: centsToMoney(balance.cashTotalCents + positionsMarketValueCents),
      latestSnapshot
    };
  }

  function listOrders(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT
         o.*,
         f.name AS fund_name
       FROM orders o
       JOIN funds f ON f.code = o.fund_code
       WHERE o.account_id = :accountId
       ORDER BY o.created_at DESC, o.order_no DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM orders
        WHERE account_id = :accountId`,
      params: { accountId: account.id }
    });
  }

  function listDecisions(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT
         d.*,
         f.name AS fund_name
       FROM decisions d
       LEFT JOIN funds f ON f.code = d.fund_code
       WHERE d.account_id = :accountId
       ORDER BY d.decision_date DESC, d.id DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM decisions
        WHERE account_id = :accountId`,
      params: { accountId: account.id }
    });
  }

  function listPnlEntries(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT
         p.*,
         f.name AS fund_name
       FROM pnl_entries p
       LEFT JOIN funds f ON f.code = p.fund_code
       WHERE p.account_id = :accountId
       ORDER BY p.entry_date DESC, p.id DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM pnl_entries
        WHERE account_id = :accountId`,
      params: { accountId: account.id }
    });
  }

  function listCashLedger(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT *
       FROM cash_ledger
       WHERE account_id = :accountId
       ORDER BY occurred_at DESC, id DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM cash_ledger
        WHERE account_id = :accountId`,
      params: { accountId: account.id }
    });
  }

  function listSnapshots(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    return listRows({
      input,
      selectSql: `SELECT *
       FROM account_snapshots
       WHERE account_id = :accountId
       ORDER BY snapshot_date DESC, id DESC`,
      countSql: `SELECT COUNT(*) AS totalItems
        FROM account_snapshots
        WHERE account_id = :accountId`,
      params: { accountId: account.id }
    });
  }

  function enrichDecision(row) {
    if (!row) {
      return row;
    }

    return {
      ...row,
      actionType: row.action,
      decisionId: row.id,
      decisionNo: row.note,
      amount: row.amount_cents === null ? null : centsToMoney(row.amount_cents),
      shares: row.shares_int === null ? null : intToShares(row.shares_int),
      nav: row.nav_int === null ? null : intToNav(row.nav_int),
      href: row.note ? `/actions/${row.note}` : `/actions/${row.id}`,
      legacyPath: row.legacy_path
    };
  }

  function enrichOrder(row) {
    if (!row) {
      return row;
    }

    return {
      ...row,
      orderNo: row.order_no,
      actionType: row.side,
      fundCode: row.fund_code,
      fundName: row.fund_name,
      amount: row.amount_cents === null ? null : centsToMoney(row.amount_cents),
      shares: row.shares_int === null ? null : intToShares(row.shares_int),
      nav: row.nav_int === null ? null : intToNav(row.nav_int)
    };
  }

  function enrichPnlEntry(row, account) {
    const totalAssetsCents = row.basis_cents ?? null;
    const cumulativePnlCents = totalAssetsCents === null ? null : totalAssetsCents - account.initial_cash_cents;

    return {
      ...row,
      entryDate: row.entry_date,
      dailyPnlCents: row.amount_cents,
      dailyPnl: centsToMoney(row.amount_cents),
      totalAssetsCents,
      totalAssets: totalAssetsCents === null ? null : centsToMoney(totalAssetsCents),
      accumulatedPnlCents: cumulativePnlCents,
      accumulatedPnl: cumulativePnlCents === null ? null : centsToMoney(cumulativePnlCents)
    };
  }

  function buildAccountViewModel(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const summary = getAccountSummary({ accountId: account.id });
    const cashPage = listCashLedger(paginationInput(
      { ...input, accountId: account.id },
      ['cashPage', 'cash_page'],
      ['cashPageSize', 'cash_page_size'],
    ));
    const snapshotPage = listSnapshots(paginationInput(
      { ...input, accountId: account.id },
      ['snapshotPage', 'snapshot_page'],
      ['snapshotPageSize', 'snapshot_page_size'],
    ));
    return {
      ...summary,
      positions: listPositions({ accountId: account.id }),
      cashLedger: pageItems(cashPage),
      cashPagination: pageMeta(cashPage),
      snapshots: pageItems(snapshotPage),
      snapshotPagination: pageMeta(snapshotPage)
    };
  }

  function getDashboardViewModel(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const accountModel = buildAccountViewModel({ accountId: account.id });
    const today = getToday({
      accountId: account.id,
      date: input.date ?? input.submittedAt ?? input.submitted_at ?? new Date()
    });
    const decisionsPage = listDecisions({
      accountId: account.id,
      paginated: true,
      pageSize: 10
    });
    const decisions = pageItems(decisionsPage).map(enrichDecision);
    const summary = {
      ...accountModel,
      ...accountModel.balance,
      decisionCount: today.decisionCount,
      decisionLimit: today.decisionLimit
    };

    return {
      ...accountModel,
      summary,
      positions: accountModel.positions,
      latestActions: decisions,
      actions: decisions,
      latestAction: decisions[0] ?? null
    };
  }

  function getAccountViewModel(input = {}) {
    return buildAccountViewModel(input);
  }

  function getOperationsViewModel(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const decisionsPage = listDecisions(paginationInput(
      { ...input, accountId: account.id },
      ['decisionPage', 'decision_page', 'decisionsPage', 'decisions_page'],
      ['decisionPageSize', 'decision_page_size', 'decisionsPageSize', 'decisions_page_size'],
    ));
    const orderPage = listOrders(paginationInput(
      { ...input, accountId: account.id },
      ['orderPage', 'order_page', 'ordersPage', 'orders_page'],
      ['orderPageSize', 'order_page_size', 'ordersPageSize', 'orders_page_size'],
    ));
    const cashPage = listCashLedger(paginationInput(
      { ...input, accountId: account.id },
      ['cashPage', 'cash_page'],
      ['cashPageSize', 'cash_page_size'],
    ));
    const decisions = pageItems(decisionsPage).map(enrichDecision);
    return {
      decisions,
      decisionPagination: pageMeta(decisionsPage),
      actions: decisions,
      orders: pageItems(orderPage).map(enrichOrder),
      orderPagination: pageMeta(orderPage),
      cashLedger: pageItems(cashPage),
      cashPagination: pageMeta(cashPage)
    };
  }

  function getPnlViewModel(input = {}) {
    const account = requireAccount(input.accountId ?? input.account_id);
    const summary = getAccountSummary({ accountId: account.id });
    const positions = listPositions({ accountId: account.id });
    const unrealizedPnlCents = positions.reduce(
      (sum, position) => sum + position.market_value_cents - position.cost_cents,
      0
    );
    const totalPnlCents = summary.totalAssetsCents - account.initial_cash_cents;
    const pnlPage = listPnlEntries(paginationInput(
      { ...input, accountId: account.id },
      ['pnlPage', 'pnl_page'],
      ['pnlPageSize', 'pnl_page_size'],
    ));
    const pnlEntries = pageItems(pnlPage).map((row) => enrichPnlEntry(row, account));

    return {
      summary: {
        ...summary,
        accumulatedPnlCents: totalPnlCents,
        accumulatedPnl: centsToMoney(totalPnlCents),
        totalPnlCents,
        totalPnl: centsToMoney(totalPnlCents),
        unrealizedPnlCents,
        unrealizedPnl: centsToMoney(unrealizedPnlCents)
      },
      pnlEntries,
      pnlPagination: pageMeta(pnlPage),
      positions
    };
  }

  function getDecisionDetail(idOrInput) {
    const id = typeof idOrInput === 'object' ? idOrInput.id : idOrInput;
    const decision = get(
      `SELECT
         d.*,
         f.name AS fund_name
       FROM decisions d
       LEFT JOIN funds f ON f.code = d.fund_code
       WHERE d.id = :id OR d.note = :id`,
      { id }
    );
    if (!decision) {
      return null;
    }

    const order = decision.order_no
      ? get('SELECT * FROM orders WHERE order_no = :orderNo', { orderNo: decision.order_no })
      : null;
    const sourceRefs = all(
      `SELECT sr.*, ds.name AS source_name, ds.url AS source_url
       FROM source_refs sr
       LEFT JOIN data_sources ds ON ds.id = sr.source_id
       WHERE sr.entity_type = 'decision' AND sr.entity_id = :id
       ORDER BY sr.id ASC`,
      { id: String(decision.id) }
    );

    return {
      decision: enrichDecision(decision),
      action: enrichDecision(decision),
      order: enrichOrder(order),
      sourceRefs
    };
  }

  function getActionViewModel(input = {}) {
    return getDecisionDetail(input);
  }

  return {
    setupDefaultAccount,
    getAccountBalance,
    adjustCash,
    upsertFund,
    writeFundNav,
    writeMarketQuotes,
    recordDecision,
    createOrder,
    confirmOrder,
    settleOrder,
    createSnapshot,
    getToday,
    getDashboardViewModel,
    getAccountViewModel,
    getOperationsViewModel,
    getPnlViewModel,
    getActionViewModel,
    getAccountSummary,
    listPositions,
    getPositionHistory,
    listOrders,
    listDecisions,
    listPnlEntries,
    listCashLedger,
    listSnapshots,
    getDecisionDetail
  };
}
