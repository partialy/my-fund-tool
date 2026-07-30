import express from 'express';

const LEDGER_METHODS = {
  today: ['getToday', 'getTodayState', 'getTradingDayInfo', 'resolveToday'],
  account: ['getAccount', 'getAccountSummary', 'getAccountOverview'],
  balance: ['getAccountBalance', 'getBalance', 'getBalanceSummary'],
  cashAdjustment: ['createCashAdjustment', 'recordCashAdjustment', 'adjustCash'],
  positions: ['listPositions', 'getPositions'],
  positionHistory: ['getPositionHistory', 'listPositionHistory'],
  orders: ['listOrders', 'getOrders'],
  decisions: ['listDecisions', 'getDecisions'],
  pnl: ['getPnl', 'listPnl', 'listPnlEntries', 'getPnlEntries', 'getProfitAndLoss'],
  cashLedger: ['listCashLedger', 'getCashLedger', 'listCashEntries'],
  snapshots: ['listSnapshots', 'getSnapshots', 'listAccountSnapshots'],
  fundNav: ['writeFundNav', 'upsertFundNav', 'setFundNav', 'recordFundNav'],
  marketQuotes: [
    'writeMarketQuotes',
    'upsertMarketQuotes',
    'recordMarketQuotes',
    'writeMarketQuote',
    'upsertMarketQuote',
    'recordMarketQuote',
  ],
  decision: ['createDecision', 'recordDecision', 'addDecision'],
  order: ['createOrder', 'submitOrder', 'placeOrder'],
  confirmOrder: ['confirmOrder', 'confirmOrderByNo'],
  settleOrder: ['settleOrder', 'settleOrderByNo'],
  snapshot: [
    'createValuationSnapshot',
    'createSnapshot',
    'recordValuationSnapshot',
    'snapshotValuation',
  ],
};

export function createApiRouter({ ledger, db, importLegacyData } = {}) {
  if (!ledger) {
    throw new Error('createApiRouter requires a ledger service.');
  }

  const router = express.Router();

  router.get('/health', asyncHandler(async (_request, response) => {
    sendSuccessResponse(response, { status: 'ok' });
  }));

  router.get('/today', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.today, queryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/account', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.account, queryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/account/balance', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.balance, queryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/account/cash-adjustments', asyncHandler(async (request, response) => {
    const data = await callLedger(
      ledger,
      LEDGER_METHODS.cashAdjustment,
      cashAdjustmentPayload(request),
    );
    sendSuccessResponse(response, data);
  }));

  router.get('/positions', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.positions, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/positions/:fundCode/history', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.positionHistory, {
      ...paginatedQueryPayload(request),
      fundCode: request.params.fundCode,
    });
    sendSuccessResponse(response, data);
  }));

  router.get('/orders', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.orders, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/decisions', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.decisions, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/pnl', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.pnl, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/account/cash-ledger', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.cashLedger, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.get('/account/snapshots', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.snapshots, paginatedQueryPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/market/funds/:code/nav', asyncHandler(async (request, response) => {
    const payload = bodyWithParams(request, { code: request.params.code });
    const data = await callLedger(
      ledger,
      LEDGER_METHODS.fundNav,
      payload,
      [request.params.code, bodyPayload(request)],
    );
    sendSuccessResponse(response, data);
  }));

  router.post('/market/quotes', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.marketQuotes, bodyPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/decisions', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.decision, bodyPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/orders', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.order, bodyPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/orders/:orderNo/confirm', asyncHandler(async (request, response) => {
    const payload = bodyWithParams(request, { orderNo: request.params.orderNo });
    const data = await callLedger(
      ledger,
      LEDGER_METHODS.confirmOrder,
      payload,
      [request.params.orderNo, bodyPayload(request)],
    );
    sendSuccessResponse(response, data);
  }));

  router.post('/orders/:orderNo/settle', asyncHandler(async (request, response) => {
    const payload = bodyWithParams(request, { orderNo: request.params.orderNo });
    const data = await callLedger(
      ledger,
      LEDGER_METHODS.settleOrder,
      payload,
      [request.params.orderNo, bodyPayload(request)],
    );
    sendSuccessResponse(response, data);
  }));

  router.post('/valuation/snapshot', asyncHandler(async (request, response) => {
    const data = await callLedger(ledger, LEDGER_METHODS.snapshot, bodyPayload(request));
    sendSuccessResponse(response, data);
  }));

  router.post('/import/legacy', asyncHandler(async (request, response) => {
    const importer = await resolveLegacyImporter(importLegacyData);
    const payload = {
      db,
      ledger,
      ...queryPayload(request),
      ...objectPayload(bodyPayload(request)),
    };
    const data = await importer(payload);
    sendSuccessResponse(response, data);
  }));

  router.use((request, response) => {
    sendErrorResponse(response, {
      status: 404,
      code: 'NOT_FOUND',
      message: `API route not found: ${request.method} ${request.originalUrl}`,
    });
  });

  router.use((error, _request, response, _next) => {
    sendErrorResponse(response, error);
  });

  return router;
}

