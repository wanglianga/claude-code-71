import { query, tx } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, genCode, money, openDispute,
} from '../lib.js';

const STAFF = ['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'];

// 高价值阈值：达到即强制每次入库/出库/拍摄/发货/退回复核；表/珠宝/限量包升级双人鉴定
const HIGH_VALUE_THRESHOLD = 100000;

async function detail(id, client = null) {
  const exec = client ? (sql, p) => client.query(sql, p) : query;
  const c = await exec(
    `SELECT c.*, u.display_name AS seller_name FROM consignments c
     JOIN users u ON u.id=c.seller_id WHERE c.id=$1`, [id]);
  if (!c.rows[0]) throw new HttpError(404, '寄卖单不存在');
  const con = c.rows[0];
  const [auths, quotes, order, confirms, vaults, auctions] = await Promise.all([
    exec(`SELECT a.*, up.display_name AS primary_name, us.display_name AS second_name
           FROM authentications a
           JOIN users up ON up.id=a.primary_authenticator
           LEFT JOIN users us ON us.id=a.second_authenticator
           WHERE a.consignment_id=$1 ORDER BY a.round`, [id]),
    exec(`SELECT q.*, u.display_name AS created_by_name FROM quotes q
           JOIN users u ON u.id=q.created_by WHERE q.consignment_id=$1 ORDER BY q.id`, [id]),
    exec(`SELECT * FROM orders WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`, [id]),
    exec(`SELECT s.*, u.display_name AS confirmer_name FROM status_confirmations s
           JOIN users u ON u.id=s.confirmer_id WHERE s.consignment_id=$1 ORDER BY s.id`, [id]),
    exec(`SELECT v.*, uf.display_name AS from_name, ut.display_name AS to_name FROM vault_handovers v
           LEFT JOIN users uf ON uf.id=v.from_user_id LEFT JOIN users ut ON ut.id=v.to_user_id
           WHERE v.consignment_id=$1 ORDER BY v.id`, [id]),
    exec(`SELECT * FROM auction_transfers WHERE consignment_id=$1 ORDER BY id DESC`, [id]),
  ]);
  return {
    ...con,
    authentications: auths.rows,
    quotes: quotes.rows,
    order: order.rows[0] ?? null,
    confirmations: confirms.rows,
    vaultHandovers: vaults.rows,
    auctionTransfers: auctions.rows,
  };
}

