# LuxConsign · 二手奢侈品寄卖鉴定与争议退款服务

基于 **Node.js + Fastify + PostgreSQL** 的 0-1 工程。覆盖卖家寄售 → 仓库签收 → 鉴定（双人/复鉴）→ 运营报价 → 上架（商城/直播/拍卖）→ 买家下单 → 平台发货 → 签收验收/售后 → 争议多方协查 → 裁决退款赔付/商品处置/黑名单的完整链路，所有资金与处置都可追溯到鉴定记录与交付证据。

## 原始需求

> 开发二手奢侈品寄卖鉴定与争议退款服务，可采用 Node.js、Fastify 和 PostgreSQL。卖家寄送包、表、首饰或鞋服时，服务记录品牌、型号、购买凭证、附件、瑕疵照片、期望价和寄送物流。仓库签收后，鉴定师按序列号、五金、皮质、走线、机芯、票据和历史案例给出真假结论与成色等级；运营根据鉴定结论、市场成交价、平台佣金和卖家底价生成寄卖报价。商品上架后，买家下单、平台发货、签收验收和售后期限都绑定同一寄卖单。若鉴定结果被卖家质疑、买家认为成色不符、物流途中损坏、附件缺失、平台复鉴推翻初鉴或买家退回后商品状态变化，服务要把卖家、鉴定师、仓库、客服、买家和财务放在同一争议中处理。最终退款、赔付、佣金、商品退回和黑名单规则要能追溯到鉴定和交付证据。服务还要管理平台质检标准、鉴定师绩效、保险保价、仓储费、直播带货和买家收货视频。高价值商品在每次入库、出库、拍摄、发货和退回时都要重新确认状态，防止争议时证据链断裂。对于腕表、珠宝和限量包，服务要支持更高等级的双人鉴定、保险箱交接和拍卖渠道转单。卖家撤回或买家退货时，仓库必须重新确认保价和物流责任。

## 核心设计

- **一张寄卖单贯穿全生命周期**：`consignments.status` 驱动 drafted → shipped → received → authenticated → quoted → listed → sold → shipping → aftersales → completed，以及假品退回、争议、撤回、退货、转拍卖、销毁等分支。
- **append-only 证据时间线** `consignment_events`：每次状态流转留痕（操作人、前后状态、证据 URI、载荷），不可篡改。
- **高价值商品状态复核** `status_confirmations`：入库 / 拍摄 / 出库 / 发货 / 退回 / 保险箱交接每个节点强制重新确认状态；发货前若缺少复核记录，订单发货接口直接拦截（HTTP 422）。
- **鉴定** `authentications`：记录序列号、五金、皮质、走线、机芯、票据、历史案例 7 个维度 + 成色 N/S/A/B/C；腕表/珠宝/限量包/保价≥10 万强制**双人鉴定**；争议中可发起**复鉴**，结论变化自动标记 `overturned`（推翻初鉴）。
- **复鉴推翻闭环** `reauth_reviews / brand_audits / brand_knowledge / notifications`：平台复鉴发现真伪或成色误判时自动 ①锁定商品（`consignments.locked`，禁止销售/上架/撤回/再复鉴）②已售订单**暂停结算**（`orders.settlement_paused`，售后到期也不放款）③建立复鉴案件并关联争议，自动比对记录两次鉴定的真伪/成色/七维差异、初鉴结论快照与影响订单 ④通知卖家、买家、初鉴鉴定师；已售商品买家在案件内选择「全额退款退货」或「保留商品并索赔」，初鉴人提交复盘意见 ⑤责任复盘（初鉴失误/流程缺陷/证据不足/无责），初鉴失误计入鉴定师绩效；关联争议未裁决前不得结案解锁 ⑥自动抽查同品牌近 90 天初鉴记录（`brand_audits`），异常发现可沉淀进**品牌鉴定知识库**（`brand_knowledge`），复鉴弹窗会引用同品牌知识要点，降低同类误判复发。
- **多方同一争议** `disputes`：立案时自动归集卖家、买家、主/第二鉴定师、仓库、客服、财务为相关方，并自动抓取历轮鉴定、各节点状态复核、买家收货视频作为证据。8 类争议：卖家质疑鉴定、买家成色不符、物流损坏、附件缺失、复鉴推翻、退回状态变化、撤回/退货保价物流异议。
- **裁决可追溯**：退款、赔付、平台让佣、保险理赔、商品退回/销毁、黑名单一次裁决完成；每笔写入 `financial_ledger` 且 `evidence_ref` 引用争议编号（如 `dispute:D-AB12CD`）。
- **担保交易**：买家付款先托管，签收 + 售后保护期（默认 7 天，`AFTERSALES_DAYS` 可配置）满后才允许完结放款；**售后截止前调用完结接口返回 409，订单、寄卖单状态与资金流水均不变**；退货验收状态不符会自动立案并冻结退款。
- **买家退回状态变化结构化复核** `return_inspections`：买家申请退货后，仓库按 ①划痕/成色 ②附件（应退 vs 实到）③吊牌 ④防拆扣 四项逐项核对，并**必录开箱视频与仓库经办人**。任一项变差即 `orders.refund_frozen` 冻结退款、在同一争议单立案，仓库平台证据（开箱视频/照片）固定入案；买家在同一争议中提交解释与证据照片，**与平台证据并列保存**。**防拆扣被拆除单独记录其对退款的影响**（脱离防调换保护、从严认定）。客服在同一争议里做责任认定（买家/平台/物流/卖家/无责）与退款影响（全额/部分扣除/拒绝），争议裁决时解冻并按裁决金额入账，部分退款的扣除额回写复核单。
- **运营管理**：质检标准（N/S/A/B/C × 品类）、鉴定师绩效（鉴定量/双人率/被推翻次数）、保险保价与理赔、仓储费、直播场次、财务台账、黑名单审计。