export function sendSuccessResponse(response, data, status = 200) {
  response.status(status).json({ ok: true, data: data ?? null });
}

export function sendErrorResponse(response, error) {
  if (response.headersSent) {
    return;
  }

  const normalized = normalizeError(error);
  const body = {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
    },
  };

  if (normalized.details !== undefined) {
    body.error.details = normalized.details;
  }

  response.status(normalized.status).json(body);
}

function asyncHandler(handler) {
  return async (request, response, next) => {
    try {
      await handler(request, response, next);
    } catch (error) {
      next(error);
    }
  };
}

async function callLedger(ledger, names, payload, positionalArgs = []) {
  const { method } = resolveMethod(ledger, names);

  if (positionalArgs.length > 0 && method.length > 1) {
    return method.apply(ledger, positionalArgs);
  }

  return method.call(ledger, payload);
}

function resolveMethod(target, names) {
  const name = names.find((candidate) => typeof target[candidate] === 'function');

  if (!name) {
    throw {
      status: 500,
      code: 'LEDGER_METHOD_NOT_FOUND',
      message: `Ledger service does not implement any of: ${names.join(', ')}`,
      details: { expectedMethods: names },
    };
  }

  return { name, method: target[name] };
}

function queryPayload(request) {
  return { ...request.query };
}

function paginatedQueryPayload(request) {
  return { ...request.query, paginated: true };
}

function bodyPayload(request) {
  return request.body ?? {};
}

function bodyWithParams(request, params) {
  const body = bodyPayload(request);

  if (isPlainObject(body)) {
    return { ...body, ...params };
  }

  return { ...params, value: body };
}

function cashAdjustmentPayload(request) {
  const body = bodyPayload(request);

  if (!isPlainObject(body) || body.type !== 'correction') {
    return body;
  }

  const hasTargetBalance = ['targetBalance', 'target_balance', 'balance'].some(
    (key) => body[key] !== undefined,
  );

  if (hasTargetBalance || body.amount === undefined) {
    return body;
  }

  return { ...body, targetBalance: body.amount };
}

function objectPayload(value) {
  return isPlainObject(value) ? value : { value };
}

function isPlainObject(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

async function resolveLegacyImporter(importLegacyData) {
  if (typeof importLegacyData === 'function') {
    return importLegacyData;
  }

  const module = await import('../importers/legacyImport.js');

  if (typeof module.importLegacyData !== 'function') {
    throw {
      status: 500,
      code: 'IMPORTER_NOT_FOUND',
      message: 'Legacy importer does not export importLegacyData.',
    };
  }

  return module.importLegacyData;
}

function normalizeError(error) {
  if (error?.type === 'entity.parse.failed') {
    return {
      status: 400,
      code: 'INVALID_JSON',
      message: 'Request body must be valid JSON.',
      details: error.message,
    };
  }

  const status = normalizeStatus(error?.status ?? error?.statusCode, error);
  const code = error?.code ?? statusCodeToErrorCode(status);
  const message = error?.message ?? 'Internal server error.';
  const details = error?.details ?? error?.errors;

  return { status, code, message, details };
}

function normalizeStatus(status, error = null) {
  const numericStatus = Number(status);
  if (Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599) {
    return numericStatus;
  }

  if (error instanceof RangeError || error instanceof TypeError) {
    return 400;
  }

  const message = String(error?.message ?? '').toLowerCase();
  if (message.includes('limit exceeded')) {
    return 429;
  }

  if (message.includes('not found')) {
    return 404;
  }

  if (
    message.includes('required') ||
    message.includes('unsupported') ||
    message.includes('must be') ||
    message.includes('cannot be') ||
    message.includes('insufficient')
  ) {
    return 400;
  }

  return 500;
}

function statusCodeToErrorCode(status) {
  if (status === 400) {
    return 'BAD_REQUEST';
  }

  if (status === 404) {
    return 'NOT_FOUND';
  }

  return 'INTERNAL_ERROR';
}
