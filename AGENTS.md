# 基金实盘模拟工具上下文

## 项目定位

本项目是 `E:\资料\money\games\fund-sim` 手工 HTML/MD 基金模拟账本的本地工具化版本。

目标是用 Node v22 + Express + SQLite 保存唯一账本，再由页面和接口展示/更新数据。

## 技术栈

- Node v22，使用内置 `node:sqlite`，运行命令需要 `--experimental-sqlite`。
- 包管理器：pnpm。
- 后端：Express。
- 页面：EJS 服务端渲染。
- 数据解析：Cheerio。
- 测试：node:test + Supertest。

## 账本口径

- 金额用整数分存储。
- 基金净值和份额用 `*10000` 的整数存储。
- 初始资金默认 10000.00 元。
- 每日最多 3 次决策，买入、卖出、转换、不操作均计数；单纯净值更新、确认、到账、盈亏快照不计数。
- 15:00 或以前提交交易，申请交易日为当天；15:00 后提交交易，申请交易日为下一个交易日。
- 买入 T+1 确认份额；卖出确认后资金在 T+1 且 15:00 后到账。
- 持仓每日明细只展示当前持有基金；记录从买入申请交易日开始，不为已清仓基金保留前端入口。
- 持仓每日明细基于资产快照日期生成，关联当日或最近可用基金净值，字段包括净值、净值涨跌幅、份额、成本、市值、未实现盈亏和收益率。
- 真实行情仍由 Codex 查询后通过接口写入，本工具 MVP 不自动联网抓行情。

## 分页口径

- 列表接口默认使用 `page` / `pageSize` 分页，返回 `{ items, pagination }`。
- `pageSize` 默认 10，最大 100；页码越界时返回最后一页。
- 已分页接口包括：`/api/positions`、`/api/positions/:fundCode/history`、`/api/orders`、`/api/decisions`、`/api/pnl`、`/api/account/cash-ledger`、`/api/account/snapshots`。
- 页面表格默认显示最新 10 条；操作页的决策、订单、现金流水独立翻页，账户页的现金流水和资产快照独立翻页，盈亏页的盈亏快照独立翻页。
- 账户页“持仓明细”每行有“详情”按钮，请求 `/api/positions/:fundCode/history?page=1&pageSize=20` 后在弹窗展示该基金最近持仓日明细。

## 页面显示口径

- 收益、上涨、盈利等正向数值使用红色；亏损、下跌等负向数值使用绿色，保持真实基金/股票软件常见风格。
- 当前持仓必须显示浮动盈亏收益率，收益率由 `(市值 - 成本) / 成本` 计算。

## 部署口径

- 宝塔服务器部署目录：`/www/wwwroot/node-service/fund-sim-tool`。
- PM2 应用名：`fund-sim-tool`。
- PM2 命令路径：`/www/server/nodejs/v22.22.3/bin/pm2`。
- PM2 开机自启 unit：`pm2-yixi.service`，使用 `pm2 resurrect --no-daemon` 前台模式，避免 systemd 读取用户目录 PID 文件失败。
- 服务启动配置：`ecosystem.config.cjs`。
- 生产数据库路径：`/www/wwwroot/node-service/fund-sim-tool/data/fund-sim.sqlite`。

## 关键目录

- `src/db`：SQLite 连接、初始化、schema。
- `src/lib`：金额/净值/份额转换、交易日与分页工具。
- `src/services`：账本核心业务。
- `src/routes`：API 与页面路由。
- `src/views`：EJS 页面。
- `src/public`：静态样式。
- `src/importers`：旧 HTML/MD 数据迁移。
- `test`：接口、账本和迁移测试。

## 开发命令

```bash
pnpm install
pnpm db:init
pnpm import:legacy
pnpm test
pnpm dev
```

默认服务端口：`53999`；服务默认监听 `0.0.0.0:53999`，可通过 `HOST` / `PORT` 环境变量覆盖。
