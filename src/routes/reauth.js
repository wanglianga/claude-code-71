import { query, tx } from '../db/pool.js';
import {
  HttpError, requireBody, logEvent, getConsignment, getOrder,
  latestAuth, genCode, money, notify, diffAuthentications, openDispute,
} from '../lib.js';

const GRADES = ['N', 'S', 'A', 'B', 'C'];
const RESULT_TXT = { authentic: '正品', fake: '假冒', suspicious: '存疑' };
const STAFF = ['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'];

async function reviewDetail(client, id) {
  const r = await client.query(
    `SELECT rr.*, c.code AS consignment_code, c.brand, c.model, c.category, c.high_value,
            c.locked, c.lock_reason, c.seller_id,
            o.code AS order_code, o.buyer_id, o.amount AS order_amount, o.status AS order_status,
            o.settlement_paused,
            ui.display_name AS initial_auth_name, ur.display_name AS reauth_name,
            us.display_name AS seller_name, ub.display_name AS buyer_name,
            uv.display_name AS reviewer_name, d.code AS dispute_code
     FROM reauth_reviews rr
     JOIN consignments c ON c.id=rr.consignment_id
     JOIN users ui ON ui.id=rr.initial_authenticator
     JOIN users ur ON ur.id=rr.reauthenticator
     JOIN users us ON us.id=c.seller_id
     LEFT JOIN orders o ON o.id=rr.order_id
     LEFT JOIN users ub ON ub.id=o.buyer_id
     LEFT JOIN users uv ON uv.id=rr.reviewer_id
     LEFT JOIN disputes d ON d.id=rr.dispute_id
     WHERE rr.id=$1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, '复鉴案件不存在');
  const rr = r.rows[0];
  const [audits, kb] = await Promise.all([
    client.query(
      `SELECT ba.*, u.display_name AS authenticator_name, rv.display_name AS reviewer_name,
              cc.code AS consignment_code
       FROM brand_audits ba
       JOIN users u ON u.id=ba.authenticator_id
       LEFT JOIN users rv ON rv.id=ba.reviewer_id
       LEFT JOIN consignments cc ON cc.id=ba.consignment_id
       WHERE ba.triggered_by_reauth_id=$1 ORDER BY ba.id`, [id]),
    client.query(
      `SELECT * FROM brand_knowledge WHERE brand ILIKE $1 ORDER BY id DESC LIMIT 10`, [rr.brand]),
  ]);
  return { ...rr, audits: audits.rows, knowledge: kb.rows };
}

export default async function reauthRoutes(fastify) {
  const auth = [fastify.authenticate];

  // ---------- 发起复鉴（推翻时自动编排锁货/暂停/案件/通知/抽查） ----------
  fastify.post('/api/consignments/:id/reauth', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['authenticator', 'admin'].includes(req.user.role)) throw new HttpError(403, '仅鉴定师可发起复鉴');
    const b = req.body || {};
    requireBody(b, ['result', 'grade', 'summary']);
    if (!['authentic', 'fake', 'suspicious'].includes(b.result)) throw new HttpError(400, '鉴定结论不合法');
    if (!GRADES.includes(b.grade)) throw new HttpError(400, `成色等级须为 ${GRADES.join('/')}`);

    return tx(async (c) => {
      const con = await getConsignment(c, id);
      if (con.locked) throw new HttpError(409, `商品已被锁定（${con.lock_reason || '复鉴/争议处理中'}），不能再次复鉴`);
      const prev = await latestAuth(c, id);
      if (!prev) throw new HttpError(409, '缺少初鉴记录，不能复鉴');
      const round = prev.round + 1;

      const { rows: ins } = await c.query(
        `INSERT INTO authentications
          (consignment_id,round,is_final,primary_authenticator,second_authenticator,result,grade,
           serial_check,hardware_check,leather_check,stitching_check,movement_check,receipt_check,
           case_history,summary,evidence,overturned,finalized_at)
         VALUES ($1,$2,true,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                 ($16<>$17 OR COALESCE($18,'')<>COALESCE($19,'')),now()) RETURNING *`,
        [id, round, req.user.uid, b.secondAuthenticatorId || null, b.result, b.grade,
         b.serialCheck || null, b.hardwareCheck || null, b.leatherCheck || null,
         b.stitchingCheck || null, b.movementCheck || null, b.receiptCheck || null,
         b.caseHistory || null, b.summary, JSON.stringify(b.evidence || []),
         b.result, prev.result, b.grade, prev.grade]);
      const reauth = ins[0];
      const overturned = reauth.overturned;

      // 同步寄卖单鉴定结论
      await c.query(
        `UPDATE consignments SET authenticity=$1, grade=$2, updated_at=now() WHERE id=$3`,
        [b.result, b.grade, id]);

      if (!overturned) {
        // 复鉴维持初鉴
        await logEvent(c, {
          consignmentId: id, actor: req.user, type: 'reauthenticated',
          note: `第${round}轮复鉴维持初鉴：${RESULT_TXT[b.result]}/${b.grade}`,
          evidence: b.evidence || [], payload: { round, overturned: false },
        });
        return { overturned: false, authentication: reauth, reviewId: null };
      }

      // ===== 推翻初鉴：锁定商品、暂停结算、立案、通知、抽查 =====
      const diff = diffAuthentications(prev, reauth);
      const orderRows = await c.query(`SELECT * FROM orders WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`, [id]);
      const order = orderRows.rows[0] ?? null;
      const sold = !!order && ['placed', 'shipping', 'delivered'].includes(order.status);

      // 1) 锁货 + 暂停结算
      const lockReason = `第${round}轮复鉴推翻第${prev.round}轮初鉴（${RESULT_TXT[prev.result]}/${prev.grade || '—'}→${RESULT_TXT[b.result]}/${b.grade}）`;
      await c.query(
        `UPDATE consignments SET locked=TRUE, lock_reason=$1, status='disputed', updated_at=now() WHERE id=$2`,
        [lockReason, id]);
      if (sold) {
        await c.query(
          `UPDATE orders SET settlement_paused=TRUE, settlement_pause_reason=$1 WHERE id=$2`,
          [lockReason, order.id]);
      }

      // 2) 建立或关联争议（买家先立案的情形 → 同一争议处理）
      let disputeId = null;
      const existDispute = await c.query(
        `SELECT id FROM disputes WHERE consignment_id=$1 AND status IN ('opened','investigating')
         ORDER BY id DESC LIMIT 1`, [id]);
      if (existDispute.rows[0]) {
        disputeId = existDispute.rows[0].id;
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
           VALUES ($1,$2,'authenticator',$3,$4)`,
          [disputeId, req.user.uid,
            `【复鉴推翻初鉴】${lockReason}\n两次鉴定差异：\n${diff}\n商品已锁定${sold ? '、订单结算已暂停，待买家选择退款方案' : ''}。`,
            JSON.stringify(b.evidence || [])]);
      } else {
        const dis = await openDispute(c, {
          consignment: con, order, opener: req.user, type: 'reauth_overturn',
          summary: `平台复鉴推翻初鉴：${lockReason}`,
          extraEvidence: [...(b.evidence || []), `reauth-round-${round}`],
        });
        disputeId = dis.id;
      }

      // 3) 复鉴案件
      const code = genCode('RR');
      const { rows: rrRows } = await c.query(
        `INSERT INTO reauth_reviews
          (code,consignment_id,order_id,dispute_id,initial_auth_id,reauth_id,brand,
           authenticity_changed,grade_changed,initial_authenticator,reauthenticator,
           initial_summary,reauth_summary,difference_detail,buyer_choice,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                 CASE WHEN $15 THEN 'pending' ELSE NULL END,
                 CASE WHEN $15 THEN 'awaiting_buyer' ELSE 'opened' END)
         RETURNING *`,
        [code, id, order?.id ?? null, disputeId, prev.id, reauth.id, con.brand,
         b.result !== prev.result, b.grade !== prev.grade, prev.primary_authenticator, req.user.uid,
         prev.summary, b.summary, diff, sold]);
      const review = rrRows[0];

      // 4) 通知
      await notify(c, {
        userId: prev.primary_authenticator,
        title: `您的初鉴被复鉴推翻（${con.code}）`,
        content: `${lockReason}\n差异：\n${diff}\n请在复鉴案件 ${code} 中提交鉴定说明并参加责任复盘。`,
        category: 'reauth', linkType: 'reauth_review', linkId: review.id,
      });
      await notify(c, {
        userId: con.seller_id,
        title: `您的寄卖商品复鉴结论变更（${con.code}）`,
        content: `${lockReason}。商品已锁定，争议案件处理中，结算暂停。`,
        category: 'reauth', linkType: 'consignment', linkId: id,
      });
      if (sold) {
        await notify(c, {
          userId: order.buyer_id,
          title: `重要：您购买的商品复鉴结论变更，请选择处理方案（订单 ${order.code}）`,
          content: `平台复鉴发现该商品${b.result !== prev.result ? `真伪结论由「${RESULT_TXT[prev.result]}」变更为「${RESULT_TXT[b.result]}」` : ''}${b.grade !== prev.grade ? `，成色由 ${prev.grade} 调整为 ${b.grade}` : ''}。货款结算已暂停。请在复鉴案件 ${code} 中选择：①全额退款退货 ②保留商品并申请赔付/让佣。`,
          category: 'reauth', linkType: 'reauth_review', linkId: review.id,
        });
      }

      // 5) 触发同品牌近期鉴定抽查（近 90 天、初鉴为真、未抽查过的记录）
      const candidates = await c.query(
        `SELECT a.id AS auth_id, a.consignment_id, a.primary_authenticator, c.category
         FROM authentications a
         JOIN consignments c ON c.id=a.consignment_id
         WHERE a.round=1 AND a.is_final=TRUE AND a.result='authentic'
           AND c.brand ILIKE $1 AND c.id<>$2 AND a.created_at > now() - interval '90 days'
           AND NOT EXISTS (SELECT 1 FROM brand_audits ba WHERE ba.initial_auth_id=a.id)
         ORDER BY a.created_at DESC LIMIT 5`,
        [con.brand, id]);
      for (const cand of candidates.rows) {
        const baCode = genCode('BA');
        await c.query(
          `INSERT INTO brand_audits
             (code,brand,category,triggered_by_reauth_id,consignment_id,authenticator_id,initial_auth_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [baCode, con.brand, cand.category, review.id, cand.consignment_id,
           cand.primary_authenticator, cand.auth_id]);
      }

      await logEvent(c, {
        consignmentId: id, actor: req.user, type: 'reauth_overturned',
        fromStatus: con.status, toStatus: 'disputed',
        note: `⚠️ 复鉴推翻初鉴并启动闭环：商品锁定${sold ? '、订单结算暂停、待买家选择' : ''}、案件 ${code}、同品牌抽查 ${candidates.rowCount} 单`,
        evidence: b.evidence || [],
        payload: { reviewId: review.id, disputeId, sold, auditCount: candidates.rowCount,
                   authenticityChanged: b.result !== prev.result, gradeChanged: b.grade !== prev.grade },
      });

      return { overturned: true, review: await reviewDetail(c, review.id) };
    });
  });

  // ---------- 复鉴案件列表 ----------
  fastify.get('/api/reauth-reviews', { onRequest: auth }, async (req) => {
    const u = req.user;
    if (STAFF.includes(u.role)) {
      const { rows } = await query(
        `SELECT rr.*, c.code AS consignment_code, c.brand, c.model, c.locked,
                o.code AS order_code, ui.display_name AS initial_auth_name,
                ur.display_name AS reauth_name
         FROM reauth_reviews rr
         JOIN consignments c ON c.id=rr.consignment_id
         JOIN users ui ON ui.id=rr.initial_authenticator
         JOIN users ur ON ur.id=rr.reauthenticator
         LEFT JOIN orders o ON o.id=rr.order_id
         ORDER BY rr.id DESC LIMIT 200`);
      return { items: rows };
    }
    const { rows } = await query(
      `SELECT rr.*, c.code AS consignment_code, c.brand, c.model, c.locked,
              o.code AS order_code, ui.display_name AS initial_auth_name,
              ur.display_name AS reauth_name
       FROM reauth_reviews rr
       JOIN consignments c ON c.id=rr.consignment_id
       JOIN users ui ON ui.id=rr.initial_authenticator
       JOIN users ur ON ur.id=rr.reauthenticator
       LEFT JOIN orders o ON o.id=rr.order_id
       WHERE c.seller_id=$1 OR o.buyer_id=$1 OR rr.initial_authenticator=$1
       ORDER BY rr.id DESC`, [u.uid]);
    return { items: rows };
  });

  fastify.get('/api/reauth-reviews/:id', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    return tx(async (c) => {
      const d = await reviewDetail(c, id);
      const u = req.user;
      const allowed = STAFF.includes(u.role) ||
        [Number(d.seller_id), Number(d.buyer_id), Number(d.initial_authenticator), Number(d.reauthenticator)].includes(u.uid);
      if (!allowed) throw new HttpError(403, '您不是该复鉴案件相关方');
      return d;
    });
  });

  // ---------- 初鉴鉴定师提交说明 / 复盘意见 ----------
  fastify.post('/api/reauth-reviews/:id/opinion', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['opinion']);
    return tx(async (c) => {
      const d = await reviewDetail(c, id);
      if (Number(d.initial_authenticator) !== req.user.uid && !['admin', 'ops'].includes(req.user.role)) {
        throw new HttpError(403, '仅初鉴鉴定师本人可提交说明');
      }
      await c.query(`UPDATE reauth_reviews SET authenticator_opinion=$1, opinion_at=now() WHERE id=$2`,
        [b.opinion, id]);
      if (d.dispute_id) {
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content)
           VALUES ($1,$2,'authenticator',$3)`,
          [d.dispute_id, req.user.uid, `【初鉴鉴定师复盘说明】${b.opinion}`]);
      }
      await notify(c, {
        userId: d.reauthenticator,
        title: `复鉴案件 ${d.code} 收到初鉴说明`,
        content: b.opinion.slice(0, 120),
        category: 'reauth', linkType: 'reauth_review', linkId: id,
      });
      return reviewDetail(c, id);
    });
  });

  // ---------- 已售商品：买家选择退款 / 保留并索赔 ----------
  fastify.post('/api/reauth-reviews/:id/buyer-choice', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    requireBody(b, ['choice']);
    if (!['refund', 'keep_with_compensation'].includes(b.choice)) throw new HttpError(400, '选择不合法');
    return tx(async (c) => {
      const d = await reviewDetail(c, id);
      if (!d.order_id || Number(d.buyer_id) !== req.user.uid) throw new HttpError(403, '仅该订单买家可做选择');
      if (d.buyer_choice && d.buyer_choice !== 'pending') throw new HttpError(409, '已提交选择，不能重复提交');
      await c.query(
        `UPDATE reauth_reviews SET buyer_choice=$1, buyer_choice_note=$2, buyer_decided_at=now() WHERE id=$3`,
        [b.choice, b.note || null, id]);
      const txt = b.choice === 'refund' ? '选择①：全额退款退货' : '选择②：保留商品并申请赔付/让佣';
      if (d.dispute_id) {
        await c.query(
          `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content)
           VALUES ($1,$2,'buyer',$3)`,
          [d.dispute_id, req.user.uid, `【买家复鉴应对选择】${txt}${b.note ? '；说明：' + b.note : ''}。订单结算继续暂停，等待客服/财务裁决。`]);
      }
      // 通知客服与财务
      const cs = await c.query(`SELECT id FROM users WHERE role='cs' ORDER BY id LIMIT 1`);
      const fin = await c.query(`SELECT id FROM users WHERE role='finance' ORDER BY id LIMIT 1`);
      if (cs.rows[0]) await notify(c, {
        userId: cs.rows[0].id, title: `买家已就复鉴案件 ${d.code} 做出选择`,
        content: txt, category: 'reauth', linkType: 'reauth_review', linkId: id });
      if (fin.rows[0]) await notify(c, {
        userId: fin.rows[0].id, title: `复鉴案件 ${d.code} 待退款/赔付裁决`,
        content: `买家${txt}，请在争议案件中执行资金裁决`, category: 'reauth', linkType: 'dispute', linkId: d.dispute_id });
      return reviewDetail(c, id);
    });
  });

  // ---------- 鉴定责任复盘（管理员/客服/运营） ----------
  fastify.post('/api/reauth-reviews/:id/responsibility', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['admin', 'cs', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅平台可做责任复盘');
    const b = req.body || {};
    requireBody(b, ['responsibility', 'responsibilityDetail']);
    if (!['initial_error', 'process_gap', 'evidence_insufficient', 'no_fault'].includes(b.responsibility)) {
      throw new HttpError(400, '责任类型不合法');
    }
    return tx(async (c) => {
      const d = await reviewDetail(c, id);
      // 关联争议未裁决前，不得结案解锁，防止争议未决先放款
      let canClose = b.close !== false;
      if (canClose && d.dispute_id) {
        const dr = await c.query(`SELECT status FROM disputes WHERE id=$1`, [d.dispute_id]);
        const active = dr.rows[0] && ['opened','investigating'].includes(dr.rows[0].status);
        if (active) canClose = false;
      }
      const finalStatus = canClose ? 'closed'
        : (d.buyer_choice === 'pending' ? 'awaiting_buyer' : 'responsibility_reviewed');
      await c.query(
        `UPDATE reauth_reviews SET responsibility=$1, responsibility_detail=$2, reviewer_id=$3,
                reviewed_at=now(), status=$4
         WHERE id=$5`,
        [b.responsibility, b.responsibilityDetail, req.user.uid, finalStatus, id]);
      // 争议已裁决/无争议时才解除商品锁与结算暂停
      if (canClose) {
        await c.query(`UPDATE consignments SET locked=FALSE, lock_reason=NULL WHERE id=$1 AND locked=TRUE`, [d.consignment_id]);
        if (d.order_id) {
          await c.query(`UPDATE orders SET settlement_paused=FALSE, settlement_pause_reason=NULL WHERE id=$1`, [d.order_id]);
        }
      }
      await logEvent(c, {
        consignmentId: d.consignment_id, actor: req.user,
        type: canClose ? 'reauth_review_closed' : 'reauth_reviewed',
        note: `复鉴案件 ${d.code} 责任复盘：${
          { initial_error: '初鉴失误', process_gap: '流程缺陷', evidence_insufficient: '证据不足', no_fault: '无责' }[b.responsibility]
        }${canClose ? '；案件结案，商品已解锁、结算暂停解除' : '；关联争议仍在处理，商品保持锁定、结算继续暂停'}。${b.responsibilityDetail}`,
        payload: { reviewId: id, responsibility: b.responsibility, unlocked: canClose },
      });
      await notify(c, {
        userId: d.initial_authenticator,
        title: `复鉴案件 ${d.code} 责任复盘结果`,
        content: `责任认定：${
          { initial_error: '初鉴失误（计入绩效）', process_gap: '流程缺陷', evidence_insufficient: '证据不足', no_fault: '无责' }[b.responsibility]
        }。${b.responsibilityDetail}`,
        category: 'reauth', linkType: 'reauth_review', linkId: id,
      });
      return reviewDetail(c, id);
    });
  });

  // ---------- 同品牌抽查列表 ----------
  fastify.get('/api/brand-audits', { onRequest: auth }, async (req) => {
    if (!STAFF.includes(req.user.role)) throw new HttpError(403, '仅内部人员可查看抽查');
    const brand = req.query.brand;
    const params = [];
    let where = '1=1';
    if (brand) { params.push(brand); where = `ba.brand ILIKE $${params.length}`; }
    const { rows } = await query(
      `SELECT ba.*, u.display_name AS authenticator_name, rv.display_name AS reviewer_name,
              c.code AS consignment_code
       FROM brand_audits ba
       JOIN users u ON u.id=ba.authenticator_id
       LEFT JOIN users rv ON rv.id=ba.reviewer_id
       LEFT JOIN consignments c ON c.id=ba.consignment_id
       WHERE ${where} ORDER BY ba.id DESC LIMIT 200`, params);
    return { items: rows };
  });

  // ---------- 抽查复核结果 ----------
  fastify.post('/api/brand-audits/:id/review', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['authenticator', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅复核员可登记抽查结果');
    const b = req.body || {};
    requireBody(b, ['result', 'finding']);
    if (!['consistent', 'mismatch', 'uncertain'].includes(b.result)) throw new HttpError(400, '抽查结果不合法');
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM brand_audits WHERE id=$1`, [id]);
      const ba = rows[0];
      if (!ba) throw new HttpError(404, '抽查单不存在');
      if (ba.status === 'audited') throw new HttpError(409, '该抽查单已复核');
      await c.query(
        `UPDATE brand_audits SET result=$1, finding=$2, reviewer_id=$3, status='audited', audited_at=now() WHERE id=$4`,
        [b.result, b.finding, req.user.uid, id]);
      if (b.result !== 'consistent') {
        await notify(c, {
          userId: ba.authenticator_id,
          title: `品牌抽查发现异常（${ba.brand} / 抽查单 ${ba.code}）`,
          content: `近期初鉴记录抽查结果：${b.result === 'mismatch' ? '与复核不一致' : '暂无法确定'}。${b.finding}`,
          category: 'reauth', linkType: 'brand_audit',
        });
      }
      return { ok: true };
    });
  });

  // ---------- 抽查发现沉淀进品牌鉴定知识库 ----------
  fastify.post('/api/brand-audits/:id/promote', { onRequest: auth }, async (req) => {
    const id = Number(req.params.id);
    if (!['authenticator', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '无权限更新知识库');
    const b = req.body || {};
    requireBody(b, ['title', 'content']);
    return tx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM brand_audits WHERE id=$1`, [id]);
      const ba = rows[0];
      if (!ba) throw new HttpError(404, '抽查单不存在');
      if (ba.status !== 'audited') throw new HttpError(409, '抽查未完成，不能沉淀知识');
      const { rows: kbRows } = await c.query(
        `INSERT INTO brand_knowledge (brand,category,title,content,key_points,source_audit_id,updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (brand,title)
         DO UPDATE SET content=EXCLUDED.content, key_points=EXCLUDED.key_points,
                       source_audit_id=EXCLUDED.source_audit_id, updated_by=EXCLUDED.updated_by
         RETURNING *`,
        [ba.brand, ba.category, b.title, b.content,
         JSON.stringify(b.keyPoints || []), id, req.user.uid]);
      await c.query(`UPDATE brand_audits SET promoted_kb=TRUE WHERE id=$1`, [id]);
      return kbRows[0];
    });
  });

  // ---------- 品牌知识库 ----------
  fastify.get('/api/brand-knowledge', { onRequest: auth }, async (req) => {
    const brand = req.query.brand;
    const params = [];
    let where = '1=1';
    if (brand) { params.push(brand); where = `brand ILIKE $${params.length}`; }
    const { rows } = await query(
      `SELECT k.*, u.display_name AS updated_by_name FROM brand_knowledge k
       LEFT JOIN users u ON u.id=k.updated_by WHERE ${where} ORDER BY k.id DESC LIMIT 100`, params);
    return { items: rows };
  });

  fastify.post('/api/brand-knowledge', { onRequest: auth }, async (req) => {
    if (!['authenticator', 'admin', 'ops'].includes(req.user.role)) throw new HttpError(403, '仅鉴定/平台可维护知识库');
    const b = req.body || {};
    requireBody(b, ['brand', 'title', 'content']);
    const { rows } = await query(
      `INSERT INTO brand_knowledge (brand,category,title,content,key_points,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (brand,title)
       DO UPDATE SET content=EXCLUDED.content, key_points=EXCLUDED.key_points,
                     category=EXCLUDED.category, updated_by=EXCLUDED.updated_by
       RETURNING *`,
      [b.brand, b.category || null, b.title, b.content,
       JSON.stringify(b.keyPoints || []), req.user.uid]);
    return rows[0];
  });

  // ---------- 站内通知 ----------
  fastify.get('/api/notifications', { onRequest: auth }, async (req) => {
    const { rows } = await query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100`, [req.user.uid]);
    const unread = rows.filter((x) => !x.is_read).length;
    return { items: rows, unread };
  });

  fastify.post('/api/notifications/:id/read', { onRequest: auth }, async (req) => {
    await query(`UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2`,
      [Number(req.params.id), req.user.uid]);
    return { ok: true };
  });

  fastify.post('/api/notifications/read-all', { onRequest: auth }, async () => {
    await query(`UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE`, [req.user.uid]);
    return { ok: true };
  });
}
