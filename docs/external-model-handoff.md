# 外部模型交接协议

本文档用于把基金模拟游戏交给无法直接访问本地接口的外部模型参与决策。外部模型负责提出“需要哪些本地账本数据”和“想执行什么决策”，也可以自行联网搜索公开行情和候选基金；Codex 负责调用本地接口、必要时联网复核或代取行情、计算交易结果、写入账本并验证。

## 角色分工

- 用户：在外部模型和 Codex 之间转发 JSON。
- 外部模型：根据本文档填写数据需求清单，收到数据后给出决策命令 JSON；也可以自行联网搜索公开基金和行情数据，独立选择候选基金。
- Codex：读取本地 API 和真实市场数据，按固定格式返回数据；收到决策命令后代为计算、校验、写入和复核。
- 本地工具：Node + Express + SQLite 基金模拟账本，服务器地址 `http://192.168.9.18:53999`。

## 游戏规则

- 当前 Codex 账户代码和名称均为 `account-codex`。
- 账本归属类 API 必须显式传 `accountCode` 或 `accountId`；缺少账户参数必须报错。
- 页面入口可不带账户参数打开，首屏默认展示 `account-codex`，后续导航、分页和明细请求会继续带当前账户。
- 数据查询、行情搜索、资料复核、页面/API 读取都可以多次执行，不计入操作次数。
- 只有真实基金操作计入“基金操作次数”：`buy`、`sell`、`switch`、`cancel_order`。`hold`、净值更新、订单确认、卖出到账、资产快照、纯数据整理和现金调整默认不计数。
- 每日 3 次是建议的基金操作节奏，用于提醒不要过度交易；工具不做硬性次数限制，超过 3 次仍允许记录和执行。
- 15:00 或以前提交的买入、卖出、转换，申请交易日为当日，按当日净值确认。
- 15:00 后提交的买入、卖出、转换，申请交易日顺延到下一交易日，按下一交易日净值确认。
- 买入 T+1 确认份额。
- 卖出 T+1 确认并在 T+1 的 15:00 后到账。
- 转换默认拆成“卖出原基金 + 买入目标基金”，先卖出确认到账，再按可用资金买入目标基金。
- 成交、确认、盈亏、快照必须使用真实披露净值；盘中估值和指数走势只能辅助决策。
- 市场数据优先级：基金公司或披露净值页优先，其次天天基金/东方财富，其次新浪财经等公开数据源。
- 外部模型可以自行联网搜索其他基金，选择任意可公开核验的公募基金，不限制在 Codex、DeepSeek、豆包或其他账户已投资基金里；也可以继续空仓或只观察。
- 公开行情、候选基金、费率、规模、风格、历史净值等信息，外部模型优先自行搜索并在理由中说明来源；只有确实无法访问或需要 Codex 复核时，才通过数据需求清单请求 Codex 代取。
- 本游戏虽是模拟，但使用真实基金盘数据和真实交易规则记录账本。每次买入、卖出、转换或撤单前，都必须谨慎核对数据日期、来源、15:00 规则、T+1 规则和风控约束；没有明确优势时允许 `hold`。
- 状态为 `submitted` 的未确认订单可以在确认前撤回，撤回接口为 `POST /api/orders/:orderNo/cancel`；状态为 `confirmed`、`settled` 或 `cancelled` 的订单不能撤回。撤回不会删除原下单操作次数，撤回本身作为基金操作默认也计数。
- 默认手续费为 0；如果外部模型明确要求按真实费率，必须说明费率来源，Codex 再判断是否可用。
- 风控限制：单只基金买入后市值不超过总资产 50%；单次买入金额不超过总资产 30%；账户总收益率低于 -10% 时下一次只能减仓、转换到低风险基金或空仓观察；单基金收益率低于 -8% 时必须说明继续持有、减仓或转换理由。

## 总流程

