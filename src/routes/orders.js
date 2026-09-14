import { query, tx } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, getOrder,
  latestQuote, genCode, money, ledger, openDispute,
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

  // 仓库验收退回商品（状态与交付证据不符 → 自动立案）
  fastify.post('/api/orders/:id/return-receive', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    if (!['warehouse', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅仓库可验收退货');
    const b = req.body || {};
    requireBody(b, ['conditionSummary']);
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
      if (o.con_status !== 'buyer_returning' && o.status === 'delivered') {
        // 允许争议退回
      }
      const con = await getConsignment(c, o.consignment_id);
      await c.query(
        `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous,discrepancies)
         VALUES ($1,'return',$2,$3,$4,$5,$6,$7)`,
        [o.consignment_id, req.user.uid, b.conditionSummary, JSON.stringify(b.photos || []),
         b.videoUrl || null, b.matchesPrevious !== false, b.discrepancies || null]);

      if (b.matchesPrevious === false) {
        // 退回后商品状态变化：同一寄卖单立案，冻结退款
        await openDispute(c, {
          consignment: con, order: o, opener: req.user, type: 'return_condition_change',
          summary: `买家退回后商品状态发生变化：${b.discrepancies || b.conditionSummary}`,
          extraEvidence: [...(b.photos || []), b.videoUrl, o.receiving_video_url ? `买家收货视频:${o.receiving_video_url}` : null].filter(Boolean),
        });
        return { disputed: true, message: '退回商品状态与交付证据不符，已自动立案并冻结退款' };
      }

      await c.query(`UPDATE orders SET status='returned' WHERE id=$1`, [orderId]);
      await c.query(`UPDATE consignments SET status='return_received', updated_at=now() WHERE id=$1`, [o.consignment_id]);
      await logEvent(c, {
        consignmentId: o.consignment_id, actor: req.user, type: 'buyer_return_received',
        fromStatus: 'buyer_returning', toStatus: 'return_received',
        note: `仓库验收退货：${b.conditionSummary}；与出库状态一致，可退款`, evidence: b.photos || [],
      });
      return { disputed: false, message: '退货验收通过，等待财务退款' };
    });
  });

  // 财务退款（无争议退货）
  fastify.post('/api/orders/:id/refund', { onRequest: auth }, async (req) => {
    const orderId = Number(req.params.id);
    if (!['finance', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅财务可执行退款');
    return tx(async (c) => {
      const o = await getOrderWithConsignment(c, orderId);
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
}
