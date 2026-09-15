import { query, tx, pool } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, money, ledger, notify, genCode,
  openDispute,
} from '../lib.js';

const STAFF = ['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'];

/** 汇总某寄卖单当前市场信号（收藏/议价/活动报名/已计费用） */
async function marketSignals(c, consignmentId) {
  const [fav, offers, enr, storage, ins] = await Promise.all([
    c.query(`SELECT COUNT(*)::int AS n FROM favorites WHERE consignment_id=$1`, [consignmentId]),
    c.query(
      `SELECT o.*, u.display_name AS buyer_name FROM offers o
       JOIN users u ON u.id=o.buyer_id
       WHERE o.consignment_id=$1 AND o.status='active' ORDER BY o.offer_amount DESC`, [consignmentId]),
    c.query(
      `SELECT pe.*, p.title AS promotion_title FROM promo_enrollments pe
       JOIN promotions p ON p.id=pe.promotion_id
       WHERE pe.consignment_id=$1 AND pe.status='enrolled' ORDER BY pe.id`, [consignmentId]),
    c.query(`SELECT COALESCE(SUM(amount),0)::float AS total, COUNT(*)::int AS n
             FROM financial_ledger WHERE consignment_id=$1 AND account='seller'
             AND entry_type='storage_fee' AND direction='debit'`, [consignmentId]),
    c.query(`SELECT COALESCE(SUM(amount),0)::float AS total, COUNT(*)::int AS n
             FROM financial_ledger WHERE consignment_id=$1 AND account='seller'
             AND entry_type='insurance_premium' AND direction='debit'`, [consignmentId]),
  ]);
  return {
    favoriteCount: fav.rows[0].n,
    activeOffers: offers.rows,
    activeOfferCount: offers.rows.length,
    activeDepositTotal: money(offers.rows.reduce((s, o) => s + Number(o.deposit_amount), 0)),
    enrollments: enr.rows,
    enrollmentCount: enr.rows.length,
    storageFeeTotal: money(storage.rows[0].total),
    storageBillCount: storage.rows[0].n,
    insuranceFeeTotal: money(ins.rows[0].total),
  };
}