export default async function consignmentRoutes(fastify) {
  const auth = [fastify.authenticate];

  // 列表（按角色过滤）
  fastify.get('/api/consignments', { onRequest: auth }, async (req) => {
    const u = req.user;
    const { status, q } = req.query;
    const params = [];
    let where = '1=1';
    if (u.role === 'seller') {
      params.push(u.uid); where = 'c.seller_id=$' + params.length;
    } else if (u.role === 'buyer') {
      where = `c.status IN ('listed') AND NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.consignment_id=c.id AND o.buyer_id=$1)`;
      params.push(u.uid);
    } else if (!STAFF.includes(u.role)) {
      throw new HttpError(403, '无权查看寄卖单');
    }
    if (status) { params.push(status); where += ` AND c.status=$${params.length}`; }
    if (q) { params.push(`%${q}%`); where += ` AND (c.brand ILIKE $${params.length} OR c.model ILIKE $${params.length} OR c.code ILIKE $${params.length})`; }
    const { rows } = await query(
      `SELECT c.id,c.code,c.category,c.brand,c.model,c.serial_no,c.expected_price,c.reserve_price,
              c.declared_value,c.high_value,c.authenticity,c.grade,c.sale_price,c.channel,c.status,
              c.limited_edition,c.dual_auth,c.vault_no,u.display_name AS seller_name,c.created_at
       FROM consignments c JOIN users u ON u.id=c.seller_id
       WHERE ${where} ORDER BY c.id DESC LIMIT 200`, params);
    return { items: rows };
  });

  fastify.get('/api/consignments/:id', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const u = req.user;
    const d = await detail(id);
    if (u.role === 'seller' && Number(d.seller_id) !== u.uid) throw new HttpError(403, '只能查看自己的寄卖单');
    if (u.role === 'buyer') {
      const mine = d.order && Number(d.order.buyer_id) === u.uid;
      if (!mine && d.status !== 'listed') throw new HttpError(403, '该商品当前不可见');
    }
    return d;
  });

  // 时间线（证据链）
  fastify.get('/api/consignments/:id/timeline', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT e.*, u.display_name AS actor_name FROM consignment_events e
       LEFT JOIN users u ON u.id=e.actor_id
       WHERE e.consignment_id=$1 ORDER BY e.id`, [id]);
    return { items: rows };
  });

  // 卖家创建寄卖单
  fastify.post('/api/consignments', { onRequest: auth }, async (req) => {
    const u = req.user;
    if (u.role !== 'seller' && u.role !== 'admin') throw new HttpError(403, '仅卖家可创建寄卖单');
    const b = req.body || {};
    requireBody(b, ['category', 'brand', 'model', 'declaredValue']);
    if (!['bag', 'watch', 'jewelry', 'fashion'].includes(b.category)) throw new HttpError(400, '品类不合法');
    const highValue = money(b.declaredValue) >= HIGH_VALUE_THRESHOLD || !!b.limitedEdition;
    return tx(async (c) => {
      const code = genCode('C');
      const { rows } = await c.query(
        `INSERT INTO consignments
          (code,seller_id,category,brand,model,serial_no,purchase_proof,accessories,flaw_photos,
           item_description,expected_price,reserve_price,declared_value,high_value,limited_edition)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [code, u.uid, b.category, b.brand, b.model, b.serialNo || null, b.purchaseProof || null,
         JSON.stringify(b.accessories || []), JSON.stringify(b.flawPhotos || []), b.description || null,
         b.expectedPrice ? money(b.expectedPrice) : null, b.reservePrice ? money(b.reservePrice) : null,
         money(b.declaredValue), highValue, !!b.limitedEdition]);
      const con = rows[0];
      await logEvent(c, {
        consignmentId: con.id, actor: { id: u.uid, role: u.role }, type: 'created',
        toStatus: 'drafted', note: b.note || `卖家创建${b.brand} ${b.model}寄卖单`,
        evidence: [b.purchaseProof, ...(b.flawPhotos || [])].filter(Boolean),
        payload: { highValue, dualRecommended: highValue || ['watch', 'jewelry'].includes(b.category) },
      });
      return detail(con.id, c);
    });
  });

  // 卖家寄出
  fastify.post('/api/consignments/:id/ship', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['carrier', 'tracking']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && req.user.role !== 'admin') throw new HttpError(403, '只能寄出自己的寄卖单');
      if (!['drafted', 'withdrawn'].includes(con.status)) throw new HttpError(409, `当前状态 ${con.status} 不可寄出`);
      await c.query(
        `UPDATE consignments SET status='shipped', inbound_carrier=$1, inbound_tracking=$2, updated_at=now() WHERE id=$3`,
        [b.carrier, b.tracking, id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'shipped', fromStatus: con.status, toStatus: 'shipped',
        note: `卖家交运：${b.carrier} / ${b.tracking}`, evidence: b.evidence || [],
        payload: { carrier: b.carrier, tracking: b.tracking },
      });
      return detail(id, c);
    });
  });

  // 仓库签收
  fastify.post('/api/consignments/:id/receive', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['warehouse', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅仓库可签收');
    const b = req.body || {};
    requireBody(b, ['conditionSummary']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (con.status !== 'shipped') throw new HttpError(409, `当前状态 ${con.status} 不可签收`);
      await c.query(`UPDATE consignments SET status='received', updated_at=now() WHERE id=$1`, [id]);
      await c.query(
        `INSERT INTO status_confirmations
           (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous,discrepancies)
         VALUES ($1,'inbound',$2,$3,$4,$5,$6,$7)`,
        [id, req.user.uid, b.conditionSummary, JSON.stringify(b.photos || []), b.videoUrl || null,
         b.matchesPrevious !== false, b.discrepancies || null]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'received', fromStatus: 'shipped', toStatus: 'received',
        note: `仓库签收·入库复核：${b.conditionSummary}${b.matchesPrevious === false ? '；与卖家描述存在差异：' + (b.discrepancies || '') : ''}`,
        evidence: [...(b.photos || []), b.videoUrl].filter(Boolean),
      });
      return detail(id, c);
    });
  });

  // 高价值商品状态复核（拍摄/出库/退回/发货）
  fastify.post('/api/consignments/:id/confirm', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['warehouse', 'admin', 'authenticator'].includes(req.user.role)) throw new HttpError(403, '仅仓库/鉴定可登记复核');
    const b = req.body || {};
    requireBody(b, ['checkpoint', 'conditionSummary']);
    if (!['inbound', 'photoshoot', 'outbound', 'shipping', 'return', 'vault_handover'].includes(b.checkpoint)) {
      throw new HttpError(400, '复核节点不合法');
    }
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      await c.query(
        `INSERT INTO status_confirmations
           (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous,discrepancies)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [id, b.checkpoint, req.user.uid, b.conditionSummary, JSON.stringify(b.photos || []), b.videoUrl || null,
         b.matchesPrevious !== false, b.discrepancies || null]);
      const warn = con.high_value ? '' : '（提示：该商品未标高价值，本次为额外复核）';
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'status_confirmed', note:
          `状态复核@${b.checkpoint}：${b.conditionSummary}${b.matchesPrevious === false ? '；发现差异：' + (b.discrepancies || '') : '；与上一节点状态一致'}${warn}`,
        evidence: [...(b.photos || []), b.videoUrl].filter(Boolean),
        payload: { checkpoint: b.checkpoint, matchesPrevious: b.matchesPrevious !== false },
      });
      return detail(id, c);
    });
  });

  // 保险箱交接（腕表/珠宝/限量包）
  fastify.post('/api/consignments/:id/vault-handover', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['warehouse', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅仓库可登记保险箱交接');
    const b = req.body || {};
    requireBody(b, ['vaultNo', 'direction', 'conditionNote']);
    if (!['in', 'out'].includes(b.direction)) throw new HttpError(400, 'direction 必须为 in/out');
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      const dual = !!b.dualSignoff;
      await c.query(
        `INSERT INTO vault_handovers
           (consignment_id,vault_no,direction,from_user_id,to_user_id,condition_note,evidence,dual_signoff)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, b.vaultNo, b.direction, b.fromUserId || null, b.toUserId || null,
         b.conditionNote, JSON.stringify(b.evidence || []), dual]);
      await c.query(
        `UPDATE consignments SET vault_no=$1, vault_ready=($2='in'), updated_at=now() WHERE id=$3`,
        [b.vaultNo, b.direction, id]);
      await c.query(
        `INSERT INTO status_confirmations
           (consignment_id,checkpoint,confirmer_id,condition_summary,photos,matches_previous)
         VALUES ($1,'vault_handover',$2,$3,$4,true)`,
        [id, req.user.uid, `保险箱${b.direction === 'in' ? '存入' : '取出'} ${b.vaultNo}：${b.conditionNote}`,
         JSON.stringify(b.evidence || [])]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'vault_handover',
        note: `保险箱${b.direction === 'in' ? '存入' : '取出'} ${b.vaultNo}${dual ? '（双人签字）' : ''}：${b.conditionNote}`,
        evidence: b.evidence || [], payload: { vaultNo: b.vaultNo, direction: b.direction, dualSignoff: dual },
      });
      return detail(id, c);
    });
  });

  // 运营上架（商城 / 直播）
  fastify.post('/api/consignments/:id/list', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅运营可上架');
    const b = req.body || {};
    const channel = b.channel || 'shop';
    if (!['shop', 'live', 'auction'].includes(channel)) throw new HttpError(400, '渠道不合法');
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (con.status !== 'quoted') throw new HttpError(409, `状态 ${con.status}，需卖家确认报价后上架`);
      const salePrice = b.salePrice ? money(b.salePrice) : money(con.sale_price);
      if (!salePrice) throw new HttpError(400, '缺少上架价');
      await c.query(
        `UPDATE consignments SET status='listed', channel=$1, sale_price=$2,
           live_session_id=$3, listed_at=now(), updated_at=now() WHERE id=$4`,
        [channel, salePrice, b.liveSessionId || null, id]);
      // 高价值商品上架前强制拍摄复核
      if (con.high_value) {
        await c.query(
          `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,matches_previous)
           VALUES ($1,'photoshoot',$2,$3,$4,true)`,
          [id, req.user.uid, b.photoshootSummary || '上架拍摄前状态复核：与鉴定时一致', JSON.stringify(b.photos || [])]);
      }
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'listed', fromStatus: 'quoted', toStatus: 'listed',
        note: `商品上架至${channel === 'live' ? '直播场' : channel === 'auction' ? '拍卖渠道' : '商城'}，售价 ¥${salePrice}`,
        evidence: b.photos || [], payload: { channel, salePrice, liveSessionId: b.liveSessionId || null },
      });
      return detail(id, c);
    });
  });

  // 拍卖渠道转单（腕表/珠宝/限量包）
  fastify.post('/api/consignments/:id/auction-transfer', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅运营可转拍卖');
    const b = req.body || {};
    requireBody(b, ['auctionHouse', 'estimateMin', 'estimateMax', 'reservePrice']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (!['quoted', 'listed'].includes(con.status)) throw new HttpError(409, '仅已报价/已上架商品可转拍卖');
      const { rows } = await c.query(
        `INSERT INTO auction_transfers
           (consignment_id,auction_house,estimate_min,estimate_max,reserve_price,status,note,created_by)
         VALUES ($1,$2,$3,$4,$5,'transferred',$6,$7) RETURNING *`,
        [id, b.auctionHouse, money(b.estimateMin), money(b.estimateMax), money(b.reservePrice), b.note || null, req.user.uid]);
      await c.query(`UPDATE consignments SET status='auction_transferred', channel='auction', updated_at=now() WHERE id=$1`, [id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'auction_transferred', fromStatus: con.status, toStatus: 'auction_transferred',
        note: `转至${b.auctionHouse}拍卖，估价 ¥${b.estimateMin}-${b.estimateMax}，保留价 ¥${b.reservePrice}`,
        payload: { transferId: rows[0].id },
      });
      return detail(id, c);
    });
  });

  // 卖家撤回寄卖（仓库必须重新确认保价与物流责任）
  fastify.post('/api/consignments/:id/withdraw', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (Number(con.seller_id) !== req.user.uid && !['admin', 'ops'].includes(req.user.role)) {
        throw new HttpError(403, '仅卖家本人可申请撤回');
      }
      if (['sold', 'shipping', 'delivered', 'aftersales', 'completed', 'returned_seller', 'auction_transferred'].includes(con.status)) {
        throw new HttpError(409, `状态 ${con.status} 不可撤回`);
      }
      // 退回前强制重新确认保价 + 物流责任，记录退回复核
      const { rows: insRows } = await c.query(
        `SELECT * FROM insurance_policies WHERE consignment_id=$1 AND status='active' ORDER BY id DESC LIMIT 1`, [id]);
      const policy = insRows[0];
      if (b.openLogisticsDispute) {
        // 保价/物流责任有异议 → 直接立案
        await openDispute(c, {
          consignment: con, opener: req.user, type: 'withdraw_logistics',
          summary: b.reason || '卖家撤回寄卖，对退回保价/物流责任存在异议',
          extraEvidence: [policy ? `insurance#${policy.id}(保价¥${policy.declared_value},阶段=${policy.coverage_stage})` : '无有效保价'],
        });
        return detail(id, c);
      }
      requireBody(b, ['returnCarrier', 'returnTracking']);
      await c.query(
        `UPDATE consignments SET status='returning_seller', return_carrier=$1, return_tracking=$2, updated_at=now() WHERE id=$3`,
        [b.returnCarrier, b.returnTracking, id]);
      await c.query(
        `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,matches_previous)
         VALUES ($1,'return',$2,$3,$4,COALESCE($5,true))`,
        [id, req.user.uid, b.conditionSummary || '撤回退回前状态复核：重新确认保价与物流责任，状态与在库一致',
         JSON.stringify(b.photos || []), b.matchesPrevious === false ? false : null]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'withdraw', fromStatus: con.status, toStatus: 'returning_seller',
        note: `卖家撤回，退回物流 ${b.returnCarrier}/${b.returnTracking}；保价 ¥${policy?.declared_value ?? con.declared_value} 已重新确认，物流责任随承运人回传`,
        evidence: [policy ? `insurance#${policy.id}` : null, ...(b.photos || [])].filter(Boolean),
        payload: { returnCarrier: b.returnCarrier, returnTracking: b.returnTracking, insuranceReconfirmed: !!policy },
      });
      return detail(id, c);
    });
  });

  // 仓库确认退回卖家签收
  fastify.post('/api/consignments/:id/return-complete', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['warehouse', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅仓库/运营可完结退回');
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (!['returning_seller', 'disputed'].includes(con.status)) throw new HttpError(409, '当前无进行中的退回');
      await c.query(`UPDATE consignments SET status='returned_seller', updated_at=now() WHERE id=$1`, [id]);
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'returned_seller', fromStatus: con.status, toStatus: 'returned_seller',
        note: '卖家已签收退回商品，寄卖终止',
      });
      return detail(id, c);
    });
  });
}
