import { query, tx } from '../db/pool.js';
import { HttpError, requireBody, logEvent, getConsignment, money, ledger } from '../lib.js';

const STAFF = ['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'];

export default async function adminRoutes(fastify) {
  const auth = [fastify.authenticate];

  // ---- 看板统计 ----
  fastify.get('/api/dashboard', { onRequest: auth }, async (req) => {
    if (!STAFF.includes(req.user.role)) throw new HttpError(403, '仅内部人员可查看看板');
    const [{ rows: stat }, { rows: byStatus }, { rows: fin }, { rows: dis }] = await Promise.all([
      query(`SELECT
        COUNT(*) FILTER (WHERE status='listed') AS listed,
        COUNT(*) FILTER (WHERE status='disputed') AS disputed,
        COUNT(*) FILTER (WHERE high_value) AS high_value,
        COUNT(*) FILTER (WHERE dual_auth) AS dual_authed,
        COUNT(*) AS total FROM consignments`),
      query(`SELECT status, COUNT(*)::int AS n FROM consignments GROUP BY status ORDER BY n DESC`),
      query(`SELECT account, entry_type, direction, SUM(amount)::float AS total
             FROM financial_ledger GROUP BY account,entry_type,direction ORDER BY account`),
      query(`SELECT status, type, COUNT(*)::int AS n FROM disputes GROUP BY status,type ORDER BY status`),
    ]);
    return { stats: stat[0], byStatus, finance: fin, disputes: dis };
  });

  // ---- 用户 / 鉴定师名册（双人鉴定选人用） ----
  fastify.get('/api/users', { onRequest: auth }, async (req) => {
    if (!STAFF.includes(req.user.role)) throw new HttpError(403, '仅内部人员可查看名册');
    const role = req.query.role;
    const params = [];
    let where = '1=1';
    if (role) { params.push(role); where = 'role=$1'; }
    const { rows } = await query(
      `SELECT id,username,display_name,role,specialty,blacklisted,blacklist_reason
       FROM users WHERE ${where} ORDER BY role,id`, params);
    return { items: rows };
  });

  // 黑名单管理
  fastify.post('/api/users/:id/blacklist', { onRequest: auth }, async (req) => {
    if (!['admin', 'cs', 'ops'].includes(req.user.role)) throw new HttpError(403, '无权操作黑名单');
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['reason']);
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM users WHERE id=$1`, [id]);
      if (!rows[0]) throw new HttpError(404, '用户不存在');
      await c.query(`UPDATE users SET blacklisted=TRUE, blacklist_reason=$1 WHERE id=$2`, [b.reason, id]);
      await c.query(`INSERT INTO blacklist_log (user_id,reason,created_by) VALUES ($1,$2,$3)`,
        [id, b.reason, req.user.uid]);
      return { ok: true };
    });
  });

  fastify.post('/api/users/:id/unblacklist', { onRequest: auth }, async (req) => {
    if (!['admin', 'cs'].includes(req.user.role)) throw new HttpError(403, '无权操作黑名单');
    const id = Number(req.params.id);
    await query(`UPDATE users SET blacklisted=FALSE, blacklist_reason=NULL WHERE id=$1`, [id]);
    return { ok: true };
  });

  // ---- 质检标准 ----
  fastify.get('/api/quality-standards', { onRequest: auth }, async () => {
    const { rows } = await query(
      `SELECT q.*, u.display_name AS updated_by_name FROM quality_standards q
       LEFT JOIN users u ON u.id=q.updated_by WHERE active=TRUE ORDER BY category,id`);
    return { items: rows };
  });

  fastify.put('/api/quality-standards/:id', { onRequest: auth }, async (req) => {
    if (!['admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅管理员/运营可改质检标准');
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['gradeRules']);
    const { rows } = await query(
      `UPDATE quality_standards SET grade_rules=$1, updated_by=$2, updated_at=now()
       WHERE id=$3 RETURNING *`, [JSON.stringify(b.gradeRules), req.user.uid, id]);
    if (!rows[0]) throw new HttpError(404, '质检标准不存在');
    return rows[0];
  });

  // ---- 保险保价 ----
  fastify.get('/api/consignments/:id/insurance', { onRequest: auth }, async (req) => {
    const { rows } = await query(
      `SELECT * FROM insurance_policies WHERE consignment_id=$1 ORDER BY id DESC`, [Number(req.params.id)]);
    return { items: rows };
  });

  fastify.post('/api/consignments/:id/insurance', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['finance', 'warehouse', 'ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅财务/仓库可登记保价');
    const b = req.body || {};
    requireBody(b, ['declaredValue', 'premium']);
    return tx(async (c) => {
      const con = await getConsignment(c, id);
      const { rows } = await c.query(
        `INSERT INTO insurance_policies (consignment_id,declared_value,premium,coverage_stage,note)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, money(b.declaredValue), money(b.premium), b.coverageStage || 'all', b.note || null]);
      await c.query(`UPDATE consignments SET declared_value=$1 WHERE id=$2`, [money(b.declaredValue), id]);
      await ledger(c, { consignmentId: id, account: 'seller', entryType: 'insurance_premium',
        direction: 'debit', amount: b.premium, evidenceRef: `insurance#${rows[0].id}`, createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'insured',
        note: `登记保险保价 ¥${b.declaredValue}，保费 ¥${b.premium}，覆盖阶段：${b.coverageStage || 'all'}${b.note ? '；' + b.note : ''}`,
        payload: { policyId: rows[0].id, declaredValue: money(b.declaredValue), premium: money(b.premium) },
      });
      return rows[0];
    });
  });

  // 保险理赔登记（非争议情形）
  fastify.post('/api/insurance/:id/claim', { onRequest: auth }, async (req) => {
    if (!['finance', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅财务可登记理赔');
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['claimAmount']);
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM insurance_policies WHERE id=$1`, [id]);
      const p = rows[0];
      if (!p) throw new HttpError(404, '保单不存在');
      await c.query(`UPDATE insurance_policies SET status='settled', claim_amount=$1, note=$2 WHERE id=$3`,
        [money(b.claimAmount), b.note || '理赔结案', id]);
      await ledger(c, { consignmentId: p.consignment_id, account: 'insurance', entryType: 'insurance_claim',
        direction: 'debit', amount: b.claimAmount, evidenceRef: `insurance#${id} claim`, createdBy: req.user.uid });
      await logEvent(c, {
        consignmentId: p.consignment_id, actor: req.user, type: 'insurance_claimed',
        note: `保险理赔到账 ¥${b.claimAmount}（保单 #${id}）${b.note ? '：' + b.note : ''}`,
        payload: { policyId: id, claimAmount: money(b.claimAmount) },
      });
      return { ok: true };
    });
  });

  // ---- 直播 ----
  fastify.get('/api/live-sessions', { onRequest: auth }, async () => {
    const { rows } = await query(
      `SELECT l.*, COUNT(c.id)::int AS consignment_count
       FROM live_sessions l LEFT JOIN consignments c ON c.live_session_id=l.id AND c.channel='live'
       GROUP BY l.id ORDER BY l.id DESC`);
    return { items: rows };
  });

  fastify.post('/api/live-sessions', { onRequest: auth }, async (req) => {
    if (!['ops', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅运营可创建直播场');
    const b = req.body || {};
    requireBody(b, ['title', 'host']);
    const { rows } = await query(
      `INSERT INTO live_sessions (title,host,status) VALUES ($1,$2,COALESCE($3,'scheduled')) RETURNING *`,
      [b.title, b.host, b.status || 'scheduled']);
    return rows[0];
  });

  // ---- 财务台账 ----
  fastify.get('/api/ledger', { onRequest: auth }, async (req) => {
    if (!['finance', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅财务可查看台账');
    const { consignmentId, disputeId } = req.query;
    const params = [];
    const conds = [];
    if (consignmentId) { params.push(Number(consignmentId)); conds.push(`l.consignment_id=$${params.length}`); }
    if (disputeId) { params.push(Number(disputeId)); conds.push(`l.dispute_id=$${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await query(
      `SELECT l.*, u.display_name AS created_by_name, c.code AS consignment_code, d.code AS dispute_code, o.code AS order_code
       FROM financial_ledger l
       LEFT JOIN users u ON u.id=l.created_by
       LEFT JOIN consignments c ON c.id=l.consignment_id
       LEFT JOIN disputes d ON d.id=l.dispute_id
       LEFT JOIN orders o ON o.id=l.order_id
       ${where} ORDER BY l.id DESC LIMIT 300`, params);
    return { items: rows };
  });

  // ---- 仓储费账单查询 ----
  fastify.get('/api/consignments/:id/storage-bills', { onRequest: auth }, async (req) => {
    const { rows } = await query(
      `SELECT s.*, u.display_name AS billed_by_name FROM storage_fee_bills s
       JOIN users u ON u.id=s.billed_by WHERE s.consignment_id=$1 ORDER BY s.id`, [Number(req.params.id)]);
    return { items: rows };
  });
}
