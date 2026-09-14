import { query, tx } from '../db/pool.js';
import { HttpError, requireBody, logEvent, getConsignment, latestAuth, money } from '../lib.js';

const GRADES = ['N', 'S', 'A', 'B', 'C'];

export default async function authenticationRoutes(fastify) {
  const auth = [fastify.authenticate];

  // 某单全部鉴定记录
  fastify.get('/api/consignments/:id/authentications', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const { rows } = await query(
      `SELECT a.*, up.display_name AS primary_name, us.display_name AS second_name
       FROM authentications a
       JOIN users up ON up.id=a.primary_authenticator
       LEFT JOIN users us ON us.id=a.second_authenticator
       WHERE a.consignment_id=$1 ORDER BY a.round`, [id]);
    return { items: rows };
  });

  // 鉴定师绩效
  fastify.get('/api/authenticators/performance', { onRequest: auth }, async (req) => {
    if (!['admin', 'ops', 'authenticator'].includes(req.user.role)) throw new HttpError(403, '无权查看鉴定绩效');
    const { rows } = await query(
      `SELECT u.id, u.display_name, u.specialty,
              COUNT(a.id)                                          AS total,
              COUNT(*) FILTER (WHERE a.is_final)                   AS finalized,
              COUNT(*) FILTER (WHERE a.result='authentic' AND a.is_final) AS authentic_cnt,
              COUNT(*) FILTER (WHERE a.result='fake' AND a.is_final)      AS fake_cnt,
              COUNT(*) FILTER (WHERE a.result='suspicious' AND a.is_final) AS suspicious_cnt,
              COUNT(*) FILTER (WHERE a.second_authenticator IS NOT NULL)  AS dual_cnt,
              COUNT(a.overturned OR NULL)                          AS overturned_by_reauth,
              (SELECT COUNT(*) FROM authentications a0
                 WHERE a0.primary_authenticator=u.id AND a0.round=1
                   AND EXISTS (SELECT 1 FROM authentications ax
                               WHERE ax.consignment_id=a0.consignment_id
                                 AND ax.round>a0.round AND ax.overturned=TRUE)) AS initial_overturned,
              (SELECT COUNT(*) FROM reauth_reviews rr
                 WHERE rr.initial_authenticator=u.id
                   AND rr.responsibility='initial_error') AS confirmed_errors
       FROM users u
       LEFT JOIN authentications a ON a.primary_authenticator=u.id
       WHERE u.role='authenticator'
       GROUP BY u.id ORDER BY initial_overturned DESC, total DESC`);
    return { items: rows };
  });

  // 提交鉴定（初鉴 / 双人 / 复鉴）
  fastify.post('/api/consignments/:id/authenticate', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['authenticator', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅鉴定师可提交鉴定');
    const b = req.body || {};
    requireBody(b, ['result', 'grade', 'summary']);
    if (!['authentic', 'fake', 'suspicious'].includes(b.result)) throw new HttpError(400, '鉴定结论不合法');
    if (!GRADES.includes(b.grade)) throw new HttpError(400, `成色等级须为 ${GRADES.join('/')}`);

    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (!['received', 'authenticating', 'disputed'].includes(con.status) && !(con.status === 'authenticated' && b.round)) {
        throw new HttpError(409, `当前状态 ${con.status} 不可鉴定`);
      }
      const prev = await latestAuth(c, id);
      const isReauth = !!prev && (b.isReauth || (con.status === 'disputed'));
      const round = isReauth ? prev.round + 1 : (prev ? prev.round + 1 : 1);

      // 高价值（表/珠宝/限量包/保价≥10w）强制双人鉴定
      const dualRequired = con.high_value || ['watch', 'jewelry'].includes(con.category) || con.limited_edition;
      let secondId = b.secondAuthenticatorId ? Number(b.secondAuthenticatorId) : null;
      const dual = !!secondId;
      if (dualRequired && !isReauth && !dual) {
        throw new HttpError(422, '该腕表/珠宝/限量包或高价值商品须执行双人鉴定，请指定第二鉴定师');
      }
      if (dual && secondId === req.user.uid) throw new HttpError(400, '第二鉴定师不能与主鉴人相同');
      if (dual) {
        const { rows } = await c.query(`SELECT role FROM users WHERE id=$1`, [secondId]);
        if (!rows[0] || rows[0].role !== 'authenticator') throw new HttpError(400, '第二鉴定师不合法');
      }

      const overturned = isReauth && prev && prev.result !== b.result;
      const { rows: ins } = await c.query(
        `INSERT INTO authentications
          (consignment_id,round,is_final,primary_authenticator,second_authenticator,result,grade,
           serial_check,hardware_check,leather_check,stitching_check,movement_check,receipt_check,
           case_history,summary,evidence,overturned,finalized_at)
         VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now()) RETURNING *`,
        [id, round, req.user.uid, secondId, b.result, b.grade,
         b.serialCheck || null, b.hardwareCheck || null, b.leatherCheck || null,
         b.stitchingCheck || null, b.movementCheck || null, b.receiptCheck || null,
         b.caseHistory || null, b.summary, JSON.stringify(b.evidence || []), overturned]);

      // 同步寄卖单结论
      if (b.result === 'fake') {
        await c.query(`UPDATE consignments SET status='rejected_fake', authenticity='fake', grade=$1,
                        dual_auth=$2, updated_at=now() WHERE id=$3`, [b.grade, dual || con.dual_auth, id]);
      } else if (b.result === 'suspicious') {
        await c.query(`UPDATE consignments SET status='authenticating', authenticity='suspicious',
                        dual_auth=$2, updated_at=now() WHERE id=$3`, [b.grade, dual || con.dual_auth, id]);
      } else {
        await c.query(`UPDATE consignments SET status='authenticated', authenticity='authentic', grade=$1,
                        dual_auth=$2, updated_at=now() WHERE id=$3`, [b.grade, dual || con.dual_auth, id]);
      }

      await logEvent(c, {
        consignmentId: id, actor: req.user,
        type: isReauth ? 'reauthenticated' : 'authenticated',
        fromStatus: con.status,
        toStatus: b.result === 'fake' ? 'rejected_fake' : b.result === 'suspicious' ? 'authenticating' : 'authenticated',
        note: isReauth
          ? `第${round}轮复鉴结论：${b.result} / ${b.grade}${overturned ? `，⚠️ 已推翻第${prev.round}轮初鉴（${prev.result}）` : '，维持初鉴'}${dual ? '（双人鉴定）' : ''}`
          : `第1轮初鉴结论：${b.result} / ${b.grade}${dual ? '（双人鉴定）' : ''}：${b.summary}`,
        evidence: b.evidence || [],
        payload: { round, result: b.result, grade: b.grade, dual, overturned,
                   secondAuthenticatorId: secondId },
      });
      return ins[0];
    });
  });
}