## 技术栈与目录

```
Dockerfile              多阶段构建，非 root 用户运行，内置 HEALTHCHECK
docker-compose.yml      app + postgres；仅发布 app 端口，数据库仅内网
.env.example            环境变量样例
src/
  server.js             Fastify 入口、健康检查、静态托管、启动建表+种子
  seed.js               12 个角色账号 + 质检标准 + 2 条演示寄卖单
  db/schema.sql         全部表结构（幂等 CREATE IF NOT EXISTS）
  db/pool.js            pg 连接池 + 事务封装
  lib.js                证据时间线/开争议/财务入账等领域逻辑
  routes/               auth / consignments / authentications / quotes / orders / disputes / admin
public/index.html       单页浏览器演示控制台（无需构建，原生 JS）
```

## 快速开始（宿主 docker compose 一键部署）

```bash
# 1) 准备环境变量（可选，验证环境会注入 CC_PUBLISH_PORT）
cp .env.example .env

# 2) 构建并启动（app + PostgreSQL）
docker compose up -d --build

# 3) 查看健康状态
docker compose ps
curl -s http://localhost:${CC_PUBLISH_PORT:-3071}/health
# {"ok":true,"db":"up"}
```

浏览器打开 **http://localhost:3071**（端口以 `CC_PUBLISH_PORT` 为准）即为演示控制台，左侧点击账号卡片自动填充登录。

> 验证取端口方式：`docker compose port app 3000`，再通过 `host.docker.internal:<映射端口>` 访问。数据库不发布宿主端口，app 通过服务名 `db` 内网访问。

停止与清理：

```bash
docker compose down          # 停止
docker compose down -v       # 同时清空数据库卷
```

## 演示账号（逐角色）

| 角色 | 用户名 | 密码 | 权限 / 典型操作 |
|---|---|---|---|
| 平台管理员 | `admin` | `admin123` | 全部权限、质检标准、黑名单、看板 |
| 卖家 | `seller_alice` | `alice123` | 创建寄卖、交运、回复报价、撤回、质疑鉴定（名下已有在售 Chanel 包 C-1001） |
| 卖家 | `seller_bob` | `bob123` | 名下高价值劳力士迪通拿 C-2002（已签收，待双人鉴定+保险箱） |
| 买家 | `buyer_cara` | `cara123` | 浏览在售、下单、签收上传收货视频、退货、发起成色/物流/附件争议 |
| 买家 | `buyer_dan` | `dan123` | 第二个买家账号 |
| 鉴定师（腕表） | `auth_evan` | `evan123` | 主鉴/复鉴，可被选为第二鉴定师 |
| 鉴定师（箱包珠宝） | `auth_fiona` | `fiona123` | C-1001 初鉴人 |
| 复鉴员 | `auth_gale` | `gale123` | 争议复鉴、可推翻初鉴 |
| 仓库主管 | `wh_grace` | `grace123` | 签收+入库复核、状态复核、保险箱交接、发货、退货验收 |
| 运营 | `ops_henry` | `henry123` | 报价、上架（商城/直播）、转拍卖、发货、代开争议 |
| 客服 | `cs_iris` | `iris123` | 受理争议、协查、裁决（退款/赔付/让佣/处置/黑名单） |
| 财务 | `fin_jack` | `jack123` | 报价试算、保险保价/理赔、仓储费、退款、台账、参与裁决 |

