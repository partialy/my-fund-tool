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
- `POST /api/orders/:orderNo/settle`
- `POST /api/valuation/snapshot`
- `POST /api/import/legacy`

列表接口默认分页，返回 `{ items, pagination }`，`pageSize` 默认 10，最大 100。页面表格默认展示最新 10 条，并通过分页条手动翻页。

持仓每日明细只对当前持有基金开放，从买入申请交易日开始记录，按资产快照日期关联当日或最近可用基金净值，返回每日净值、涨跌幅、份额、成本、市值、未实现盈亏和收益率。账户页的“持仓明细”表格提供“详情”按钮，可弹窗查看该基金最新 20 条明细。

MVP 中真实行情仍由 Codex 查询后写入接口，工具负责账本、交易规则、页面展示和历史迁移。
