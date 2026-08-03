import express from 'express';
import { DEFAULT_ACCOUNT_CODE } from '../services/ledgerService.js';

const PAGE_METHODS = {
  dashboard: ['getDashboardViewModel', 'getDashboard', 'getDashboardSummary', 'getToday'],
  account: ['getAccountViewModel', 'getAccount', 'getAccountSummary'],
  operations: ['getOperationsViewModel', 'getOperations', 'listOperations', 'listOrders'],
  pnl: ['getPnlViewModel', 'getPnl', 'listPnl', 'listPnlEntries', 'getProfitAndLoss'],
  action: ['getActionViewModel', 'getAction', 'getActionDetail', 'getDecisionDetail'],
  admin: ['getAdminViewModel'],
};

export function createPagesRouter({ ledger, adminAnalysis } = {}) {
  const router = express.Router();

  router.get('/', pageHandler({
    ledger,
    view: 'dashboard',
    title: '总览',
    active: 'dashboard',
    methods: PAGE_METHODS.dashboard,
  }));

  router.get('/account', pageHandler({
    ledger,
    view: 'account',
    title: '账户',
    active: 'account',
    methods: PAGE_METHODS.account,
  }));

  router.get('/operations', pageHandler({
    ledger,
    view: 'operations',
    title: '操作记录',
    active: 'operations',
    methods: PAGE_METHODS.operations,
  }));

  router.get('/pnl', pageHandler({
    ledger,
    view: 'pnl',
    title: '盈亏',
    active: 'pnl',
    methods: PAGE_METHODS.pnl,
  }));

  router.get('/admin', pageHandler({
    ledger: adminAnalysis,
    view: 'admin',
    title: '管理后台',
    active: 'admin',
    methods: PAGE_METHODS.admin,
    useDefaultAccount: false,
  }));

  router.get('/actions/:id', pageHandler({
    ledger,
    view: 'action',
    title: '操作详情',
    active: 'actions',
    methods: PAGE_METHODS.action,
    getPayload: (request) => ({ ...request.query, id: request.params.id }),
  }));

  router.use((request, response) => {
    response.status(404).type('html').send(renderFallbackPage({
      title: '未找到页面',
      active: '',
      data: {
        method: request.method,
        path: request.originalUrl,
      },
    }));
  });

  router.use((error, _request, response, _next) => {
    const status = normalizeStatus(error?.status ?? error?.statusCode);
    response.status(status).type('html').send(renderFallbackPage({
      title: '应用异常',
      active: '',
      data: {
        code: error?.code ?? 'INTERNAL_ERROR',
        message: error?.message ?? '服务器内部错误。',
        details: error?.details ?? error?.errors,
      },
    }));
  });

  return router;
}

function pageHandler({
  ledger,
  view,
  title,
  active,
  methods,
  getPayload = defaultPayload,
  useDefaultAccount = true,
}) {
  return async (request, response, next) => {
    try {
      const payload = useDefaultAccount
        ? withDefaultPageAccount(getPayload(request))
        : getPayload(request);
      const data = await loadPageData(ledger, methods, payload);
      const model = {
        title,
        active,
        data,
        query: useDefaultAccount ? withDefaultPageAccount(request.query) : request.query,
        params: request.params
      };
      renderPage(response, view, model, next);
    } catch (error) {
      next(error);
    }
  };
}

async function loadPageData(ledger, methods, payload) {
  if (!ledger) {
    return {};
  }

  const name = methods.find((candidate) => typeof ledger[candidate] === 'function');
  if (!name) {
    return {};
  }

  return ledger[name](payload);
}

function defaultPayload(request) {
  return { ...request.query };
}

function withDefaultPageAccount(payload = {}) {
  const normalized = { ...payload };
  const hasAccount = [
    'accountCode',
    'account_code',
    'account',
    'accountId',
    'account_id'
  ].some((key) => normalized[key] !== undefined && normalized[key] !== null && normalized[key] !== '');

  if (!hasAccount) {
    normalized.accountCode = DEFAULT_ACCOUNT_CODE;
  }

  return normalized;
}

function renderPage(response, view, model, next) {
  response.render(view, model, (error, html) => {
    if (!error) {
      response.send(html);
      return;
    }

    if (isMissingViewError(error)) {
      response.type('html').send(renderFallbackPage(model));
      return;
    }

    next(error);
  });
}

function isMissingViewError(error) {
  return error?.message?.includes('Failed to lookup view');
}

function renderFallbackPage({ title, active, data }) {
  const escapedTitle = escapeHtml(title);
  const escapedActive = escapeHtml(active);
  const escapedData = escapeHtml(JSON.stringify(data ?? {}, null, 2));

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedTitle}</title>
</head>
<body data-active="${escapedActive}">
  <main>
    <h1>${escapedTitle}</h1>
    <pre>${escapedData}</pre>
  </main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeStatus(status) {
  const numericStatus = Number(status);
  if (Number.isInteger(numericStatus) && numericStatus >= 400 && numericStatus <= 599) {
    return numericStatus;
  }

  return 500;
}
