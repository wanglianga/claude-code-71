import { query, tx } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, getOrder,
  latestQuote, genCode, money, ledger, openDispute, notify,
} from '../lib.js';

const AFTERSALES_DAYS = Number(process.env.AFTERSALES_DAYS ?? 7);

async function getOrderWithConsignment(client, orderId) {
  const { rows } = await client.query(
    `SELECT o.*, c.seller_id, c.high_value, c.status AS con_status, c.code AS con_code,
            c.sale_price, c.declared_value
     FROM orders o JOIN consignments c ON c.id=o.consignment_id WHERE o.id=$1`, [orderId]);
  if (!rows[0]) throw new HttpError(404, '订单不存在');
  return rows[0];
}

export default async function orderRoutes(fastify) {
  const auth = [fastify.authenticate];

  fastify.get('/api/orders', { onRequest: auth }, async (req) => {
    if (req.user.role === 'buyer') {
      const { rows } = await query(
        `SELECT o.*, c.brand, c.model, c.code AS consignment_code FROM orders o
         JOIN consignments c ON c.id=o.consignment_id WHERE o.buyer_id=$1 ORDER BY o.id DESC`, [req.user.uid]);
      return { items: rows };
    }
    if (!['admin', 'ops', 'cs', 'finance', 'warehouse'].includes(req.user.role)) throw new HttpError(403, '无权查看订单');
    const { rows } = await query(
      `SELECT o.*, c.brand, c.model, c.code AS consignment_code, u.display_name AS buyer_name
       FROM orders o JOIN consignments c ON c.id=o.consignment_id
       JOIN users u ON u.id=o.buyer_id ORDER BY o.id DESC LIMIT 200`);
    return { items: rows };
  });

  // 买家下单
  fastify.post('/api/consignments/:id/order', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (req.user.role !== 'buyer' && req.user.role !== 'admin') throw new HttpError(403, '仅买家可下单');
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (con.locked) throw new HttpError(409, `商品已被平台锁定（${con.lock_reason || '复鉴/争议处理中'}），暂停销售`);
      if (con.status !== 'listed') throw new HttpError(409, '该商品当前不可购买');
      const dup = await c.query(`SELECT 1 FROM orders WHERE consignment_id=$1 AND buyer_id=$2 AND status<>'refunded'`,
        [id, req.user.uid]);
      if (dup.rowCount) throw new HttpError(409, '您已有该商品的有效订单');
      const quote = await latestQuote(c, id);
      const rate = quote ? Number(quote.commission_rate) : 0.12;
      const amount = money(con.sale_price);
      const fee = money(amount * rate);
      const proceeds = money(amount - fee);
      const code = genCode('O');
      const { rows } = await c.query(
        `INSERT INTO orders (code,consignment_id,buyer_id,amount,commission_rate,platform_fee,seller_proceeds,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'placed') RETURNING *`,
        [code, id, req.user.uid, amount, rate, fee, proceeds]);
      await c.query(`UPDATE consignments SET status='sold', updated_at=now() WHERE id=$1`, [id]);
      await ledger(c, { consignmentId: id, orderId: rows[0].id, account: 'buyer',
        entryType: 'payment', direction: 'credit', amount, evidenceRef: `order:${code}（平台担保托管）`,
        createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'ordered', fromStatus: 'listed', toStatus: 'sold',
        note: `买家下单 ${code}，成交价 ¥${amount}，佣金费率 ${rate * 100}%（平台担保交易，货款托管）`,
        payload: { orderId: rows[0].id, amount, commissionRate: rate },
      });
      return rows[0];
    });
  });

  // 平台发货（高价值商品必须先有出库/发货状态复核）
  fastify.post('/api/orders/:id/ship', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    if (!['warehouse', 'ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅仓库/运营可发货');
    const b = req.body || {};
    requireBody(b, ['carrier', 'tracking']);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (o.status !== 'placed') throw new HttpError(409, `订单状态 ${o.status} 不可发货`);
      if (o.high_value) {
        const cf = await c.query(
          `SELECT 1 FROM status_confirmations
           WHERE consignment_id=$1 AND checkpoint IN ('outbound','shipping')
             AND created_at > (COALESCE((SELECT listed_at FROM consignments WHERE id=$1), now() - interval '30 days'))
           LIMIT 1`, [o.consignment_id]);
        if (!cf.rowCount) {
          throw new HttpError(422, '高价值商品发货前必须登记出库/发货状态复核（/confirm, checkpoint=outbound|shipping），防止证据断裂');
        }
      }
      await c.query(`UPDATE orders SET status='shipping', outbound_carrier=$1, outbound_tracking=$2 WHERE id=$3`,
        [b.carrier, b.tracking, orderId]);
      await c.query(`UPDATE consignments SET status='shipping', updated_at=now() WHERE id=$1`, [o.consignment_id]);
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'shipped_to_buyer',
        fromStatus: 'sold', toStatus: 'shipping',
        note: `平台发货：${b.carrier}/${b.tracking}${o.high_value ? '（高值件，已做出库复核+保价运输）' : ''}`,
        payload: { carrier: b.carrier, tracking: b.tracking },
      });
      return getOrder(c, orderId);
    });
  });

  // 买家签收验收（收货视频作为交付证据）
  fastify.post('/api/orders/:id/receive', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    const b = req.body || {};
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (Number(o.buyer_id) !== req.user.uid && req.user.role !== 'admin') throw new HttpError(403, '仅买家本人可确认签收');
      if (o.status !== 'shipping') throw new HttpError(409, `订单状态 ${o.status} 不可签收`);
      const until = new Date(Date.now() + AFTERSALES_DAYS * 864e5);
      await c.query(
        `UPDATE orders SET status='delivered', delivered_at=now(), aftersales_until=$2, receiving_video_url=$3 WHERE id=$1`,
        [orderId, until, b.videoUrl || null]);
      await c.query(`UPDATE consignments SET status='aftersales', updated_at=now() WHERE id=$1`, [o.consignment_id]);
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'delivered',
        fromStatus: 'shipping', toStatus: 'aftersales',
        note: `买家签收验收${b.videoUrl ? '，已上传收货视频 ' + b.videoUrl : '（未上传收货视频）'}；售后期限至 ${until.toISOString().slice(0, 10)}`,
        evidence: b.videoUrl ? [b.videoUrl] : [], payload: { aftersalesUntil: until, videoUrl: b.videoUrl || null },
      });
      return getOrder(c, orderId);
    });
  });

  // 确认完成：售后期满后担保放款（卖家到手 + 平台佣金入账）
  fastify.post('/api/orders/:id/complete', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      const isBuyer = Number(o.buyer_id) === req.user.uid;
      if (!isBuyer && !['ops', 'admin', 'finance'].includes(req.user.role)) throw new HttpError(403, '仅买家或平台可完结订单');
      if (o.status !== 'delivered') throw new HttpError(409, '仅已签收订单可完结');
      // 复鉴/争议导致的结算暂停：不得放款
      if (o.settlement_paused) {
        throw new HttpError(409, `该订单结算已暂停（${o.settlement_pause_reason || '复鉴/争议处理中'}），须在复鉴案件/争议裁决后才能放款`);
      }
      // 售后期限内禁止提前放款：订单/寄卖单/资金流水均不得变化
      if (!o.aftersales_until) throw new HttpError(409, '该订单缺少售后期限记录，不能放款');
      const until = new Date(o.aftersales_until);
      const now = new Date();
      if (now < until) {
        const leftMs = until - now;
        const days = Math.ceil(leftMs / 864e5);
        throw new HttpError(409, `售后保护期未满（截止 ${until.toISOString().slice(0, 10)}，约剩 ${days} 天），担保款暂不能放款给卖家`);
      }
      await c.query(`UPDATE orders SET status='completed' WHERE id=$1`, [orderId]);
      await c.query(`UPDATE consignments SET status='completed', updated_at=now() WHERE id=$1`, [o.consignment_id]);
      // 托管款清分
      await ledger(c, { consignmentId: o.consignment_id, orderId, account: 'seller',
        entryType: 'sale_proceeds', direction: 'credit', amount: o.seller_proceeds,
        evidenceRef: `order:${o.code} 担保放款`, createdBy: req.user.uid });
      await ledger(c, { consignmentId: o.consignment_id, orderId, account: 'platform',
        entryType: 'commission', direction: 'credit', amount: o.platform_fee,
        evidenceRef: `order:${o.code} 佣金(${Number(o.commission_rate) * 100}%)`, createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'completed',
        fromStatus: 'aftersales', toStatus: 'completed',
        note: `交易完成，担保放款：卖家到手 ¥${o.seller_proceeds}，平台佣金 ¥${o.platform_fee}`,
        payload: { sellerProceeds: o.seller_proceeds, platformFee: o.platform_fee },
      });
      return getOrder(c, orderId);
    });
  });

  // 买家发起退货（售后期限内；仓库须重新确认保价与物流责任）
  fastify.post('/api/orders/:id/return-request', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['reason', 'returnCarrier', 'returnTracking']);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (Number(o.buyer_id) !== req.user.uid && req.user.role !== 'admin') throw new HttpError(403, '仅买家可申请退货');
      if (o.status !== 'delivered') throw new HttpError(409, '仅售后中的订单可退货');
      if (o.aftersales_until && new Date(o.aftersales_until) < new Date()) {
        throw new HttpError(409, '已超过售后期限，请通过争议渠道申诉');
      }
      const policy = await c.query(
        `SELECT * FROM insurance_policies WHERE consignment_id=$1 AND status='active' ORDER BY id DESC LIMIT 1`,
        [o.consignment_id]);
      // 订单与寄卖单同步进入“退货中”
      await c.query(
        `UPDATE orders SET status='returning' WHERE id=$1`, [orderId]);
      await c.query(
        `UPDATE consignments SET status='buyer_returning', return_carrier=$1, return_tracking=$2, updated_at=now() WHERE id=$3`,
        [b.returnCarrier, b.returnTracking, o.consignment_id]);
      await c.query(
        `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous)
         VALUES ($1,'return',$2,$3,$4,$5,true)`,
        [o.consignment_id, req.user.uid,
         `买家退货寄出：${b.reason}；退回保价 ¥${policy.rows[0]?.declared_value ?? o.declared_value} 与物流责任已重新确认`,
         JSON.stringify(b.photos || []), o.receiving_video_url || null]);
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'buyer_return_requested',
        fromStatus: 'aftersales', toStatus: 'buyer_returning',
        note: `买家售后退货：${b.reason}；退回物流 ${b.returnCarrier}/${b.returnTracking}，保价与运输责任已重新确认`,
        evidence: [policy.rows[0] ? `insurance#${policy.rows[0].id}` : null, o.receiving_video_url, ...(b.photos || [])].filter(Boolean),
      });
      return getOrder(c, orderId);
    });
  });

  // 仓库结构化验收退回商品（划痕/附件/吊牌/防拆扣 + 开箱视频 + 经办人）
  fastify.post('/api/orders/:id/return-receive', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    if (!['warehouse', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅仓库可验收退货');
    const b = req.body || {};
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      const con = await getConsignment(c, o.consignment_id);

      // 已存在复核记录 → 直接拒绝重复提交（优先于状态门禁）
      const existed = await c.query(
        `SELECT 1 FROM return_inspections WHERE order_id=$1 LIMIT 1`, [orderId]);
      if (existed.rowCount) {
        throw new HttpError(409, '该退货已完成仓库复核，不能重复提交');
      }

      // ---- 前置门禁：必须已由买家完成退货申请（订单=returning 且寄卖单=buyer_returning）----
      if (o.status !== 'returning' || con.status !== 'buyer_returning') {
        throw new HttpError(409, '买家尚未完成退货申请（订单需处于“退货中”），仓库不能提交退回复核');
      }

      // 兼容旧入参（conditionSummary/matchesPrevious）；新入参为四项结构化核对
      const scratchStatus = b.scratchStatus || (b.matchesPrevious === false ? 'new_scratch' : 'consistent');
      const accessoriesStatus = b.accessoriesStatus || 'all_present';
      const tagStatus = b.tagStatus || 'intact';
      const tamperSealStatus = b.tamperSealStatus || 'intact';
      for (const [v, allowed, name] of [
        [scratchStatus, ['consistent', 'new_scratch', 'worse'], '划痕状态'],
        [accessoriesStatus, ['all_present', 'missing', 'swapped', 'damaged'], '附件状态'],
        [tagStatus, ['intact', 'missing', 'damaged'], '吊牌状态'],
        [tamperSealStatus, ['intact', 'removed', 'damaged'], '防拆扣状态'],
      ]) {
        if (!allowed.includes(v)) throw new HttpError(400, `${name}不合法`);
      }
      const rawVideo = (b.openBoxVideo || b.videoUrl || '').toString().trim();
      // ---- 资料门禁：必须提供有效开箱视频（非空字符串）----
      if (!rawVideo) {
        throw new HttpError(422, '退回复核必须提供有效开箱视频（openBoxVideo），否则不能提交');
      }
      const openBoxVideo = rawVideo;
      const platformPhotos = b.platformPhotos || b.photos || [];
      const accessoriesExpected = con.accessories || [];
      const accessoriesFound = Array.isArray(b.accessoriesFound) ? b.accessoriesFound : accessoriesExpected;
      const warehouseNote = b.warehouseNote || b.conditionSummary || '';

      const changed = scratchStatus !== 'consistent' || accessoriesStatus !== 'all_present'
        || tagStatus !== 'intact' || tamperSealStatus !== 'intact';

      // 防拆扣拆除对退款的单独影响
      let tamperSealImpact = null;
      if (tamperSealStatus === 'removed') {
        tamperSealImpact = '买家已拆除防拆扣：商品脱离平台防调换保护，原则上不支持无理由全额退款；如另有划痕/附件缺失，退款责任从严认定。';
      } else if (tamperSealStatus === 'damaged') {
        tamperSealImpact = '防拆扣损坏：需结合开箱视频与买家收货视频判定是否运输/买家责任。';
      }

      // 状态复核留痕（append-only 证据链的一部分）
      const summaryParts = [];
      summaryParts.push(`划痕:${({ consistent: '一致', new_scratch: '新增划痕', worse: '明显变差' })[scratchStatus]}`);
      summaryParts.push(`附件:${({ all_present: '齐全', missing: '缺失', swapped: '疑似调换', damaged: '损坏' })[accessoriesStatus]}`);
      summaryParts.push(`吊牌:${({ intact: '完好', missing: '缺失', damaged: '损坏' })[tagStatus]}`);
      summaryParts.push(`防拆扣:${({ intact: '完好', removed: '已拆除', damaged: '损坏' })[tamperSealStatus]}`);
      const conditionSummary = `退回复核（经办人 ${req.user.display_name || ''}）：${summaryParts.join(' / ')}${warehouseNote ? '；' + warehouseNote : ''}`;
      await c.query(
        `INSERT INTO status_confirmations
           (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous,discrepancies)
         VALUES ($1,'return',$2,$3,$4,$5,$6,$7)`,
        [o.consignment_id, req.user.uid, conditionSummary, JSON.stringify(platformPhotos), openBoxVideo,
         !changed, changed ? (b.scratchDetail || b.discrepancies || b.accessoriesDetail || b.tamperSealDetail || '退回状态与交付证据不一致') : null]);

      // 先建复核单（争议号稍后回填）
      const { rows: riRows } = await c.query(
        `INSERT INTO return_inspections
          (order_id,consignment_id,warehouse_user_id,open_box_video,warehouse_note,
           scratch_status,scratch_detail,accessories_status,accessories_expected,accessories_found,accessories_detail,
           tag_status,tamper_seal_status,tamper_seal_detail,platform_photos,result,tamper_seal_impact)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [orderId, o.consignment_id, req.user.uid, openBoxVideo, warehouseNote,
         scratchStatus, b.scratchDetail || null, accessoriesStatus,
         JSON.stringify(accessoriesExpected), JSON.stringify(accessoriesFound), b.accessoriesDetail || null,
         tagStatus, tamperSealStatus, b.tamperSealDetail || null, JSON.stringify(platformPhotos),
         changed ? 'changed' : 'consistent', tamperSealImpact]);
      const inspection = riRows[0];

      if (changed) {
        // 退回状态变差：冻结退款，同一寄卖单/订单立案，平台证据入案
        const summaryBits = [];
        if (scratchStatus !== 'consistent') summaryBits.push('划痕');
        if (accessoriesStatus !== 'all_present') summaryBits.push('附件');
        if (tagStatus !== 'intact') summaryBits.push('吊牌');
        if (tamperSealStatus !== 'intact') summaryBits.push('防拆扣');
        const detailBits = [];
        if (scratchStatus !== 'consistent') detailBits.push(`划痕${({ new_scratch: '新增', worse: '明显变差' })[scratchStatus]}${b.scratchDetail ? '：' + b.scratchDetail : ''}`);
        if (accessoriesStatus !== 'all_present') detailBits.push(`附件${({ missing: '缺失', swapped: '疑似调换', damaged: '损坏' })[accessoriesStatus]}（应退 ${accessoriesExpected.join('、') || '—'}；实到 ${accessoriesFound.join('、') || '—'}）${b.accessoriesDetail ? '；' + b.accessoriesDetail : ''}`);
        if (tagStatus !== 'intact') detailBits.push(`吊牌${({ missing: '缺失', damaged: '损坏' })[tagStatus]}`);
        if (tamperSealStatus !== 'intact') detailBits.push(`防拆扣${({ removed: '已被买家拆除', damaged: '损坏' })[tamperSealStatus]}${b.tamperSealDetail ? '：' + b.tamperSealDetail : ''}`);
        const summary = `买家退回后商品状态变化：${detailBits.join('；')}`;
        const dis = await openDispute(c, {
          consignment: con, order: o, opener: req.user, type: 'return_condition_change',
          summary,
          extraEvidence: [
            ...platformPhotos,
            openBoxVideo ? `开箱视频:${openBoxVideo}` : null,
            o.receiving_video_url ? `买家收货视频:${o.receiving_video_url}` : null,
            `return-inspection#${inspection.id}`,
          ].filter(Boolean),
        });
        await c.query(`UPDATE return_inspections SET dispute_id=$1 WHERE id=$2`, [dis.id, inspection.id]);
        await c.query(`UPDATE orders SET refund_frozen=TRUE, refund_freeze_reason=$1 WHERE id=$2`,
          [`退回复核状态变差（${summaryBits.join('/')}），争议 ${dis.code} 处理中`, orderId]);

        // 平台证据在争议线程固定一条（买家解释后续并列追加）
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
           VALUES ($1,$2,'warehouse',$3,$4)`,
          [dis.id, req.user.uid,
            `【仓库退回复核·平台证据】经办人 ${req.user.display_name || ''}；开箱视频：${openBoxVideo || '未提供'}\n${detailBits.map((x) => '· ' + x).join('\n')}\n${tamperSealImpact ? '【防拆扣影响】' + tamperSealImpact : ''}\n退款已冻结，请买家在同一案件中提交解释与证据，客服将对照双方证据认定赔付责任。`,
            JSON.stringify([...platformPhotos, openBoxVideo].filter(Boolean))]);

        // 通知买家提交解释
        await notify(c, {
          userId: o.buyer_id,
          title: `退货 ${o.code} 复核发现状态变化，退款已冻结，请提交说明`,
          content: `${summary}。请在争议案件 ${dis.code} 中提交解释与证据照片，平台将与仓库开箱视频/复核照片并列审核。${tamperSealStatus === 'removed' ? '系统已记录防拆扣被拆除对退款的影响。' : ''}`,
          category: 'dispute', linkType: 'dispute', linkId: dis.id,
        });

        await logEvent(c, {
          consignmentId: o.consignment_id, actor: req.user, type: 'return_condition_frozen',
          note: `退回复核状态变差，退款冻结并立案 ${dis.code}：${summaryBits.join('/')}${tamperSealImpact ? '；防拆扣拆除影响已单独记录' : ''}`,
          evidence: [...platformPhotos, openBoxVideo].filter(Boolean),
          payload: { inspectionId: inspection.id, disputeId: dis.id, tamperSealRemoved: tamperSealStatus === 'removed' },
        });
        return { disputed: true, frozen: true, message: '退回商品状态与交付证据不符，已自动立案并冻结退款', disputeId: dis.id, inspectionId: inspection.id };
      }

      // 四项一致：可退款
      await c.query(`UPDATE orders SET status='returned', refund_frozen=FALSE, refund_freeze_reason=NULL WHERE id=$1`, [orderId]);
      await c.query(`UPDATE consignments SET status='return_received', updated_at=now() WHERE id=$1`, [o.consignment_id]);
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'buyer_return_received',
        fromStatus: 'buyer_returning', toStatus: 'return_received',
        note: `仓库结构化验收退货（划痕/附件/吊牌/防拆扣均一致，开箱视频已存），可退款`,
        evidence: [...platformPhotos, openBoxVideo].filter(Boolean),
      });
      return { disputed: false, frozen: false, message: '退货四项复核一致，等待财务退款', inspectionId: inspection.id };
    });
  });

  // 财务退款（无争议退货）
  fastify.post('/api/orders/:id/refund', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    if (!['finance', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅财务可执行退款');
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (o.refund_frozen) throw new HttpError(409, `退款已冻结：${o.refund_freeze_reason || '退回复核状态异常，争议处理中'}`);
      if (!['returned', 'delivered'].includes(o.status)) throw new HttpError(409, '当前订单不可直接退款（争议案件须在争议裁决中处理）');
      const blocked = await c.query(
        `SELECT code FROM disputes WHERE order_id=$1 AND status IN ('opened','investigating')`, [orderId]);
      if (blocked.rowCount) {
        throw new HttpError(409, `该订单存在未裁决争议 ${blocked.rows[0].code}，退款已冻结，须在争议裁决中处理`);
      }
      await c.query(`UPDATE orders SET status='refunded' WHERE id=$1`, [orderId]);
      await ledger(c, { consignmentId: o.consignment_id, orderId, account: 'buyer',
        entryType: 'refund', direction: 'credit', amount: o.amount,
        evidenceRef: `order:${o.code} 退货退款（退货验收一致）`, createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'refunded',
        note: `财务原路退款买家 ¥${o.amount}（托管款释放，未与卖家结算）`,
        payload: { amount: o.amount },
      });
      return { refunded: o.amount };
    });
  });

  // 退回复核记录（买家/仓库/客服/财务可按权限查看）
  fastify.get('/api/orders/:id/return-inspections', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (Number(o.buyer_id) !== req.user.uid &&
          !['admin', 'ops', 'cs', 'finance', 'warehouse'].includes(req.user.role)) {
        throw new HttpError(403, '仅交易相关方可查看退回复核');
      }
      const { rows } = await c.query(
        `SELECT ri.*, u.display_name AS warehouse_name, ub.display_name AS buyer_name
         FROM return_inspections ri
         JOIN users u ON u.id=ri.warehouse_user_id
         LEFT JOIN users ub ON ub.id=ri.buyer_user_id
         WHERE ri.order_id=$1 ORDER BY ri.id`, [orderId]);
      return { items: rows, refundFrozen: o.refund_frozen, refundFreezeReason: o.refund_freeze_reason };
    });
  });

  // 买家就退货状态变化提交解释（与平台证据并列保存在同一争议/复核单）
  fastify.post('/api/orders/:id/return-inspection/explanation', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['explanation']);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (Number(o.buyer_id) !== req.user.uid && !['admin', 'cs'].includes(req.user.role)) {
        throw new HttpError(403, '仅买家本人可提交解释');
      }
      const insp = await c.query(
        `SELECT * FROM return_inspections WHERE order_id=$1 ORDER BY id DESC LIMIT 1`, [orderId]);
      if (!insp.rows[0]) throw new HttpError(404, '该订单暂无退回复核记录');
      const ri = insp.rows[0];
      await c.query(
        `UPDATE return_inspections SET buyer_explanation=$1, buyer_evidence=$2,
                buyer_explained_at=now(), buyer_user_id=$3 WHERE id=$4`,
        [b.explanation, JSON.stringify(b.evidence || []), o.buyer_id, ri.id]);
      if (ri.dispute_id) {
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
           VALUES ($1,$2,'buyer',$3,$4)`,
          [ri.dispute_id, req.user.uid,
            `【买家解释（与平台退回复核证据并列保存）】${b.explanation}`,
            JSON.stringify(b.evidence || [])]);
      }
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'buyer_return_explanation',
        note: `买家就退回复核提交解释：${b.explanation}`,
        evidence: b.evidence || [], payload: { inspectionId: ri.id },
      });
      const wh = await c.query(`SELECT id FROM users WHERE role='warehouse' ORDER BY id LIMIT 1`);
      if (wh.rows[0]) await notify(c, {
        userId: wh.rows[0].id, title: `订单 ${o.code} 买家已提交退货解释`,
        content: b.explanation.slice(0, 120), category: 'dispute',
        linkType: ri.dispute_id ? 'dispute' : 'order', linkId: ri.dispute_id || orderId });
      return { ok: true };
    });
  });

  // 客服/财务记录退回复核的退款影响与赔付责任（可解除退款冻结）
  fastify.post('/api/return-inspections/:id/resolve', { onRequest: auth }, async (req) => {
    const inspId = Number(req.params.id);
    if (!['cs', 'finance', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅客服/财务可认定退款影响与责任');
    const b = req.body || {};
    requireBody(b, ['refundImpact', 'responsibility', 'refundImpactDetail']);
    if (!['full_refund', 'partial_refund', 'refund_denied'].includes(b.refundImpact)) throw new HttpError(400, '退款影响不合法');
    if (!['buyer', 'platform', 'logistics', 'seller', 'none'].includes(b.responsibility)) throw new HttpError(400, '责任方不合法');
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM return_inspections WHERE id=$1`, [inspId]);
      const ri = rows[0];
      if (!ri) throw new HttpError(404, '退回复核记录不存在');
      const deduct = money(b.deductAmount ?? 0);
      const unfreeze = b.unfreeze !== false;
      await c.query(
        `UPDATE return_inspections SET refund_impact=$1, refund_impact_detail=$2, deduct_amount=$3,
                responsibility=$4, responsibility_detail=$5, reviewed_by=$6, reviewed_at=now() WHERE id=$7`,
        [b.refundImpact, b.refundImpactDetail, deduct, b.responsibility, b.responsibilityDetail || null,
         req.user.uid, inspId]);
      if (unfreeze) {
        await c.query(`UPDATE orders SET refund_frozen=FALSE, refund_freeze_reason=NULL WHERE id=$1`, [ri.order_id]);
      }
      await logEvent(c, {
        consignmentId: ri.consignment_id, actor: req.user, type: 'return_inspection_resolved',
        note: `退回复核责任认定：责任=${
          { buyer: '买家', platform: '平台', logistics: '物流', seller: '卖家', none: '无责' }[b.responsibility]
        }；退款影响=${
          { full_refund: '全额退款', partial_refund: '部分退款（扣除 ¥' + deduct + '）', refund_denied: '不予退款' }[b.refundImpact]
        }。${b.refundImpactDetail}${ri.tamper_seal_status === 'removed' ? '（防拆扣拆除已单独计入）' : ''}`,
        payload: { inspectionId: inspId, refundImpact: b.refundImpact, deductAmount: deduct, responsibility: b.responsibility },
      });
      if (ri.dispute_id) {
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content)
           VALUES ($1,$2,$3,$4)`,
          [ri.dispute_id, req.user.uid, req.user.role,
            `【退回复核责任认定】责任方：${
              { buyer: '买家', platform: '平台', logistics: '物流', seller: '卖家', none: '无责' }[b.responsibility]
            }；退款影响：${
              { full_refund: '全额退款', partial_refund: `部分退款，扣除 ¥${deduct}`, refund_denied: '不予退款' }[b.refundImpact]
            }。${b.refundImpactDetail}`]);
      }
      return { ok: true, unfrozen: unfreeze };
    });
  });
}