export default async function sellerRoutes(fastify) {
  const auth = [fastify.authenticate];

  // ================= 买家侧：收藏 =================
  fastify.post('/api/consignments/:id/favorite', { onRequest: auth }, async (req) => {
    if (!['buyer', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅买家可收藏');
    const id = Number(req.params.id);
    await getConsignment(pool, id);
    return tx(async (c) => {
      await c.query(
        `INSERT INTO favorites (consignment_id,user_id) VALUES ($1,$2)
         ON CONFLICT (consignment_id,user_id) DO NOTHING`, [id, req.user.uid]);
      return { ok: true };
    });
  });
  fastify.delete('/api/consignments/:id/favorite', { onRequest: auth }, async (req) => {
    if (!['buyer', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅买家可取消收藏');
    await query(`DELETE FROM favorites WHERE consignment_id=$1 AND user_id=$2`, [Number(req.params.id), req.user.uid]);
    return { ok: true };
  });

  // ================= 买家侧：议价（可缴保证金） =================
  fastify.post('/api/consignments/:id/offers', { onRequest: auth }, async (req) => {
    if (!['buyer', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅买家可议价');
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['offerAmount']);
    const deposit = money(b.depositAmount ?? 0);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (con.locked) throw new HttpError(409, '商品已锁定，暂停议价');
      if (!['listed'].includes(con.status)) throw new HttpError(409, '商品当前不接受议价');
      if (money(b.offerAmount) <= 0) throw new HttpError(400, '议价金额必须大于 0');
      if (deposit > money(con.sale_price)) throw new HttpError(400, '保证金不能超过当前售价');
      const { rows } = await c.query(
        `INSERT INTO offers (code,consignment_id,buyer_id,offer_amount,deposit_amount,status,note)
         VALUES ($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
        [genCode('OF'), id, req.user.uid, money(b.offerAmount), deposit, b.note || null]);
      if (deposit > 0) {
        await ledger(c, { consignmentId: id, account: 'buyer', entryType: 'offer_deposit',
          direction: 'debit', amount: deposit, evidenceRef: `offer:${rows[0].code} 议价保证金`, createdBy: req.user.uid });
      }
      await notify(c, { userId: con.seller_id, title: `收到新议价（${con.code}）`,
        content: `买家出价 ¥${money(b.offerAmount)}${deposit ? `，已缴保证金 ¥${deposit}` : '（未缴保证金）'}。`,
        category: 'order', linkType: 'consignment', linkId: id });
      return rows[0];
    });
  });

  fastify.get('/api/consignments/:id/offers', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      const isSeller = Number(con.seller_id) === req.user.uid;
      if (!isSeller && !STAFF.includes(req.user.role)) throw new HttpError(403, '仅卖家/平台可查看议价');
      return { items: (await marketSignals(c, id)).activeOffers };
    });
  });

  // ================= 活动与报名 =================
  fastify.get('/api/promotions', { onRequest: auth }, async () => {
    const { rows } = await query(`SELECT * FROM promotions WHERE active=TRUE ORDER BY id DESC`);
    return { items: rows };
  });
  fastify.post('/api/promotions', { onRequest: auth }, async (req) => {
    if (!['ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅运营可创建活动');
    const b = req.body || {};
    requireBody(b, ['title']);
    const { rows } = await query(
      `INSERT INTO promotions (code,title,promo_type,active) VALUES ($1,$2,$3,TRUE) RETURNING *`,
      [genCode('PM'), b.title, b.promoType || 'campaign']);
    return rows[0];
  });
  fastify.post('/api/consignments/:id/enroll', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['promotionId']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['ops', 'admin'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可报名活动');
      }
      if (con.locked) throw new HttpError(409, '商品已锁定，不能报名活动');
      const { rows } = await c.query(
        `INSERT INTO promo_enrollments (promotion_id,consignment_id,enrolled_by)
         VALUES ($1,$2,$3) ON CONFLICT (promotion_id,consignment_id) DO NOTHING RETURNING *`,
        [Number(b.promotionId), id, req.user.uid]);
      if (!rows[0]) return { ok: true, duplicated: true };
      await logEvent(c, { consignmentId: id, actor: req.user, type: 'promo_enrolled',
        note: `报名活动 ${b.promotionId}`, payload: { promotionId: Number(b.promotionId) } });
      return { ok: true };
    });
  });

  // ================= 卖家：降价预检 =================
  fastify.post('/api/consignments/:id/price-adjustment/preview', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['newSalePrice']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['ops', 'admin'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可调整底价');
      }
      if (con.locked) throw new HttpError(409, '商品已锁定，不能调价');
      if (!['listed'].includes(con.status)) throw new HttpError(409, '仅在售商品可降价');
      const newSale = money(b.newSalePrice);
      if (newSale >= money(con.sale_price)) throw new HttpError(400, '降价后的上架价必须低于当前价');
      const q = await c.query(`SELECT * FROM quotes WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
      const quote = q.rows[0];
      const rate = quote ? Number(quote.commission_rate) : 0.12;
      const newReserve = b.newReservePrice != null ? money(b.newReservePrice)
        : Math.min(money(con.reserve_price), Math.round(newSale * 0.85 * 100) / 100);
      if (newReserve > newSale) throw new HttpError(400, '底价不能高于新上架价');
      const signals = await marketSignals(c, id);
      const estCommission = money(newSale * rate);
      return {
        oldSalePrice: money(con.sale_price), newSalePrice: newSale,
        oldReservePrice: money(con.reserve_price), newReservePrice: newReserve,
        commissionRate: rate, estCommission,
        estSellerProceeds: money(newSale - estCommission - signals.storageFeeTotal - signals.insuranceFeeTotal),
        signals,
      };
    });
  });

  // ================= 卖家：确认降价 =================
  fastify.post('/api/consignments/:id/price-adjustment', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['newSalePrice']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['ops', 'admin'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可调整底价');
      }
      if (con.locked) throw new HttpError(409, '商品已锁定，不能调价');
      if (con.status !== 'listed') throw new HttpError(409, '仅在售商品可降价');
      const newSale = money(b.newSalePrice);
      if (newSale >= money(con.sale_price)) throw new HttpError(400, '降价后的上架价必须低于当前价');
      const q = await c.query(`SELECT * FROM quotes WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
      const quote = q.rows[0];
      const rate = quote ? Number(quote.commission_rate) : 0.12;
      const newReserve = b.newReservePrice != null ? money(b.newReservePrice)
        : Math.min(money(con.reserve_price), Math.round(newSale * 0.85 * 100) / 100);
      const signals = await marketSignals(c, id);
      const estCommission = money(newSale * rate);
      const estProceeds = money(newSale - estCommission - signals.storageFeeTotal - signals.insuranceFeeTotal);
      const { rows } = await c.query(
        `INSERT INTO price_adjustments
          (code,consignment_id,old_reserve_price,new_reserve_price,old_sale_price,new_sale_price,
           commission_rate,est_commission,est_seller_proceeds,favorite_count,active_offer_count,
           enrollment_count,storage_fee_total,insurance_fee_total,reason,confirmed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
        [genCode('PA'), id, money(con.reserve_price), newReserve, money(con.sale_price), newSale,
         rate, estCommission, estProceeds, signals.favoriteCount, signals.activeOfferCount,
         signals.enrollmentCount, signals.storageFeeTotal, signals.insuranceFeeTotal,
         b.reason || null, req.user.uid]);
      await c.query(`UPDATE consignments SET reserve_price=$1, sale_price=$2, updated_at=now() WHERE id=$3`,
        [newReserve, newSale, id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'price_adjusted',
        note: `卖家降价：上架价 ¥${money(con.sale_price)} → ¥${newSale}；底价 ¥${money(con.reserve_price)} → ¥${newReserve}；预估佣金 ¥${estCommission}，预估到手 ¥${estProceeds}（已扣仓储 ¥${signals.storageFeeTotal}/保险 ¥${signals.insuranceFeeTotal}）`,
        payload: { newSalePrice: newSale, newReservePrice: newReserve, estCommission },
      });
      // 通知收藏/议价买家降价
      const watchers = await c.query(
        `SELECT DISTINCT user_id FROM (
           SELECT user_id FROM favorites WHERE consignment_id=$1
           UNION SELECT buyer_id FROM offers WHERE consignment_id=$1
         ) t`, [id]);
      for (const w of watchers.rows) {
        await notify(c, { userId: w.user_id, title: `您关注的商品降价了（${con.code}）`,
          content: `${con.brand} ${con.model} 上架价由 ¥${money(con.sale_price)} 调整为 ¥${newSale}。`,
          category: 'order', linkType: 'consignment', linkId: id });
      }
      return rows[0];
    });
  });

  // ================= 卖家：撤回预检 =================
  fastify.post('/api/consignments/:id/withdraw-preview', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['ops', 'admin', 'cs'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可申请撤回');
      }
      if (con.locked) throw new HttpError(409, '商品已锁定（复鉴/争议处理中），不能撤回');
      if (!['shipped', 'received', 'authenticating', 'rejected_fake', 'authenticated', 'quoted', 'listed'].includes(con.status)) {
        throw new HttpError(409, `状态 ${con.status} 不支持撤回`);
      }
      const logisticsFee = money(b.returnLogisticsFee ?? 0);
      const signals = await marketSignals(c, id);
      const totalDeduction = money(signals.storageFeeTotal + signals.insuranceFeeTotal + logisticsFee);
      return {
        returnLogisticsFee: logisticsFee,
        totalDeduction,
        signals,
        willNotifyOffers: signals.activeOfferCount,
        willReleaseDeposit: signals.activeDepositTotal,
      };
    });
  });

  // ================= 卖家：确认撤回（核心） =================
  fastify.post('/api/consignments/:id/withdraw', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};

    // 保价/物流异议分支：不生成撤回/结算记录，沿用争议流程（无需撤回确认）
    const isLogisticsDispute = b.openLogisticsDispute === true;

    // 卖家确认门禁：必须显式提交布尔 true，且附非空确认文本；
    // 缺失、false、字符串 "true"/"false"、数字、空白文本一律拒绝。
    if (!isLogisticsDispute) {
      if (b.sellerConfirmation !== true || typeof b.sellerConfirmation !== 'boolean') {
        throw new HttpError(400, '必须由卖家显式确认（sellerConfirmation 须为布尔 true）后才能撤回');
      }
      const confirmText = typeof b.sellerConfirmationText === 'string' ? b.sellerConfirmationText.trim() : '';
      if (!confirmText) {
        throw new HttpError(400, '必须填写非空的卖家确认说明（sellerConfirmationText）后才能撤回');
      }
      b.sellerConfirmationText = confirmText;
      requireBody(b, ['returnCarrier', 'returnTracking']);
    }
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['ops', 'admin'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可申请撤回');
      }
      if (con.locked) throw new HttpError(409, '商品已锁定（复鉴/争议处理中），撤回请在案件中处理');
      if (!['shipped', 'received', 'authenticating', 'rejected_fake', 'authenticated', 'quoted', 'listed'].includes(con.status)) {
        throw new HttpError(409, `状态 ${con.status} 不可撤回`);
      }

      if (isLogisticsDispute) {
        // 保价/物流异议 → 走争议（复用既有争议编排），不生成撤回结算
        const dis = await openDispute(c, {
          consignment: con, order: null, opener: req.user, type: 'withdraw_logistics',
          summary: `卖家撤回时对退回保价/物流责任有异议：${b.reason || '未填'}`,
          extraEvidence: [],
        });
        return { disputed: true, disputeId: dis.id, status: 'disputed' };
      }

      const logisticsFee = money(b.returnLogisticsFee ?? 0);
      const signals = await marketSignals(c, id);

      // 1) 通知所有议价买家交易终止原因，并释放保证金
      let released = 0;
      for (const off of signals.activeOffers) {
        await c.query(
          `UPDATE offers SET status='released_for_withdraw', released_at=now() WHERE id=$1`, [off.id]);
        const dep = money(off.deposit_amount);
        if (dep > 0) {
          await ledger(c, { consignmentId: id, account: 'buyer', entryType: 'deposit_refund',
            direction: 'credit', amount: dep,
            evidenceRef: `offer:${off.code} 撤回释放保证金`, createdBy: req.user.uid });
          released = money(released + dep);
        }
        await notify(c, { userId: off.buyer_id, title: `议价终止：商品 ${con.code} 已被卖家撤回`,
          content: `商品 ${con.code} 已被卖家撤回，您对 ${con.brand} ${con.model} 的出价 ¥${money(off.offer_amount)} 交易终止。${dep ? `保证金 ¥${dep} 已原路释放。` : ''}终止原因：${b.reason || '卖家申请撤回'}`,
          category: 'order', linkType: 'consignment', linkId: id });
      }
      // 通知收藏买家
      if (signals.favoriteCount > 0) {
        const favs = await c.query(`SELECT DISTINCT user_id FROM favorites WHERE consignment_id=$1`, [id]);
        for (const f of favs.rows) {
          await notify(c, { userId: f.user_id, title: `您收藏的 ${con.code} 已下架（卖家撤回）`,
            content: `${con.brand} ${con.model} 因卖家撤回寄售终止销售。`, category: 'system' });
        }
      }
      // 活动报名取消
      await c.query(`UPDATE promo_enrollments SET status='cancelled' WHERE consignment_id=$1 AND status='enrolled'`, [id]);

      const totalDeduction = money(signals.storageFeeTotal + signals.insuranceFeeTotal + logisticsFee);

      // 2) 撤回记录（卖家确认）
      const { rows } = await c.query(
        `INSERT INTO seller_withdrawals
          (code,consignment_id,reason,return_carrier,return_tracking,return_logistics_fee,
           storage_fee_total,insurance_fee_total,notified_offer_count,released_deposit_total,
           favorite_count,enrollment_count,seller_confirmed,seller_confirmation,confirmed_by,confirmed_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14,now(),'confirmed') RETURNING *`,
        [genCode('WD'), id, b.reason || null, b.returnCarrier, b.returnTracking, logisticsFee,
         signals.storageFeeTotal, signals.insuranceFeeTotal, signals.activeOfferCount, released,
         signals.favoriteCount, signals.enrollmentCount,
         b.sellerConfirmationText || '卖家确认撤回并知悉仓储/保险/退回物流费用', req.user.uid]);
      const withdrawal = rows[0];

      // 3) 退回物流费入账（卖家承担）
      if (logisticsFee > 0) {
        await ledger(c, { consignmentId: id, account: 'seller', entryType: 'return_logistics_fee',
          direction: 'debit', amount: logisticsFee,
          evidenceRef: `withdrawal:${withdrawal.code} 退回物流费`, createdBy: req.user.uid });
      }

      // 4) 卖家结算单：仓储/保险/物流拆开
      const { rows: stRows } = await c.query(
        `INSERT INTO seller_settlements
          (code,consignment_id,withdrawal_id,seller_id,storage_fee,insurance_fee,
           return_logistics_fee,other_fee,total_deduction,deposit_released,detail_note,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,'issued') RETURNING *`,
        [genCode('ST'), id, withdrawal.id, con.seller_id,
         signals.storageFeeTotal, signals.insuranceFeeTotal, logisticsFee, totalDeduction, released,
         `卖家撤回结算：仓储费/保险费/退回物流费分项列示；议价保证金已原路退买家`]);
      const settlement = stRows[0];

      // 5) 寄卖单状态
      await c.query(
        `UPDATE consignments SET status='returning_seller', return_carrier=$1, return_tracking=$2, updated_at=now() WHERE id=$3`,
        [b.returnCarrier, b.returnTracking, id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'seller_withdrew', fromStatus: con.status, toStatus: 'returning_seller',
        note: `卖家撤回寄售：通知议价买家 ${signals.activeOfferCount} 人、释放保证金 ¥${released}；退回物流 ${b.returnCarrier}/${b.returnTracking}；结算单 ${settlement.code}（仓储 ¥${signals.storageFeeTotal} / 保险 ¥${signals.insuranceFeeTotal} / 物流 ¥${logisticsFee}）`,
        payload: { withdrawalId: withdrawal.id, settlementCode: settlement.code, releasedDeposit: released },
      });
      return { withdrawal, settlement, releasedDeposit: released };
    });
  });

  // 客服补充撤回说明
  fastify.post('/api/consignments/:id/withdraw-cs-note', { onRequest: auth }, async (req) => {
    if (!['cs', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅客服可添加说明');
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['csNote']);
    return tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE seller_withdrawals SET cs_note=$1, cs_user_id=$2
         WHERE id=(SELECT id FROM seller_withdrawals WHERE consignment_id=$3 ORDER BY id DESC LIMIT 1)
         RETURNING *`, [b.csNote, req.user.uid, id]);
      if (!rows[0]) throw new HttpError(404, '该寄卖单暂无撤回记录');
      await logEvent(c, { consignmentId: id, actor: req.user, type: 'withdraw_cs_note',
        note: `客服撤回说明：${b.csNote}` });
      return rows[0];
    });
  });

  // 撤回记录与结算单查询
  fastify.get('/api/consignments/:id/withdrawals', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !STAFF.includes(req.user.role)) throw new HttpError(403, '无权查看');
      const w = await c.query(
        `SELECT sw.*, cs.display_name AS cs_name, su.display_name AS confirmed_name
         FROM seller_withdrawals sw
         LEFT JOIN users cs ON cs.id=sw.cs_user_id
         LEFT JOIN users su ON su.id=sw.confirmed_by
         WHERE sw.consignment_id=$1 ORDER BY sw.id DESC`, [id]);
      return { items: w.rows };
    });
  });
  fastify.get('/api/consignments/:id/settlements', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !STAFF.includes(req.user.role)) throw new HttpError(403, '无权查看');
      const s = await c.query(`SELECT * FROM seller_settlements WHERE consignment_id=$1 ORDER BY id DESC`, [id]);
      return { items: s.rows };
    });
  });
  fastify.get('/api/consignments/:id/market-signals', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !STAFF.includes(req.user.role)) throw new HttpError(403, '无权查看');
      return marketSignals(c, id);
    });
  });
}
