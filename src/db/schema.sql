-- ============================================================================
-- 二手奢侈品寄卖鉴定与争议退款服务 · 数据库结构
-- 设计要点：
--   1) consignment_events 为 append-only 证据时间线，任何状态流转都落一条
--   2) status_confirmations 记录高价值商品每次入库/出库/拍摄/发货/退回状态复核
--   3) authentications 支持初鉴 / 双人鉴定 / 复鉴（可推翻初鉴）
--   4) disputes 把卖家、鉴定师、仓库、客服、买家、财务拉进同一案件
--   5) financial_ledger 每一笔退款/赔付/佣金都带证据引用，可追溯鉴定与交付
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------- 用户与角色 ----------
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN
                    ('seller','buyer','authenticator','warehouse','ops','cs','finance','admin')),
  specialty       TEXT,                      -- 鉴定师专长：watch / jewelry / bag / fashion
  blacklisted     BOOLEAN NOT NULL DEFAULT FALSE,
  blacklist_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 平台质检标准 ----------
CREATE TABLE IF NOT EXISTS quality_standards (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  category     TEXT NOT NULL,                -- bag/watch/jewelry/fashion
  name         TEXT NOT NULL,
  grade_rules  JSONB NOT NULL,               -- {N:[...], S:[...], A:[...], B:[...], C:[...]}
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by   BIGINT REFERENCES users(id),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 寄卖单（贯穿寄卖-鉴定-报价-上架-成交-交付-售后-争议） ----------
CREATE TABLE IF NOT EXISTS consignments (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  seller_id        BIGINT NOT NULL REFERENCES users(id),
  category         TEXT NOT NULL CHECK (category IN ('bag','watch','jewelry','fashion')),
  brand            TEXT NOT NULL,
  model            TEXT NOT NULL,
  serial_no        TEXT,
  limited_edition  BOOLEAN NOT NULL DEFAULT FALSE,
  purchase_proof   TEXT,                     -- 购买凭证（证据引用 / 说明）
  accessories      JSONB NOT NULL DEFAULT '[]',   -- 附件清单 ["保卡","表盒","票据"]
  flaw_photos      JSONB NOT NULL DEFAULT '[]',   -- 瑕疵照片证据引用
  item_description TEXT,
  expected_price   NUMERIC(12,2),            -- 卖家期望价
  reserve_price    NUMERIC(12,2),            -- 卖家底价（报价环节确认）

  -- 保价 / 仓储 / 保险箱
  declared_value   NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 保价金额
  high_value       BOOLEAN NOT NULL DEFAULT FALSE,    -- 达到高价值阈值，强制每次复核
  vault_no         TEXT,
  vault_ready      BOOLEAN NOT NULL DEFAULT FALSE,

  -- 物流
  inbound_carrier  TEXT,
  inbound_tracking TEXT,
  return_carrier   TEXT,
  return_tracking  TEXT,

  -- 鉴定结论（取自终局鉴定，便于列表展示；明细在 authentications）
  authenticity     TEXT CHECK (authenticity IN ('authentic','fake','suspicious')),
  grade            TEXT,                     -- N / S / A / B / C
  dual_auth        BOOLEAN NOT NULL DEFAULT FALSE,    -- 本单是否执行双人鉴定

  -- 报价 / 渠道
  sale_price       NUMERIC(12,2),            -- 上架价
  channel          TEXT DEFAULT 'shop' CHECK (channel IN ('shop','live','auction')),
  live_session_id  BIGINT,
  listed_at        TIMESTAMPTZ,

  status           TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN (
                     'drafted','shipped','received','authenticating',
                     'authenticated','rejected_fake','quoted','listed',
                     'sold','shipping','delivered','aftersales','completed',
                     'disputed','withdrawn','returning_seller','returned_seller',
                     'buyer_returning','return_received','auction_transferred','destroyed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consignment_seller ON consignments(seller_id);
CREATE INDEX IF NOT EXISTS idx_consignment_status ON consignments(status);

-- ---------- 寄卖事件时间线（append-only 证据链） ----------
CREATE TABLE IF NOT EXISTS consignment_events (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  actor_id        BIGINT REFERENCES users(id),
  actor_role      TEXT,
  type            TEXT NOT NULL,             -- created/shipped/received/authenticated/...
  from_status     TEXT,
  to_status       TEXT,
  note            TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]',  -- ["photo://...","video://...","doc://..."]
  payload         JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_event_consignment ON consignment_events(consignment_id, created_at);

-- ---------- 高价值商品状态复核 ----------
CREATE TABLE IF NOT EXISTS status_confirmations (
  id               BIGSERIAL PRIMARY KEY,
  consignment_id   BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  checkpoint       TEXT NOT NULL CHECK (checkpoint IN
                     ('inbound','photoshoot','outbound','shipping','return','vault_handover')),
  confirmer_id     BIGINT NOT NULL REFERENCES users(id),
  condition_summary TEXT NOT NULL,
  photos           JSONB NOT NULL DEFAULT '[]',
  video_url        TEXT,
  matches_previous BOOLEAN NOT NULL DEFAULT TRUE,
  discrepancies    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_confirm_consignment ON status_confirmations(consignment_id);

-- ---------- 鉴定记录（初鉴 / 双人 / 复鉴） ----------
CREATE TABLE IF NOT EXISTS authentications (
  id                     BIGSERIAL PRIMARY KEY,
  consignment_id         BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  round                  INT NOT NULL DEFAULT 1,   -- 1=初鉴 2=复鉴 ...
  is_final               BOOLEAN NOT NULL DEFAULT FALSE,
  primary_authenticator  BIGINT NOT NULL REFERENCES users(id),
  second_authenticator   BIGINT REFERENCES users(id),  -- 双人鉴定
  result                 TEXT NOT NULL CHECK (result IN ('authentic','fake','suspicious')),
  grade                  TEXT CHECK (grade IN ('N','S','A','B','C')),
  serial_check           TEXT,
  hardware_check         TEXT,   -- 五金
  leather_check          TEXT,   -- 皮质
  stitching_check        TEXT,   -- 走线
  movement_check         TEXT,   -- 机芯（腕表）
  receipt_check          TEXT,   -- 票据
  case_history           TEXT,   -- 历史案例
  summary                TEXT,
  evidence               JSONB NOT NULL DEFAULT '[]',
  overturned             BOOLEAN NOT NULL DEFAULT FALSE,  -- 复鉴推翻初鉴
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_consignment ON authentications(consignment_id);

-- ---------- 寄卖报价 ----------
CREATE TABLE IF NOT EXISTS quotes (
  id               BIGSERIAL PRIMARY KEY,
  consignment_id   BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  market_price     NUMERIC(12,2) NOT NULL,   -- 市场成交价参考
  commission_rate  NUMERIC(5,4) NOT NULL,    -- 平台佣金费率
  storage_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  insurance_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  reserve_price    NUMERIC(12,2) NOT NULL,
  sale_price       NUMERIC(12,2) NOT NULL,   -- 建议上架价
  seller_proceeds  NUMERIC(12,2) NOT NULL,   -- 预计卖家到手
  quote_note       TEXT,
  created_by       BIGINT NOT NULL REFERENCES users(id),
  seller_accepted  BOOLEAN,
  seller_reply     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 上架渠道（商城 / 直播 / 拍卖） ----------
CREATE TABLE IF NOT EXISTS live_sessions (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  host        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','live','ended')),
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auction_transfers (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  auction_house   TEXT NOT NULL,
  estimate_min    NUMERIC(12,2) NOT NULL,
  estimate_max    NUMERIC(12,2) NOT NULL,
  reserve_price   NUMERIC(12,2) NOT NULL,
  status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','approved','transferred','withdrawn')),
  note            TEXT,
  created_by      BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 订单 / 物流 / 签收 / 售后 ----------
CREATE TABLE IF NOT EXISTS orders (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  consignment_id   BIGINT NOT NULL REFERENCES consignments(id),
  buyer_id         BIGINT NOT NULL REFERENCES users(id),
  amount           NUMERIC(12,2) NOT NULL,
  commission_rate  NUMERIC(5,4) NOT NULL DEFAULT 0,   -- 成交时佣金快照
  platform_fee     NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 平台佣金金额
  seller_proceeds  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 应结卖家款
  status           TEXT NOT NULL DEFAULT 'placed'
                     CHECK (status IN ('placed','shipping','delivered','completed','refunded','returned')),
  outbound_carrier TEXT,
  outbound_tracking TEXT,
  receiving_video_url TEXT,                  -- 买家收货视频
  delivered_at     TIMESTAMPTZ,
  aftersales_until TIMESTAMPTZ,              -- 售后期限
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_buyer ON orders(buyer_id);

-- ---------- 保险保价 ----------
CREATE TABLE IF NOT EXISTS insurance_policies (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  declared_value  NUMERIC(12,2) NOT NULL,
  premium         NUMERIC(12,2) NOT NULL,
  coverage_stage  TEXT NOT NULL DEFAULT 'all' CHECK (coverage_stage IN ('inbound','warehouse','outbound','return','all')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','claimed','settled','cancelled')),
  claim_amount    NUMERIC(12,2),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 仓储费 ----------
CREATE TABLE IF NOT EXISTS storage_fee_bills (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  days            INT NOT NULL,
  daily_rate      NUMERIC(12,2) NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  billed_by       BIGINT NOT NULL REFERENCES users(id),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 保险箱交接 ----------
CREATE TABLE IF NOT EXISTS vault_handovers (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  vault_no        TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
  from_user_id    BIGINT REFERENCES users(id),
  to_user_id      BIGINT REFERENCES users(id),
  condition_note  TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]',
  dual_signoff    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- 争议案件（多方同案） ----------
CREATE TABLE IF NOT EXISTS disputes (
  id               BIGSERIAL PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  consignment_id   BIGINT NOT NULL REFERENCES consignments(id),
  order_id         BIGINT REFERENCES orders(id),
  type             TEXT NOT NULL CHECK (type IN (
                     'seller_challenge_auth',   -- 卖家质疑鉴定
                     'buyer_grade_dispute',     -- 买家认为成色不符
                     'transit_damage',          -- 物流途中损坏
                     'accessory_missing',       -- 附件缺失
                     'reauth_overturn',         -- 复鉴推翻初鉴
                     'return_condition_change', -- 退回后商品状态变化
                     'withdraw_logistics',      -- 撤回时保价/物流责任
                     'return_logistics'         -- 退货时保价/物流责任
                   )),
  status           TEXT NOT NULL DEFAULT 'opened'
                     CHECK (status IN ('opened','investigating','resolved','closed')),
  opened_by        BIGINT NOT NULL REFERENCES users(id),
  parties          JSONB NOT NULL DEFAULT '[]',  -- [{userId, role, name}]
  summary          TEXT NOT NULL,
  linked_auth_id   BIGINT REFERENCES authentications(id),
  linked_evidence  JSONB NOT NULL DEFAULT '[]',  -- 引用的鉴定/复核/交付证据
  -- 裁决结果
  refund_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 退买家
  compensation_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 赔卖家/买家
  commission_adjust    NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 佣金调整（平台让佣）
  insurance_claim      NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 保险理赔
  item_disposition     TEXT CHECK (item_disposition IN
                        ('return_seller','keep_buyer','resell','destroy')),
  blacklist_party_id   BIGINT REFERENCES users(id),
  ruling               TEXT,
  resolved_by          BIGINT REFERENCES users(id),
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispute_consignment ON disputes(consignment_id);

CREATE TABLE IF NOT EXISTS dispute_messages (
  id          BIGSERIAL PRIMARY KEY,
  dispute_id  BIGINT NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  author_id   BIGINT NOT NULL REFERENCES users(id),
  author_role TEXT NOT NULL,
  content     TEXT NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_msg_dispute ON dispute_messages(dispute_id, created_at);

-- ---------- 财务流水（最终退款/赔付/佣金/费用，全部带证据引用） ----------
CREATE TABLE IF NOT EXISTS financial_ledger (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT REFERENCES consignments(id),
  order_id        BIGINT REFERENCES orders(id),
  dispute_id      BIGINT REFERENCES disputes(id),
  account         TEXT NOT NULL CHECK (account IN
                    ('buyer','seller','platform','insurance','warehouse','auction')),
  entry_type      TEXT NOT NULL CHECK (entry_type IN
                    ('payment','sale_proceeds','commission','storage_fee','insurance_premium',
                     'insurance_claim','refund','compensation','commission_refund',
                     'return_shipping','auction_proceeds',
                     'offer_deposit','deposit_refund','return_logistics_fee')),
  direction       TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount          NUMERIC(12,2) NOT NULL,
  evidence_ref    TEXT,                       -- 证据引用（争议编号/鉴定轮次/复核记录）
  created_by      BIGINT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_consignment ON financial_ledger(consignment_id);
CREATE INDEX IF NOT EXISTS idx_ledger_dispute ON financial_ledger(dispute_id);

-- ---------- 黑名单审计 ----------
CREATE TABLE IF NOT EXISTS blacklist_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  reason      TEXT NOT NULL,
  dispute_id  BIGINT REFERENCES disputes(id),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  BIGINT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- 复鉴推翻初鉴闭环：商品锁定 / 暂停结算 / 复鉴案件 / 通知 / 品牌抽查 / 品牌知识库
-- ============================================================================

-- 幂等加列（已存在则跳过）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='consignments' AND column_name='locked') THEN
    ALTER TABLE consignments ADD COLUMN locked BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='consignments' AND column_name='lock_reason') THEN
    ALTER TABLE consignments ADD COLUMN lock_reason TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='settlement_paused') THEN
    ALTER TABLE orders ADD COLUMN settlement_paused BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='settlement_pause_reason') THEN
    ALTER TABLE orders ADD COLUMN settlement_pause_reason TEXT;
  END IF;
END $$;

-- ---------- 站内通知（买家/卖家/鉴定师/仓库/财务） ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'system',   -- reauth / dispute / order / finance / system
  link_type   TEXT,                              -- consignment / order / dispute / reauth_review
  link_id     BIGINT,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

-- ---------- 复鉴推翻案件 ----------
CREATE TABLE IF NOT EXISTS reauth_reviews (
  id                     BIGSERIAL PRIMARY KEY,
  code                   TEXT UNIQUE NOT NULL,
  consignment_id         BIGINT NOT NULL REFERENCES consignments(id),
  order_id               BIGINT REFERENCES orders(id),
  dispute_id             BIGINT REFERENCES disputes(id),
  initial_auth_id        BIGINT NOT NULL REFERENCES authentications(id),
  reauth_id              BIGINT NOT NULL REFERENCES authentications(id),
  brand                  TEXT NOT NULL,
  authenticity_changed   BOOLEAN NOT NULL DEFAULT FALSE,  -- 真伪结论是否变化
  grade_changed          BOOLEAN NOT NULL DEFAULT FALSE,  -- 成色等级是否变化
  initial_authenticator BIGINT NOT NULL REFERENCES users(id),
  reauthenticator       BIGINT NOT NULL REFERENCES users(id),
  initial_summary       TEXT,                              -- 初鉴结论快照
  reauth_summary        TEXT,                              -- 复鉴结论快照
  difference_detail     TEXT NOT NULL,                     -- 两次鉴定差异（自动生成）
  authenticator_opinion TEXT,                              -- 初鉴鉴定师说明/复盘意见
  opinion_at            TIMESTAMPTZ,
  -- 已售出时买家的选择
  buyer_choice          TEXT CHECK (buyer_choice IN ('refund','keep_with_compensation','pending')),
  buyer_choice_note     TEXT,
  buyer_decided_at      TIMESTAMPTZ,
  -- 责任复盘
  responsibility        TEXT CHECK (responsibility IN ('initial_error','process_gap','evidence_insufficient','no_fault')),
  responsibility_detail TEXT,
  reviewer_id           BIGINT REFERENCES users(id),
  reviewed_at           TIMESTAMPTZ,
  status                TEXT NOT NULL DEFAULT 'opened'
                          CHECK (status IN ('opened','awaiting_buyer','responsibility_reviewed','closed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reauth_consignment ON reauth_reviews(consignment_id);
CREATE INDEX IF NOT EXISTS idx_reauth_initial_auth ON reauth_reviews(initial_authenticator);

-- ---------- 同品牌近期鉴定抽查 ----------
CREATE TABLE IF NOT EXISTS brand_audits (
  id                BIGSERIAL PRIMARY KEY,
  code              TEXT UNIQUE NOT NULL,
  brand             TEXT NOT NULL,
  category          TEXT,
  triggered_by_reauth_id BIGINT REFERENCES reauth_reviews(id),
  consignment_id    BIGINT REFERENCES consignments(id),
  authenticator_id  BIGINT REFERENCES users(id),
  initial_auth_id   BIGINT REFERENCES authentications(id),
  reviewer_id       BIGINT REFERENCES users(id),
  result            TEXT CHECK (result IN ('consistent','mismatch','uncertain')),
  finding           TEXT,
  promoted_kb       BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否已沉淀进品牌知识库
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','audited')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  audited_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_brand_audit_brand ON brand_audits(brand, status);

-- ---------- 品牌鉴定知识库 ----------
CREATE TABLE IF NOT EXISTS brand_knowledge (
  id            BIGSERIAL PRIMARY KEY,
  brand         TEXT NOT NULL,
  category      TEXT,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  key_points    JSONB NOT NULL DEFAULT '[]',   -- 鉴定要点
  source_audit_id BIGINT REFERENCES brand_audits(id),
  updated_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (brand, title)
);
CREATE INDEX IF NOT EXISTS idx_kb_brand ON brand_knowledge(brand);

-- ============================================================================
-- 买家退回状态变化：结构化退回复核（划痕/附件/吊牌/防拆扣 + 开箱视频 + 经办人）
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='refund_frozen') THEN
    ALTER TABLE orders ADD COLUMN refund_frozen BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='refund_freeze_reason') THEN
    ALTER TABLE orders ADD COLUMN refund_freeze_reason TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS return_inspections (
  id                    BIGSERIAL PRIMARY KEY,
  order_id              BIGINT NOT NULL REFERENCES orders(id),
  consignment_id        BIGINT NOT NULL REFERENCES consignments(id),
  dispute_id            BIGINT REFERENCES disputes(id),

  -- 仓库经办人 + 开箱视频（必录）
  warehouse_user_id     BIGINT NOT NULL REFERENCES users(id),
  open_box_video        TEXT,
  warehouse_note        TEXT,

  -- 四项核对（与出库状态复核/买家收货证据比对）
  scratch_status        TEXT NOT NULL CHECK (scratch_status IN ('consistent','new_scratch','worse')),
  scratch_detail        TEXT,
  accessories_status    TEXT NOT NULL CHECK (accessories_status IN ('all_present','missing','swapped','damaged')),
  accessories_expected  JSONB NOT NULL DEFAULT '[]',   -- 应退附件（取自寄卖单）
  accessories_found     JSONB NOT NULL DEFAULT '[]',   -- 实到附件
  accessories_detail    TEXT,
  tag_status            TEXT NOT NULL CHECK (tag_status IN ('intact','missing','damaged')),
  tamper_seal_status    TEXT NOT NULL CHECK (tamper_seal_status IN ('intact','removed','damaged')),
  tamper_seal_detail    TEXT,

  -- 平台证据（仓库）
  platform_photos       JSONB NOT NULL DEFAULT '[]',

  -- 买家解释（与平台证据并列保存）
  buyer_explanation     TEXT,
  buyer_evidence        JSONB NOT NULL DEFAULT '[]',
  buyer_explained_at    TIMESTAMPTZ,
  buyer_user_id         BIGINT REFERENCES users(id),

  -- 结论与退款影响
  result                TEXT NOT NULL CHECK (result IN ('consistent','changed')),
  -- 防拆扣被拆除对退款的单独影响
  tamper_seal_impact    TEXT,
  -- 裁决：退款影响与赔付责任
  refund_impact         TEXT CHECK (refund_impact IN ('full_refund','partial_refund','refund_denied')),
  refund_impact_detail  TEXT,
  deduct_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,  -- 部分退款时扣除（买家承担）
  responsibility        TEXT CHECK (responsibility IN ('buyer','platform','logistics','seller','none')),
  responsibility_detail TEXT,
  reviewed_by           BIGINT REFERENCES users(id),
  reviewed_at           TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_insp_order ON return_inspections(order_id);
CREATE INDEX IF NOT EXISTS idx_return_insp_dispute ON return_inspections(dispute_id);

-- 订单新增“退货中”状态：买家申请退货后订单与寄卖单同步为 returning / buyer_returning
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_returning_check') THEN
    ALTER TABLE orders DROP CONSTRAINT orders_status_check;
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN ('placed','shipping','delivered','returning','completed','refunded','returned'));
  END IF;
END $$;

-- ============================================================================
-- 卖家底价/降价调整与撤回：收藏、议价(保证金)、活动报名、降价记录、撤回结算
-- ============================================================================

-- ---------- 买家收藏 ----------
CREATE TABLE IF NOT EXISTS favorites (
  id              BIGSERIAL PRIMARY KEY,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  user_id         BIGINT NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (consignment_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_con ON favorites(consignment_id);

-- ---------- 买家议价（可缴纳保证金） ----------
CREATE TABLE IF NOT EXISTS offers (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  buyer_id        BIGINT NOT NULL REFERENCES users(id),
  offer_amount    NUMERIC(12,2) NOT NULL,
  deposit_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','accepted','rejected','expired','released_for_withdraw','converted')),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_offer_con ON offers(consignment_id, status);

-- ---------- 活动报名 ----------
CREATE TABLE IF NOT EXISTS promotions (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,
  title           TEXT NOT NULL,
  promo_type      TEXT NOT NULL DEFAULT 'campaign',
  starts_at       TIMESTAMPTZ,
  ends_at         TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS promo_enrollments (
  id              BIGSERIAL PRIMARY KEY,
  promotion_id    BIGINT NOT NULL REFERENCES promotions(id),
  consignment_id  BIGINT NOT NULL REFERENCES consignments(id) ON DELETE CASCADE,
  enrolled_by     BIGINT NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL DEFAULT 'enrolled'
                    CHECK (status IN ('enrolled','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (promotion_id, consignment_id)
);
CREATE INDEX IF NOT EXISTS idx_enroll_con ON promo_enrollments(consignment_id);

-- ---------- 卖家降价记录 ----------
CREATE TABLE IF NOT EXISTS price_adjustments (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT UNIQUE NOT NULL,
  consignment_id      BIGINT NOT NULL REFERENCES consignments(id),
  old_reserve_price   NUMERIC(12,2) NOT NULL,
  new_reserve_price   NUMERIC(12,2) NOT NULL,
  old_sale_price      NUMERIC(12,2) NOT NULL,
  new_sale_price      NUMERIC(12,2) NOT NULL,
  commission_rate     NUMERIC(5,4) NOT NULL,
  est_commission      NUMERIC(12,2) NOT NULL,
  est_seller_proceeds NUMERIC(12,2) NOT NULL,
  favorite_count      INTEGER NOT NULL DEFAULT 0,
  active_offer_count  INTEGER NOT NULL DEFAULT 0,
  enrollment_count    INTEGER NOT NULL DEFAULT 0,
  storage_fee_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  insurance_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason              TEXT,
  confirmed_by        BIGINT REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_padj_con ON price_adjustments(consignment_id);

-- ---------- 卖家撤回记录（保留卖家确认 + 客服说明） ----------
CREATE TABLE IF NOT EXISTS seller_withdrawals (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT UNIQUE NOT NULL,
  consignment_id      BIGINT NOT NULL REFERENCES consignments(id),
  reason              TEXT,
  -- 撤回物流费用
  return_carrier      TEXT,
  return_tracking     TEXT,
  return_logistics_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  storage_fee_total   NUMERIC(12,2) NOT NULL DEFAULT 0,
  insurance_fee_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- 受影响买家
  notified_offer_count INTEGER NOT NULL DEFAULT 0,
  released_deposit_total NUMERIC(12,2) NOT NULL DEFAULT 0,
  favorite_count      INTEGER NOT NULL DEFAULT 0,
  enrollment_count    INTEGER NOT NULL DEFAULT 0,
  -- 卖家确认
  seller_confirmed    BOOLEAN NOT NULL DEFAULT FALSE,
  seller_confirmation TEXT,
  confirmed_by        BIGINT REFERENCES users(id),
  confirmed_at        TIMESTAMPTZ,
  -- 客服说明
  cs_note             TEXT,
  cs_user_id          BIGINT REFERENCES users(id),
  status              TEXT NOT NULL DEFAULT 'requested'
                        CHECK (status IN ('requested','confirmed','cancelled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_withdraw_con ON seller_withdrawals(consignment_id);

-- ---------- 卖家结算单（仓储/保险/物流拆开显示） ----------
CREATE TABLE IF NOT EXISTS seller_settlements (
  id                  BIGSERIAL PRIMARY KEY,
  code                TEXT UNIQUE NOT NULL,
  consignment_id      BIGINT NOT NULL REFERENCES consignments(id),
  withdrawal_id       BIGINT REFERENCES seller_withdrawals(id),
  seller_id           BIGINT NOT NULL REFERENCES users(id),
  storage_fee         NUMERIC(12,2) NOT NULL DEFAULT 0,
  insurance_fee       NUMERIC(12,2) NOT NULL DEFAULT 0,
  return_logistics_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  other_fee           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_deduction     NUMERIC(12,2) NOT NULL DEFAULT 0,
  deposit_released    NUMERIC(12,2) NOT NULL DEFAULT 0,
  detail_note         TEXT,
  status              TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','settled')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_settle_con ON seller_settlements(consignment_id);

-- 幂等扩展 financial_ledger 科目枚举（议价保证金/保证金释放/退回物流费）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='financial_ledger_entry_type_check')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='financial_ledger_entry_type_check_v2') THEN
    ALTER TABLE financial_ledger DROP CONSTRAINT financial_ledger_entry_type_check;
    ALTER TABLE financial_ledger ADD CONSTRAINT financial_ledger_entry_type_check
      CHECK (entry_type IN ('payment','sale_proceeds','commission','storage_fee','insurance_premium',
        'insurance_claim','refund','compensation','commission_refund','return_shipping',
        'auction_proceeds','offer_deposit','deposit_refund','return_logistics_fee'));
  END IF;
END $$;