## 预置演示数据

- **C-1001 Chanel Classic Flap 中号**（卖家 Alice）：已完成初鉴（正品/成色 S）、报价（市价 6.1 万 / 佣金 12% / 售价 5.8 万 / 卖家到手 50,720）、卖家接受、**已上架在售**，保价 6.5 万。买家可直接下单走完整交易。
- **C-2002 Rolex Daytona 116500LN**（卖家 Bob）：保价 22 万的高价值限量腕表，已签收入库（含双人开箱视频），**待双人鉴定**，可演示保险箱交接、双人鉴定、拍卖转单。
- 质检标准 4 套（包/表/珠宝/鞋服），直播场次 1 个。

## 推荐演示流程（浏览器点选即可）

1. **买家 buyer_cara 登录** → C-1001 下单（货款托管）。
2. **仓库 wh_grace** → 订单发货（普通件可直接发；高价值件会被强制要求先做出库复核，可在寄卖单「登记状态复核」处补录）。
3. **买家** → 签收验收并上传收货视频（7 天售后期开始）→ 可「确认完成」看担保放款，或「申请退货」。
4. **双人鉴定主线**：用 `auth_evan` 打开 C-2002 → 提交鉴定时必须选择第二鉴定师（否则 422 拦截）→ 仓库做保险箱交接（双人签字）→ 运营报价 → 上架或转苏富比拍卖。
5. **争议主线（核心）**：用买家对订单发起「成色不符」争议 → 客服 `cs_iris` 受理 → 鉴定师 `auth_gale` 在案件内「发起复鉴」并给出相反结论（自动标记推翻初鉴）→ 多方在协查线程举证 → 客服/财务裁决：填退款/赔付/让佣/保险理赔、选择商品处置（退回卖家/买家保留/重新上架/销毁）、可把责任方加入黑名单 → 查看案件内「裁决资金流水」，每笔都带 `dispute:xxxx` 证据引用。
6. **退回状态变化**：买家退货 → 仓库验收时选「与出库状态不一致」→ 系统自动立案、冻结退款。
7. **撤回保价重核**：卖家撤回寄卖时选择对保价/物流责任「有异议」→ 直接进入争议；无异议则必须登记退回物流，系统自动重核保价并写退回复核。
8. **运营管理页**：看板、质检标准编辑、鉴定师绩效（含被复鉴推翻次数）、保险保价/理赔、仓储费、直播、财务台账、黑名单。

## 主要 API 速览

| 模块 | 方法与路径 |
|---|---|
| 认证 | `POST /api/auth/login` `GET /api/auth/me` |
| 寄卖 | `GET/POST /api/consignments`、`/ship` `/receive` `/confirm` `/vault-handover` `/list` `/auction-transfer` `/withdraw` `/return-complete` `/disputes` |
| 鉴定 | `POST /api/consignments/:id/authenticate`、`GET /api/authenticators/performance` |
| 报价 | `POST /api/consignments/:id/quote/preview` `/quote`、`POST .../quote/:qid/respond`、`POST /storage-bill` |
| 订单 | `POST /api/consignments/:id/order`、`POST /api/orders/:id/ship|receive|complete|return-request|return-receive|refund` |
| 争议 | `GET /api/disputes`、`POST /disputes/:id/messages|investigate|resolve` |
| 管理 | `/api/dashboard` `/api/users` `/api/quality-standards` `/api/consignments/:id/insurance` `/api/live-sessions` `/api/ledger` |

鉴权：除 `/health` 与登录外均需 `Authorization: Bearer <JWT>`。接口按角色与交易归属鉴权（卖家只能操作自己的寄卖单，买家只能操作自己的订单，争议仅相关方可见）。

## 验证方式

本工程以「**宿主机 `docker compose up -d` 健康检查通过 + 关键业务流接口走通**」为验收标准：

```bash
docker compose up -d --build
docker compose ps          # app/healthy, db/healthy
curl -s $(docker compose port app 3000 | sed 's/^/http:\/\/host.docker.internal:/')/health
```

随后可按上文「推荐演示流程」在浏览器中走通寄卖→鉴定→报价→交易→争议裁决全链路；每次裁决后在争议详情与「财务台账」中核对带争议编号的资金流水。
