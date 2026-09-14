import { query, tx } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, getOrder,
  canViewDispute, isParty, money, ledger, openDispute,
} from '../lib.js';

const DISPUTE_TYPES = [
  'seller_challenge_auth', 'buyer_grade_dispute', 'transit_damage', 'accessory_missing',
  'reauth_overturn', 'return_condition_change', 'withdraw_logistics', 'return_logistics',
];

async function disputeDetail(client, id) {
  const d = await client.query(
    `SELECT d.*, c.code AS consignment_code, c.brand, c.model, c.category, c.high_value,
            c.seller_id, c.sale_price, c.declared_value,
            u.display_name AS opener_name, o.code AS order_code, o.buyer_id, o.amount AS order_amount,
            ur.display_name AS resolver_name
     FROM disputes d
     JOIN consignments c ON c.id=d.consignment_id
     JOIN users u ON u.id=d.opened_by
     LEFT JOIN orders o ON o.id=d.order_id
     LEFT JOIN users ur ON ur.id=d.resolved_by
     WHERE d.id=$1`, [id]);
  if (!d.rows[0]) throw new HttpError(404, '争议不存在');
  const dis = d.rows[0];
  const [msgs, led, auths, confs] = await Promise.all([
    client.query(
      `SELECT m.*, u.display_name AS author_name FROM dispute_messages m
       JOIN users u ON u.id=m.author_id WHERE m.dispute_id=$1 ORDER BY m.id`, [id]),
    client.query(
      `SELECT l.*, u.display_name AS created_by_name FROM financial_ledger l
       LEFT JOIN users u ON u.id=l.created_by WHERE l.dispute_id=$1 ORDER BY l.id`, [id]),
    client.query(
      `SELECT a.id,a.round,a.result,a.grade,a.overturned,a.summary,a.is_final,
              up.display_name AS primary_name, us.display_name AS second_name
       FROM authentications a JOIN users up ON up.id=a.primary_authenticator
       LEFT JOIN users us ON us.id=a.second_authenticator
       WHERE a.consignment_id=$1 ORDER BY a.round`, [dis.consignment_id]),
    client.query(
      `SELECT s.*, u.display_name AS confirmer_name FROM status_confirmations s
       JOIN users u ON u.id=s.confirmer_id WHERE s.consignment_id=$1 ORDER BY s.id`, [dis.consignment_id]),
  ]);
  return { ...dis, messages: msgs.rows, ledger: led.rows, authentications: auths.rows, confirmations: confs.rows };
}