1. 用户把本文档发给外部模型。
2. 外部模型按 `fund-sim.data-request.v1` 给出数据需求清单。
3. 用户把数据需求清单转发给 Codex。
4. Codex 按清单调用本地 API、必要时联网查真实市场数据，并返回 `fund-sim.data-response.v1`。
5. 用户把数据响应转发给外部模型。
6. 外部模型基于数据响应给出 `fund-sim.operation-command.v1` 决策命令。
7. 用户把决策命令转发给 Codex。
8. Codex 校验、计算、执行、写入账本，并返回 `fund-sim.execution-report.v1`。

所有 JSON 都应放在固定标记之间，便于复制和解析。

```text
BEGIN_FUND_SIM_JSON
{
  "schema": "fund-sim.example.v1"
}
END_FUND_SIM_JSON
```

## 数据需求清单格式

外部模型需要数据时，只能填写下面这个 JSON，不要写自然语言清单。

```json
{
  "schema": "fund-sim.data-request.v1",
  "requestId": "ext-20260731-001",
  "requester": "external-model-name",
  "accountCode": "account-codex",
  "asOf": "2026-07-31 14:30:00 +08:00",
  "purpose": "daily_decision",
  "dataItems": [
    {
      "key": "runtime.clock",
      "required": true,
      "params": {},
      "reason": "确认当前时间、是否接近 15:00"
    },
    {
      "key": "account.balance",
      "required": true,
      "params": {},
      "reason": "判断可用现金和总资产"
    }
  ],
  "notes": "只请求本次决策真正需要的数据"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | 是 | 固定为 `fund-sim.data-request.v1` |
| `requestId` | 是 | 外部模型生成的请求编号，后续响应和决策必须引用 |
| `requester` | 否 | 外部模型名称或备注 |
| `accountCode` | 是 | 默认填 `account-codex`；必须显式填写 |
| `asOf` | 是 | 外部模型发起请求时的北京时间 |
| `purpose` | 是 | `daily_decision`、`nav_settlement`、`review`、`candidate_research`、`custom` |
| `dataItems` | 是 | 数据项目数组 |
| `notes` | 否 | 补充要求 |

`dataItems` 每项格式：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `key` | 是 | 数据项目代码，见下方目录 |
| `required` | 是 | `true` 表示缺少该数据时应阻止决策；`false` 表示可选 |
| `params` | 否 | 该数据项目的参数 |
| `reason` | 否 | 为什么需要这项数据 |

## 可请求数据项目

| key | 数据来源 | 常用参数 | 说明 |
| --- | --- | --- | --- |
| `runtime.clock` | Codex 本地时间 | 无 | 当前北京时间、日期、是否 15:00 前后 |
| `trade.calendar` | Codex 判断/联网核对 | `date`、`lookAheadDays` | 是否交易日、T+1 日期、下一交易日 |
| `trading.today` | 本地 API | `date` | 今日基金操作次数、建议操作次数和是否硬限制 |
| `account.summary` | 本地 API | 无 | 账户总览，含余额、持仓、快照 |
| `account.balance` | 本地 API | 无 | 可用现金、冻结现金、总现金、持仓摘要 |
| `account.cashLedger` | 本地 API | `page`、`pageSize` | 现金流水 |
| `account.snapshots` | 本地 API | `page`、`pageSize` | 资产快照 |
| `portfolio.positions` | 本地 API | `page`、`pageSize` | 当前持仓 |
| `portfolio.positionHistory` | 本地 API | `fundCodes`、`pageSize` | 持有基金每日净值、涨跌幅、盈亏 |
| `orders.open` | 本地 API | 无 | 待确认、待到账订单 |
| `orders.recent` | 本地 API | `page`、`pageSize` | 最近订单 |
| `decisions.today` | 本地 API | `date` | 今日决策记录 |
| `decisions.recent` | 本地 API | `page`、`pageSize` | 最近决策 |
| `pnl.summary` | 本地 API | 无 | 累计盈亏、今日盈亏、收益率摘要 |
| `pnl.entries` | 本地 API | `page`、`pageSize` | 盈亏日志 |
| `fund.nav.latest` | 本地 API + 互联网 | `fundCodes` | 指定基金最新披露净值 |
| `fund.nav.history` | 本地 API + 互联网 | `fundCodes`、`startDate`、`endDate`、`days` | 指定基金历史净值 |
| `market.indexQuotes` | 互联网 + 本地记录 | `symbols`、`quoteType` | 指数盘中或收盘行情 |
| `market.fundEstimates` | 互联网 | `fundCodes`、`quoteType` | 基金盘中估值，仅辅助 |
| `fund.research` | 互联网 | `fundCodes`、`topics` | 基金费率、跟踪指数、风格、规模等 |
| `fund.discovery` | 互联网 | `keywords`、`categories`、`riskStyle`、`limit` | 当外部模型无法自行搜索时，请 Codex 代找候选基金 |
| `risk.limits` | 本文档 + 本地账本 | 无 | 建议操作节奏、仓位、回撤、单基金亏损等约束 |

推荐的日内决策请求：

```text
BEGIN_FUND_SIM_JSON
{
  "schema": "fund-sim.data-request.v1",
  "requestId": "ext-20260731-1430-001",
  "requester": "external-model",
  "accountCode": "account-codex",
  "asOf": "2026-07-31 14:30:00 +08:00",
  "purpose": "daily_decision",
  "dataItems": [
    { "key": "runtime.clock", "required": true, "params": {}, "reason": "判断 15:00 规则" },
    { "key": "trade.calendar", "required": true, "params": { "lookAheadDays": 5 }, "reason": "确认 T+1" },
    { "key": "trading.today", "required": true, "params": { "date": "2026-07-31" }, "reason": "查看今日基金操作次数和建议节奏" },
    { "key": "account.balance", "required": true, "params": {}, "reason": "确认现金和总资产" },
    { "key": "portfolio.positions", "required": true, "params": { "page": 1, "pageSize": 100 }, "reason": "确认当前持仓" },
    { "key": "orders.open", "required": true, "params": {}, "reason": "先处理待确认和待到账订单" },
    { "key": "decisions.today", "required": true, "params": { "date": "2026-07-31" }, "reason": "复核今日操作记录，避免无意义频繁交易" },
    { "key": "pnl.summary", "required": true, "params": {}, "reason": "检查收益率和风控" },
    { "key": "fund.nav.latest", "required": true, "params": { "fundCodes": ["007466", "006087"] }, "reason": "核对持仓最新披露净值" },
    { "key": "market.indexQuotes", "required": false, "params": { "symbols": ["000001", "399001", "399006", "000300", "000905"], "quoteType": "intraday" }, "reason": "辅助判断市场环境" },
    { "key": "market.fundEstimates", "required": false, "params": { "fundCodes": ["007466", "006087"], "quoteType": "intraday" }, "reason": "辅助判断盘中波动" },
    { "key": "risk.limits", "required": true, "params": {}, "reason": "执行风控约束" }
  ],
  "notes": "只需要能支持本次是否操作的关键数据"
}
END_FUND_SIM_JSON
```

推荐的收盘后净值/确认请求：

```text
BEGIN_FUND_SIM_JSON
{
  "schema": "fund-sim.data-request.v1",
  "requestId": "ext-20260731-close-001",
  "requester": "external-model",
  "accountCode": "account-codex",
  "asOf": "2026-07-31 21:00:00 +08:00",
  "purpose": "nav_settlement",
  "dataItems": [
    { "key": "runtime.clock", "required": true, "params": {}, "reason": "确认已收盘" },
    { "key": "trade.calendar", "required": true, "params": { "lookAheadDays": 5 }, "reason": "确认 T+1 日期" },
    { "key": "orders.open", "required": true, "params": {}, "reason": "查找需确认或到账订单" },
    { "key": "portfolio.positions", "required": true, "params": { "page": 1, "pageSize": 100 }, "reason": "确认需更新净值的持仓" },
    { "key": "fund.nav.latest", "required": true, "params": { "fundCodes": ["007466", "006087"] }, "reason": "写入最新披露净值" },
    { "key": "account.snapshots", "required": false, "params": { "page": 1, "pageSize": 5 }, "reason": "对比快照" }
  ],
  "notes": "只处理净值、确认、到账和快照；不计入每日决策"
}
END_FUND_SIM_JSON
```

## Codex 数据响应格式

Codex 必须按下面格式返回数据，用户原样转给外部模型。

```json
{
  "schema": "fund-sim.data-response.v1",
  "requestId": "ext-20260731-1430-001",
  "generatedAt": "2026-07-31 14:31:12 +08:00",
  "accountCode": "account-codex",
  "asOf": "2026-07-31 14:31:12 +08:00",
  "status": "ok",
  "dataItems": [
    {
      "key": "account.balance",
      "status": "ok",
      "source": "local_api",
      "fetchedAt": "2026-07-31 14:31:12 +08:00",
      "data": {}
    }
  ],
  "derived": {
    "fundOperationCountToday": 0,
    "suggestedFundOperationsPerDay": 3,
    "limitEnforced": false,
    "positionRatio": null,
    "riskFlags": []
  },
  "warnings": [],
  "missing": [],
  "instructionsForDecision": [
    "如果要交易，请返回 fund-sim.operation-command.v1。",
    "数据可以多次查询，不计入基金操作次数。",
    "不需要计算份额、交易日、确认日和到账日，Codex 会代算。"
  ]
}
```

`status` 取值：

- `ok`：请求的必要数据都已返回。
- `partial`：部分可选数据缺失，必要数据完整。
- `blocked`：必要数据缺失，不建议外部模型下决策。

`dataItems[].status` 取值：

- `ok`：成功获取。
- `partial`：有数据但不完整。
- `missing`：无法获取。
- `not_requested`：清单未请求，通常不出现在响应中。

Codex 返回响应时应使用固定包裹：

```text
BEGIN_FUND_SIM_JSON
{
  "schema": "fund-sim.data-response.v1"
}
END_FUND_SIM_JSON
```

## 决策命令格式

外部模型做完判断后，必须返回 `fund-sim.operation-command.v1`。外部模型只表达意图，不要伪造本地接口结果；份额、交易日、确认日、到账日、盈亏、快照由 Codex 计算和写入。

```json
{
  "schema": "fund-sim.operation-command.v1",
  "commandId": "cmd-20260731-1435-001",
  "basedOnRequestId": "ext-20260731-1430-001",
  "accountCode": "account-codex",
  "decidedAt": "2026-07-31 14:35:00 +08:00",
  "decision": {
    "action": "hold",
    "countsDaily": false,
    "reason": "市场波动较大，当前仓位和风险收益比不支持加仓。",
    "confidence": "medium",
    "nextSuggestedAt": "2026-07-31 21:00:00 +08:00"
  },
  "orders": [],
  "cashAdjustments": [],
  "navUpdates": [],
  "executionConstraints": {
    "allowPartialExecution": false,
    "skipIfDataStaleAfterMinutes": 20,
    "maxSpend": null,
    "minCashReserve": "0.00",
    "requireNoOpenBlockingOrders": true
  },
  "assumptions": [],
  "notes": "如果 Codex 发现数据已过期，应重新拉取并提示用户。"
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `schema` | 是 | 固定为 `fund-sim.operation-command.v1` |
| `commandId` | 是 | 外部模型生成的命令编号 |
| `basedOnRequestId` | 是 | 对应的数据需求请求编号 |
| `accountCode` | 是 | 必须显式填写，默认 `account-codex` |
| `decidedAt` | 是 | 外部模型给出决策的北京时间 |
| `decision.action` | 是 | `hold`、`buy`、`sell`、`switch`、`cancel_order`、`update_only`、`cash_adjustment` |
| `decision.countsDaily` | 是 | 只有 `buy`、`sell`、`switch`、`cancel_order` 这类基金操作计数；`hold` 和纯数据/账务整理默认不计数，即使传 `true` 也不应作为基金操作次数 |
| `decision.reason` | 是 | 决策理由 |
| `decision.confidence` | 否 | `low`、`medium`、`high` |
| `decision.nextSuggestedAt` | 否 | 建议下一次执行时间 |
| `orders` | 是 | 买入、卖出、转换、撤回订单意图数组；不操作填空数组 |
| `cashAdjustments` | 否 | 增加/减少/修正现金余额 |
| `navUpdates` | 否 | 外部模型要求写入的官方净值；通常由 Codex 获取 |
| `executionConstraints` | 否 | 执行约束 |
| `assumptions` | 否 | 外部模型基于哪些假设 |
| `notes` | 否 | 补充说明 |

## 订单意图格式

买入：

```json
{
  "type": "buy",
  "fundCode": "006087",
  "fundName": "华泰柏瑞中证500ETF联接C",
  "amount": "1000.00",
  "fee": "0.00",
  "reason": "中证500阶段性修复，仓位仍低于上限。"
}
```

卖出：

```json
{
  "type": "sell",
  "fundCode": "007466",
  "fundName": "华泰柏瑞中证红利低波ETF联接A",
  "shares": "100.0000",
  "sellRatio": null,
  "sellAll": false,
  "fee": "0.00",
  "reason": "触发单基金风控，降低暴露。"
}
```

转换：

```json
{
  "type": "switch",
  "fromFundCode": "007466",
  "fromFundName": "华泰柏瑞中证红利低波ETF联接A",
  "sellShares": "100.0000",
  "sellRatio": null,
  "sellAll": false,
  "toFundCode": "006087",
  "toFundName": "华泰柏瑞中证500ETF联接C",
  "buyAmountMode": "after_sell_settlement",
  "reason": "从低波红利切向中证500弹性。"
}
```

撤回未确认订单：

```json
{
  "type": "cancel_order",
  "orderNo": "account-doubao-ORD-20260803-0001",
  "reason": "确认前发现原数据不足或风险收益比变化，撤回未确认买入。"
}
```

撤回只适用于 `submitted` 状态订单。买入撤回后会退回已扣减现金；卖出撤回只改变订单状态。撤回不会抹掉原下单操作次数；如本次撤回属于新的基金操作，应让 `decision.countsDaily=true`。

现金调整：

```json
{
  "type": "deposit",
  "amount": "1000.00",
  "occurredAt": "2026-07-31 14:35:00 +08:00",
  "reason": "用户新增模拟现金"
}
```

`cashAdjustments[].type` 可填：

- `deposit`：增加现金。
- `withdraw`：减少现金。
- `correction`：修正为目标余额；此时 `amount` 表示目标余额。

官方净值写入：

```json
{
  "fundCode": "006087",
  "fundName": "华泰柏瑞中证500ETF联接C",
  "navDate": "2026-07-31",
  "nav": "1.1234",
  "accumulatedNav": "1.1234",
  "source": "东方财富基金历史净值"
}
```

## 执行规则

Codex 收到 `operation-command` 后必须执行以下步骤：

1. 校验 JSON schema、`accountCode`、`commandId`、`basedOnRequestId`。
2. 重新读取当前时间、账户余额、持仓、待处理订单、今日基金操作次数。
3. 如果 `skipIfDataStaleAfterMinutes` 已触发，重新拉取必要数据或停止执行。
4. 先处理账务事项：官方净值写入、订单确认、卖出到账、资产快照。
5. 如命令要求撤回未确认订单，先核对订单账户和 `submitted` 状态；如果撤回本身属于基金操作，先写入 `/api/decisions` 记录 `cancel_order`，再调用 `/api/orders/:orderNo/cancel`。
6. 再处理外部模型的其他基金操作或观察决策。
7. 校验现金、份额、建议操作节奏、单基金 50%、单次 30%、亏损风控；每日 3 次只是建议，不作为写入拦截条件。
8. 按 15:00 规则计算申请交易日。
9. 写入 `/api/decisions`。
10. 如需交易，写入 `/api/orders`；买入使用金额，卖出使用份额。
11. 如需现金调整，写入 `/api/account/cash-adjustments`。
12. 写入后重新 GET 余额、持仓、订单、决策、盈亏或页面，确认结果。
13. 返回 `fund-sim.execution-report.v1`。

如果命令里存在风险或数据不足，Codex 应停止写入并返回 `blocked` 报告，不要猜测执行。

## 执行报告格式

Codex 执行后返回：

```json
{
  "schema": "fund-sim.execution-report.v1",
  "commandId": "cmd-20260731-1435-001",
  "basedOnRequestId": "ext-20260731-1430-001",
  "accountCode": "account-codex",
  "executedAt": "2026-07-31 14:36:10 +08:00",
  "status": "executed",
  "countedDecision": {
    "countsDaily": false,
    "decisionNo": "20260731-002",
    "fundOperationCountToday": 2,
    "suggestedFundOperationsPerDay": 3,
    "limitEnforced": false
  },
  "writes": [
    {
      "endpoint": "POST /api/decisions",
      "status": "ok",
      "id": 12,
      "summary": "记录观察决策"
    }
  ],
  "calculations": {
    "tradeDate": null,
    "confirmDate": null,
    "settleDate": null,
    "cashChange": "0.00",
    "estimatedPositionRatioAfterOrder": null
  },
  "before": {},
  "after": {},
  "verification": [
    {
      "endpoint": "GET /api/account/balance?accountCode=account-codex",
      "status": "ok"
    }
  ],
  "warnings": [],
  "nextSuggestedAt": "2026-07-31 21:00:00 +08:00"
}
```

`status` 取值：

- `executed`：已按命令写入账本。
- `noop`：命令为纯观察或无可写入内容。
- `blocked`：因数据不足、风控、格式错误或账户不匹配停止。
- `partial`：只执行了允许的部分；仅当 `allowPartialExecution=true` 时可出现。

## 外部模型注意事项

- 不要声称已经调用接口；外部模型没有接口权限。
- 不要伪造本地账本字段、订单编号、确认份额、到账金额。
- 不要自行假设今日基金操作次数，必须从数据响应读取；3 次只是建议节奏，不是硬上限。
- 不要要求超过可用现金、可卖份额或风控上限的交易。
- 可以自行联网搜索候选基金并独立判断，不必跟随其他模型已买基金，也不必为了交易而交易。
- 如自行搜索公开数据不足，再在数据需求清单中请求 `fund.discovery`、`fund.research` 或 `fund.nav.history`，由 Codex 代取或复核。
- 决策必须按真实盘模拟的谨慎口径给出，明确数据日期、核心依据和主要风险。
- 如果不确定，优先返回 `hold` 或请求更多数据。
- 决策理由必须能被写入日志，避免只有“看涨/看跌”这种不可复核的短句。

## Codex 常用接口映射

所有账本归属接口都必须带 `accountCode=account-codex`。

```http
GET /api/health
GET /api/today?accountCode=account-codex&date=YYYY-MM-DD
GET /api/account/balance?accountCode=account-codex
GET /api/positions?accountCode=account-codex&page=1&pageSize=100
GET /api/positions/:fundCode/history?accountCode=account-codex&page=1&pageSize=20
GET /api/orders?accountCode=account-codex&page=1&pageSize=100
GET /api/decisions?accountCode=account-codex&page=1&pageSize=100
GET /api/pnl?accountCode=account-codex&page=1&pageSize=100
GET /api/account/cash-ledger?accountCode=account-codex&page=1&pageSize=100
GET /api/account/snapshots?accountCode=account-codex&page=1&pageSize=100
POST /api/account/cash-adjustments
POST /api/market/funds/:code/nav
POST /api/market/quotes
POST /api/decisions
POST /api/orders
POST /api/orders/:orderNo/confirm
POST /api/orders/:orderNo/cancel
POST /api/orders/:orderNo/settle
POST /api/valuation/snapshot
```

写入类接口 JSON body 中也必须包含：

```json
{
  "accountCode": "account-codex"
}
```

行情类接口 `/api/market/funds/:code/nav` 和 `/api/market/quotes` 是全局市场数据，不按账户隔离；但如果本次写入是为某账户执行，执行报告仍应注明对应 `accountCode`。
