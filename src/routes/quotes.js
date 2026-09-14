import { tx } from '../db/pool.js';
import { HttpError, requireBody, logEvent, getConsignment, latestAuth, money, ledger } from '../lib.js';

export default async function quoteRoutes(fastify) {
  const auth = [fastify.authenticate];

  // 报价试算（不落库）：根据鉴定结论、市场成交价、佣金、卖家底价计算
  fastify.post('/api/consignments/:id/quote/preview', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['ops', 'admin', 'finance'].includes(req.user.role)) throw new HttpError(403, '仅运营/财务可试算报价');
    const b = req.body || {};
    requireBody(b, ['marketPrice', 'commissionRate', 'reservePrice']);
    const storageFee = money(b.storageFee ?? 0);
    const insuranceFee = money(b.insuranceFee ?? 0);
    const market = money(b.marketPrice);
    const rate = Number(b.commissionRate);
    if (rate < 0 || rate > 0.5) throw new HttpError(400, '佣金费率应在 0-50% 之间');
    // 建议上架价：市场成交价 × 1.02，且不低于底价 / (1-佣金)
    let salePrice = money(market * (b.markup ? Number(b.markup) : 1.02));
    const floor = money(money(b.reservePrice) / (1 - rate));
    if (salePrice < floor) salePrice = floor;
    const commission = money(salePrice * rate);
    const sellerProceeds = money(salePrice - commission - storageFee - insuranceFee);
    return { marketPrice: market, commissionRate: rate, commission, storageFee, insuranceFee,
             reservePrice: money(b.reservePrice), salePrice, sellerProceeds };
  });

  // 运营生成寄卖报价
  fastify.post('/api/consignments/:id/quote', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅运营可生成报价');
    const b = req.body || {};
    requireBody(b, ['marketPrice', 'commissionRate', 'reservePrice', 'salePrice', 'sellerProceeds']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (!['authenticated', 'quoted'].includes(con.status)) throw new HttpError(409, `状态 ${con.status}，须鉴定为真后才能报价`);
      const auth = await latestAuth(c, id);
      if (!auth || auth.result !== 'authentic') throw new HttpError(409, '缺少“正品”鉴定结论，不能报价');
      const { rows } = await c.query(
        `INSERT INTO quotes
           (consignment_id,market_price,commission_rate,storage_fee,insurance_fee,reserve_price,
            sale_price,seller_proceeds,quote_note,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, money(b.marketPrice), Number(b.commissionRate), money(b.storageFee ?? 0), money(b.insuranceFee ?? 0),
         money(b.reservePrice), money(b.salePrice), money(b.sellerProceeds), b.quoteNote || null, req.user.uid]);
      await c.query(
        `UPDATE consignments SET status='quoted', reserve_price=$1, sale_price=$2, updated_at=now() WHERE id=$3`,
        [money(b.reservePrice), money(b.salePrice), id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'quoted', fromStatus: 'authenticated', toStatus: 'quoted',
        note: `运营生成报价：市场价 ¥${b.marketPrice}，佣金 ${Number(b.commissionRate) * 100}%，建议售价 ¥${b.salePrice}，预计卖家到手 ¥${b.sellerProceeds}（仓储 ¥${b.storageFee ?? 0} / 保价 ¥${b.insuranceFee ?? 0}）`,
        payload: { quoteId: rows[0].id },
      });
      return rows[0];
    });
  });

  // 卖家接受 / 拒绝报价
  fastify.post('/api/consignments/:id/quote/:quoteId/respond', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const quoteId = Number(req.params.quoteId);
    const b = req.body || {};
    requireBody(b, ['accept']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && req.user.role !== 'admin') throw new HttpError(403, '仅卖家本人可回复报价');
      if (con.status !== 'quoted') throw new HttpError(409, '当前没有待确认的报价');
      const { rows } = await c.query(`SELECT * FROM quotes WHERE id=$1 AND consignment_id=$2`, [quoteId, id]);
      const quote = rows[0];
      if (!quote) throw new HttpError(404, '报价不存在');
      if (quote.seller_accepted !== null) throw new HttpError(409, '该报价已被回复');
      const accept = !!b.accept;
      await c.query(`UPDATE quotes SET seller_accepted=$1, seller_reply=$2 WHERE id=$3`,
        [accept, b.reply || (accept ? '卖家接受报价' : '卖家拒绝报价'), quoteId]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: accept ? 'quote_accepted' : 'quote_rejected',
        note: accept ? '卖家接受报价，等待运营上架' : `卖家拒绝报价：${b.reply || ''}`,
        payload: { quoteId, accept },
      });
      if (!accept) {
        // 拒绝后保留在 quoted 状态等运营重新报价
      }
      return { accepted: accept };
    });
  });

  // 仓储费账单
  fastify.post('/api/consignments/:id/storage-bill', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['finance', 'warehouse', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅财务/仓库可计仓储费');
    const b = req.body || {};
    requireBody(b, ['days', 'dailyRate']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      const amount = money(Number(b.days) * Number(b.dailyRate));
      const { rows } = await c.query(
        `INSERT INTO storage_fee_bills (consignment_id,days,daily_rate,amount,billed_by,note)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, Number(b.days), money(b.dailyRate), amount, req.user.uid, b.note || null]);
      await ledger(c, { consignmentId: id, account: 'seller', entryType: 'storage_fee',
        direction: 'debit', amount, evidenceRef: `storage-bill#${rows[0].id}`, createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'storage_billed',
        note: `计提仓储费：${b.days}天 × ¥${b.dailyRate}/天 = ¥${amount}${b.note ? '（' + b.note + '）' : ''}`,
        payload: { billId: rows[0].id, amount },
      });
      return rows[0];
    });
  });
}
