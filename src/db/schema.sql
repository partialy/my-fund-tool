PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  initial_cash_cents INTEGER NOT NULL DEFAULT 0,
  cash_available_cents INTEGER NOT NULL DEFAULT 0,
  cash_frozen_cents INTEGER NOT NULL DEFAULT 0,
  daily_decision_limit INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  occurred_at TEXT NOT NULL,
  occurred_on TEXT NOT NULL,
  type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out', 'set')),
  amount_cents INTEGER NOT NULL,
  balance_before_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  cash_available_after_cents INTEGER NOT NULL,
  cash_frozen_after_cents INTEGER NOT NULL,
  related_type TEXT,
  related_id TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (type IN (
    'deposit',
    'withdraw',
    'correction',
    'buy_order',
    'sell_settlement',
    'import',
    'fee',
    'refund'
  ))
);

CREATE INDEX IF NOT EXISTS idx_cash_ledger_account_time
  ON cash_ledger(account_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS trading_calendar (
  trade_date TEXT PRIMARY KEY,
  is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS funds (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  company TEXT,
  manager TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fund_navs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fund_code TEXT NOT NULL REFERENCES funds(code) ON DELETE CASCADE,
  nav_date TEXT NOT NULL,
  nav_int INTEGER NOT NULL,
  accumulated_nav_int INTEGER,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (fund_code, nav_date)
);

CREATE INDEX IF NOT EXISTS idx_fund_navs_fund_date
  ON fund_navs(fund_code, nav_date DESC);

CREATE TABLE IF NOT EXISTS market_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  name TEXT,
  market_type TEXT NOT NULL DEFAULT 'index',
  fund_code TEXT REFERENCES funds(code) ON DELETE SET NULL,
  quote_date TEXT NOT NULL,
  quote_time TEXT NOT NULL DEFAULT '',
  quote_type TEXT NOT NULL DEFAULT 'estimate',
  price_int INTEGER,
  nav_int INTEGER,
  change_ppm INTEGER,
  source TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (symbol, quote_date, quote_time, quote_type)
);

CREATE INDEX IF NOT EXISTS idx_market_quotes_symbol_date
  ON market_quotes(symbol, quote_date DESC, quote_time DESC);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  decision_date TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  action TEXT NOT NULL,
  fund_code TEXT REFERENCES funds(code) ON DELETE SET NULL,
  amount_cents INTEGER,
  shares_int INTEGER,
  nav_int INTEGER,
  reason TEXT,
  confidence INTEGER,
  counts_daily INTEGER NOT NULL DEFAULT 1 CHECK (counts_daily IN (0, 1)),
  daily_sequence INTEGER,
  status TEXT NOT NULL DEFAULT 'recorded',
  order_no TEXT,
  legacy_path TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_decisions_account_date
  ON decisions(account_id, decision_date, id);

CREATE TABLE IF NOT EXISTS orders (
  order_no TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  fund_code TEXT NOT NULL REFERENCES funds(code) ON DELETE RESTRICT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status TEXT NOT NULL DEFAULT 'submitted',
  amount_cents INTEGER,
  shares_int INTEGER,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  submitted_at TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  confirm_date TEXT,
  settle_date TEXT,
  nav_int INTEGER,
  confirmed_shares_int INTEGER,
  settled_amount_cents INTEGER,
  cost_basis_cents INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_account_created
  ON orders(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders(status, trade_date);

CREATE TABLE IF NOT EXISTS positions (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  fund_code TEXT NOT NULL REFERENCES funds(code) ON DELETE RESTRICT,
  shares_int INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  avg_cost_nav_int INTEGER,
  last_nav_int INTEGER,
  last_nav_date TEXT,
  market_value_cents INTEGER NOT NULL DEFAULT 0,
  realized_pnl_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, fund_code)
);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_date TEXT NOT NULL,
  cash_available_cents INTEGER NOT NULL,
  cash_frozen_cents INTEGER NOT NULL,
  positions_market_value_cents INTEGER NOT NULL,
  total_assets_cents INTEGER NOT NULL,
  daily_pnl_cents INTEGER,
  accumulated_pnl_cents INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (account_id, snapshot_date)
);

CREATE TABLE IF NOT EXISTS snapshot_positions (
  snapshot_id INTEGER NOT NULL REFERENCES account_snapshots(id) ON DELETE CASCADE,
  fund_code TEXT NOT NULL REFERENCES funds(code) ON DELETE RESTRICT,
  shares_int INTEGER NOT NULL,
  cost_cents INTEGER NOT NULL,
  nav_int INTEGER,
  market_value_cents INTEGER NOT NULL,
  unrealized_pnl_cents INTEGER NOT NULL,
  PRIMARY KEY (snapshot_id, fund_code)
);

CREATE TABLE IF NOT EXISTS pnl_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  fund_code TEXT REFERENCES funds(code) ON DELETE SET NULL,
  entry_date TEXT NOT NULL,
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  basis_cents INTEGER,
  related_order_no TEXT REFERENCES orders(order_no) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pnl_entries_account_date
  ON pnl_entries(account_id, entry_date DESC, id DESC);

CREATE TABLE IF NOT EXISTS data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_type TEXT,
  url TEXT,
  fetched_at TEXT,
  raw_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS source_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER REFERENCES data_sources(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  ref_path TEXT,
  quote TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_refs_entity
  ON source_refs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS ai_analysis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  model TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  content TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_runs_created
  ON ai_analysis_runs(created_at DESC, id DESC);