export default async function disputeRoutes(fastify) {
  const auth = [fastify.authenticate];

  fastify.get('/api/disputes', { onRequest: auth }, async (req) => {
    const u = req.user;
    if (['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'].includes(u.role)) {
      const { rows } = await query(
        `SELECT d.*, c.code AS consignment_code, c.brand, c.model,
                u.display_name AS opener_name, o.code AS order_code
         FROM disputes d JOIN consignments c ON c.id=d.consignment_id
         JOIN users u ON u.id=d.opened_by LEFT JOIN orders o ON o.id=d.order_id
         ORDER BY d.id DESC LIMIT 200`);
      return { items: rows };
    }
    const { rows } = await query(
      `SELECT d.*, c.code AS consignment_code, c.brand, c.model,
              u.display_name AS opener_name, o.code AS order_code
       FROM disputes d JOIN consignments c ON c.id=d.consignment_id
       JOIN users u ON u.id=d.opened_by LEFT JOIN orders o ON o.id=d.order_id
       WHERE d.parties @> $1::jsonb ORDER BY d.id DESC`,
      [JSON.stringify([{ userId: u.uid }])]);
    return { items: rows.filter((x) => (x.parties || []).some((p) => Number(p.userId) === u.uid)) };
  });

  fastify.get('/api/disputes/:id', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const detail = await disputeDetail(c, id);
      if (!canViewDispute(req.user, detail)) throw new HttpError(403, '您不是该争议的相关方');
      return detail;
    });
  });

  // 开争议（卖家质疑鉴定 / 买家成色不符 / 物流损坏 / 附件缺失 / 退保价异议 等，统一入同一案件）
  fastify.post('/api/consignments/:id/disputes', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['type', 'summary']);
    if (!DISPUTE_TYPES.includes(b.type)) throw new HttpError(400, '争议类型不合法');
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      let order = null;
      if (b.orderId) {
        order = await getOrder(c, Number(b.orderId));
      } else {
        const r = await c.query(`SELECT * FROM orders WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
        order = r.rows[0] ?? null;
      }
      const u = req.user;
      // 开案权限：卖家本人、该单买家、仓库/客服/运营/管理/鉴定（复鉴推翻）
      const isSeller = Number(con.seller_id) === u.uid;
      const isBuyer = order && Number(order.buyer_id) === u.uid;
      const isStaff = ['cs', 'ops', 'admin', 'warehouse', 'authenticator', 'finance'].includes(u.role);
      if (!isSeller && !isBuyer && !isStaff) throw new HttpError(403, '只有交易相关方或平台人员可发起争议');
      if (u.role === 'seller' && !isSeller) throw new HttpError(403, '只能对自己的寄卖单发起争议');
      if (u.role === 'buyer' && !isBuyer) throw new HttpError(403, '只能对自己的订单发起争议');

      const dis = await openDispute(c, {
        consignment: con, order, opener: u, type: b.type,
        summary: b.summary, extraEvidence: b.evidence || [],
      });
      if (b.evidence?.length) {
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
           VALUES ($1,$2,$3,$4,$5)`,
          [dis.id, u.uid, u.role, `申诉证据：${b.summary}`, JSON.stringify(b.evidence)]);
      }
      return disputeDetail(c, dis.id);
    });
  });

  // 相关方举证 / 留言（卖家、鉴定师、仓库、客服、买家、财务同一线程）
  fastify.post('/api/disputes/:id/messages', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['content']);
    return tx(async (c) => {
      const detail = await disputeDetail(c, id);
      if (!isParty(req.user, detail) && !['admin', 'cs', 'ops', 'finance', 'warehouse', 'authenticator'].includes(req.user.role)) {
        throw new HttpError(403, '仅争议相关方可留言举证');
      }
      if (detail.status === 'closed' || detail.status === 'resolved') throw new HttpError(409, '案件已裁决结案，不能再留言');
      const { rows } = await c.query(
        `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, req.user.uid, req.user.role, b.content, JSON.stringify(b.evidence || [])]);
      return rows[0];
    });
  });

  // 客服受理进入调查
  fastify.post('/api/disputes/:id/investigate', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['cs', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅客服可受理争议');
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM disputes WHERE id=$1`, [id]);
      const d = rows[0];
      if (!d) throw new HttpError(404, '争议不存在');
      if (d.status !== 'opened') throw new HttpError(409, '仅新立案件可受理');
      await c.query(`UPDATE disputes SET status='investigating' WHERE id=$1`, [id]);
      await c.query(
        `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content)
         VALUES ($1,$2,'cs',$3)`,
        [id, req.user.uid, `客服受理，进入多方核查。将对照鉴定记录、各节点状态复核与交付证据（收货视频）认定责任。`]);
      await logEvent(c, {
        consignmentId: d.consignment_id, actor: req.user, type: 'dispute_investigating',
        note: `争议 ${d.code} 受理调查`,
      });
      return { ok: true };
    });
  });

  // 裁决：退款 / 赔付 / 佣金调整 / 保险理赔 / 商品处置 / 黑名单，全部带争议编号入账可追溯
  fastify.post('/api/disputes/:id/resolve', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['cs', 'finance', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅客服/财务可裁决');
    const b = req.body || {};
    requireBody(b, ['ruling', 'itemDisposition']);
    if (!['return_seller', 'keep_buyer', 'resell', 'destroy'].includes(b.itemDisposition)) {
      throw new HttpError(400, '商品处置方式不合法');
    }
    return tx(async (c) => {
      const d = await disputeDetail(c, id);
      if (['resolved', 'closed'].includes(d.status)) throw new HttpError(409, '案件已裁决');
      const con = await getConsignment(c, d.consignment_id);

      const refund = money(b.refundAmount ?? 0);
      const comp = money(b.compensationAmount ?? 0);
      const commAdj = money(b.commissionAdjust ?? 0);
      const insClaim = money(b.insuranceClaim ?? 0);
      const compParty = b.compensateParty === 'seller' ? 'seller' : 'buyer';
      if (refund < 0 || comp < 0 || commAdj < 0 || insClaim < 0) throw new HttpError(400, '金额不能为负');
      if (d.order_id && refund > money(d.order_amount)) throw new HttpError(400, '退款不能超过订单金额');

      // 黑名单
      let blacklistId = null;
      if (b.blacklistPartyId) {
        const uid = Number(b.blacklistPartyId);
        const ok = (d.parties || []).some((p) => Number(p.userId) === uid);
        if (!ok && req.user.role !== 'admin') throw new HttpError(400, '只能将争议相关方列入黑名单');
        await c.query(`UPDATE users SET blacklisted=TRUE, blacklist_reason=$1 WHERE id=$2`,
          [b.blacklistReason || `争议 ${d.code} 裁决列入黑名单`, uid]);
        const bl = await c.query(
          `INSERT INTO blacklist_log (user_id,reason,dispute_id,created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [uid, b.blacklistReason || `争议 ${d.code} 裁决列入黑名单`, id, req.user.uid]);
        blacklistId = uid;
        void bl;
      }

      // 案件裁决落库
      await c.query(
        `UPDATE disputes SET status='resolved', refund_amount=$1, compensation_amount=$2,
            commission_adjust=$3, insurance_claim=$4, item_disposition=$5, blacklist_party_id=$6,
            ruling=$7, resolved_by=$8, resolved_at=now() WHERE id=$9`,
        [refund, comp, commAdj, insClaim, b.itemDisposition, blacklistId, b.ruling, req.user.uid, id]);

      const evidenceRef = `dispute:${d.code}`;
      const order = d.order_id ? await getOrder(c, d.order_id) : null;

      // ---- 财务入账（每笔引用争议编号，可追溯鉴定/交付证据） ----
      if (refund > 0 && order) {
        await ledger(c, { consignmentId: con.id, orderId: order.id, disputeId: id, account: 'buyer',
          entryType: 'refund', direction: 'credit', amount: refund, evidenceRef, createdBy: req.user.uid });
        await c.query(`UPDATE orders SET status='refunded' WHERE id=$1`, [order.id]);
      }
      if (comp > 0) {
        await ledger(c, { consignmentId: con.id, orderId: order?.id ?? null, disputeId: id,
          account: compParty, entryType: 'compensation', direction: 'credit', amount: comp,
          evidenceRef: `${evidenceRef} 赔付${compParty === 'seller' ? '卖家' : '买家'}`, createdBy: req.user.uid });
      }
      if (commAdj > 0) {
        // 平台让佣：退给卖家（交易继续）或随退款给买家
        const toAccount = b.itemDisposition === 'keep_buyer' ? 'seller' : 'buyer';
        await ledger(c, { consignmentId: con.id, orderId: order?.id ?? null, disputeId: id,
          account: toAccount, entryType: 'commission_refund', direction: 'credit', amount: commAdj,
          evidenceRef: `${evidenceRef} 平台让佣`, createdBy: req.user.uid });
      }
      if (insClaim > 0) {
        await ledger(c, { consignmentId: con.id, orderId: order?.id ?? null, disputeId: id,
          account: 'insurance', entryType: 'insurance_claim', direction: 'debit', amount: insClaim,
          evidenceRef: `${evidenceRef} 保险理赔（赔付另行入账）`, createdBy: req.user.uid });
        await c.query(
          `UPDATE insurance_policies SET status='settled', claim_amount=$1, note=$2
           WHERE consignment_id=$3 AND status='active'`,
          [insClaim, `争议 ${d.code} 理赔结案`, con.id]);
      }

      // ---- 商品处置与寄卖单/订单状态 ----
      let nextStatus = con.status;
      switch (b.itemDisposition) {
        case 'return_seller':
          nextStatus = b.returnTracking ? 'returning_seller' : 'returned_seller';
          if (b.returnCarrier) {
            await c.query(`UPDATE consignments SET return_carrier=$1, return_tracking=$2 WHERE id=$3`,
              [b.returnCarrier, b.returnTracking || null, con.id]);
          }
          break;
        case 'keep_buyer':
          nextStatus = 'completed';
          if (order && refund === 0) {
            await c.query(`UPDATE orders SET status='completed' WHERE id=$1`, [order.id]);
            await ledger(c, { consignmentId: con.id, orderId: order.id, disputeId: id, account: 'seller',
              entryType: 'sale_proceeds', direction: 'credit',
              amount: money(order.seller_proceeds + commAdj),
              evidenceRef: `${evidenceRef} 担保放款（含让佣）`, createdBy: req.user.uid });
            await ledger(c, { consignmentId: con.id, orderId: order.id, disputeId: id, account: 'platform',
              entryType: 'commission', direction: 'credit',
              amount: money(order.platform_fee - commAdj),
              evidenceRef: `${evidenceRef} 佣金（扣除让佣）`, createdBy: req.user.uid });
          }
          break;
        case 'resell':
          nextStatus = 'quoted';
          break;
        case 'destroy':
          nextStatus = 'destroyed';
          break;
      }
      await c.query(`UPDATE consignments SET status=$1, updated_at=now() WHERE id=$2`, [nextStatus, con.id]);

      await logEvent(c, {
        consignmentId: con.id, actor: req.user, type: 'dispute_resolved',
        fromStatus: 'disputed', toStatus: nextStatus,
        note: `争议 ${d.code} 裁决：${b.ruling}｜退款¥${refund} 赔付¥${comp}(${compParty === 'seller' ? '卖家' : '买家'}) 让佣¥${commAdj} 保险理赔¥${insClaim}｜商品处置：${
          { return_seller: '退回卖家', keep_buyer: '买家保留', resell: '重新上架', destroy: '销毁' }[b.itemDisposition]
        }${blacklistId ? '｜已列入黑名单' : ''}`,
        evidence: d.linked_evidence || [],
        payload: { refund, compensation: comp, commissionAdjust: commAdj, insuranceClaim: insClaim,
                   itemDisposition: b.itemDisposition, blacklistPartyId: blacklistId },
      });
      await c.query(
        `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content)
         VALUES ($1,$2,$3,$4)`,
        [id, req.user.uid, req.user.role,
          `【裁决】${b.ruling}\n退款 ¥${refund}；赔付 ¥${comp}（${compParty === 'seller' ? '卖家' : '买家'}）；佣金调整 ¥${commAdj}；保险理赔 ¥${insClaim}；商品处置：${b.itemDisposition}${blacklistId ? '；相关方已列入平台黑名单' : ''}。所有资金流水已按案件编号归档。`]);

      return disputeDetail(c, id);
    });
  });
}
