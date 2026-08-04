# 基金实盘模拟工具

本地 Node + Express + SQLite 小工具，用来替代手工维护 HTML/MD 账本。

## 启动

```bash
pnpm install
pnpm db:init
pnpm import:legacy
pnpm dev
```

默认地址：`http://127.0.0.1:53999`

服务默认监听 `0.0.0.0:53999`，可通过 `HOST` / `PORT` 环境变量覆盖。

DeepSeek AI 分析需要配置 `DEEPSEEK_API_KEY`。未配置时 `/admin` 仍可查看所有账户数据，但不能生成新的 AI 分析。

## 服务器部署

当前宝塔服务器部署目录：`/www/wwwroot/node-service/fund-sim-tool`

PM2 应用名：`fund-sim-tool`

PM2 运行用户：`root`

开机自启服务：`pm2-root.service`

服务器 Git 代理：`http://192.168.9.100:10809`

常用命令：

```bash
/www/server/nodejs/v22.22.3/bin/pm2 status fund-sim-tool
/www/server/nodejs/v22.22.3/bin/pm2 restart fund-sim-tool --update-env
/www/server/nodejs/v22.22.3/bin/pm2 logs fund-sim-tool --lines 50
systemctl status pm2-root.service
git config --global http.proxy http://192.168.9.100:10809
git config --global https.proxy http://192.168.9.100:10809
```

## 核心接口

- `GET /api/today?date=YYYY-MM-DD`
- `GET /api/accounts`
- `POST /api/accounts`
- `GET /api/account/balance`
- `GET /api/positions?page=1&pageSize=10`
- `GET /api/positions/:fundCode/history?page=1&pageSize=20`
- `GET /api/orders?page=1&pageSize=10`
- `GET /api/decisions?page=1&pageSize=10`
- `GET /api/pnl?page=1&pageSize=10`
- `GET /api/account/cash-ledger?page=1&pageSize=10`
- `GET /api/account/snapshots?page=1&pageSize=10`
- `POST /api/account/cash-adjustments`
- `POST /api/market/funds/:code/nav`
- `POST /api/market/quotes`
- `POST /api/decisions`
- `POST /api/orders`
- `POST /api/orders/:orderNo/confirm`
- `POST /api/orders/:orderNo/cancel`
- `POST /api/orders/:orderNo/settle`
- `POST /api/valuation/snapshot`
- `GET /api/admin/ai-analysis/latest`
- `POST /api/admin/ai-analysis`
- `POST /api/admin/sql`
- `POST /api/import/legacy`

## 管理后台

后台入口：`/admin`。后台无需登录，按全账户视角展示账户排行、收益、持仓市值、风险控制、操作次数和已有基金关注榜。

AI 分析为手动触发并保存最近结果：点击“生成 AI 分析”后，服务端会汇总本地账本数据，调用 DeepSeek `deepseek-v4-pro`，并把输入快照、提示词、模型输出或错误保存到 `ai_analysis_runs`。AI 只能基于本地账本已有数据分析，缺失行情或样本不足时应说明数据不足；页面会标注“AI 分析仅用于游戏复盘和观察，不作为真实投资建议”。

内网便捷 SQL 接口：`POST /api/admin/sql`，请求体为 `{ "sql": "完整 SQLite SQL;" }`。该接口无登录、无鉴权、无 SQL 白名单，使用 `db.exec(sql)` 原样执行传入 SQL，支持多语句；服务端不自动包事务，需要事务时自行在 SQL 中写 `BEGIN IMMEDIATE; ... COMMIT;`。接口只返回是否执行成功和耗时，不返回 `SELECT` 查询结果。

## 外部模型交接

如果需要让无法访问本地接口的外部模型参与决策，使用 `docs/external-model-handoff.md`。外部模型只填写数据需求清单和决策命令 JSON；Codex 负责取数、联网补行情、计算交易日/份额/盈亏、调用接口写入账本并返回执行报告。

外部模型可以自行联网搜索其他基金并独立决策，不限制在其他模型已买基金里；也可以保持空仓或只观察。公开行情和候选基金数据优先由外部模型自行搜索，只有确实无法访问或需要本地账本/复核时，才让 Codex 按清单代取。虽然是游戏，但账本按真实基金盘数据和真实交易规则模拟，提交前需要谨慎核对；`submitted` 状态订单可在确认前通过 `POST /api/orders/:orderNo/cancel` 撤回。

数据查询、行情搜索、资料复核、页面/API 读取都不限次数，也不计入操作次数。只有 `buy`、`sell`、`switch`、`cancel_order` 这类真实基金操作计入“基金操作次数”；`hold`、净值更新、确认、到账、快照和现金调整默认不计数。每日 3 次只是建议操作节奏，不是硬上限，工具不会因为超过 3 次而拒绝写入。

`/api/today` 中的 `decisionLimit` / `suggestedDecisionLimit` 表示建议操作次数；`limitEnforced=false` 表示服务端不按该值拦截。

## 多账户

多账户模式不做登录和权限。账本归属类接口必须显式传 `accountCode` 或 `accountId`，GET 接口放在 query，POST 接口可放在 JSON body 或 query；缺少账户参数会直接返回错误。页面入口在未传账户时默认展示 Codex 账户。Codex 当前账户代码为 `account-codex`。市场数据接口 `/api/market/funds/:code/nav` 和 `/api/market/quotes` 是全局行情数据，不按账户隔离。

创建账户示例：

```http
POST /api/accounts
Content-Type: application/json

{
  "accountCode": "alt",
  "name": "备用账户",
  "initialCash": "10000.00"
}
```

自动生成订单号会加入账户前缀，例如 `account-codex-ORD-20260731-0001`、`alt-ORD-20260731-0001`。手动指定 `orderNo` 时仍需保证全局唯一。

列表接口默认分页，返回 `{ items, pagination }`，`pageSize` 默认 10，最大 100。页面表格默认展示最新 10 条，并通过分页条手动翻页。

持仓每日明细只对当前持有基金开放，从买入申请交易日开始记录，按资产快照日期关联当日或最近可用基金净值，返回每日净值、涨跌幅、份额、成本、市值、未实现盈亏和收益率。账户页的“持仓明细”表格提供“详情”按钮，可弹窗查看该基金最新 20 条明细。

MVP 中真实行情由 Codex 复核或查询后写入接口；外部模型可以自行联网提供公开数据来源。工具负责账本、交易规则、页面展示和历史迁移，本身不自动抓行情。
