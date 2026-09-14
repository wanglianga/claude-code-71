import { query, tx } from './db/pool.js';

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const n = (v) => Number(v);
export const money = (v) => Math.round(Number(v || 0) * 100) / 100;

export function requireBody(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new HttpError(400, `缺少字段: ${f}`);
    }
  }
}

/** append-only 事件时间线 */
export async function logEvent(client, e) {
  await client.query(
    `INSERT INTO consignment_events
       (consignment_id,actor_id,actor_role,type,from_status,to_status,note,evidence,payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      e.consignmentId,
      e.actor?.id ?? null,
      e.actor?.role ?? null,
      e.type,
      e.fromStatus ?? null,
      e.toStatus ?? null,
      e.note ?? '',
      JSON.stringify(e.evidence ?? []),
      JSON.stringify(e.payload ?? {}),
    ]
  );
}

export async function getConsignment(client, id) {
  const { rows } = await client.query(
    `SELECT c.*, u.display_name AS seller_name
     FROM consignments c JOIN users u ON u.id = c.seller_id
     WHERE c.id = $1`, [id]);
  if (!rows[0]) throw new HttpError(404, '寄卖单不存在');
  return rows[0];
}

export async function getOrder(client, id) {
  const { rows } = await client.query(
    `SELECT o.*, c.code AS consignment_code, u.display_name AS buyer_name
     FROM orders o JOIN consignments c ON c.id=o.consignment_id
     JOIN users u ON u.id=o.buyer_id WHERE o.id=$1`, [id]);
  if (!rows[0]) throw new HttpError(404, '订单不存在');
  return rows[0];
}

export async function latestAuth(client, consignmentId) {
  const { rows } = await client.query(
    `SELECT * FROM authentications WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`,
    [consignmentId]);
  return rows[0] ?? null;
}

export async function latestQuote(client, consignmentId) {
  const { rows } = await client.query(
    `SELECT * FROM quotes WHERE consignment_id=$1 ORDER BY id DESC LIMIT 1`,
    [consignmentId]);
  return rows[0] ?? null;
}

async function staffByRole(client, role) {
  const { rows } = await client.query(
    `SELECT id, display_name, role FROM users WHERE role=$1 ORDER BY id LIMIT 1`, [role]);
  return rows[0] ?? null;
}

/** 汇总争议相关方与证据（鉴定轮次/状态复核/收货视频），保证可追溯 */
export async function collectPartiesAndEvidence(client, { consignment, order, opener, extraEvidence = [] }) {
  const partyMap = new Map();
  const add = (u) => { if (u && !partyMap.has(Number(u.id))) partyMap.set(Number(u.id), { userId: Number(u.id), role: u.role, name: u.display_name }); };
  add({ id: consignment.seller_id, role: 'seller', display_name: consignment.seller_name });
  if (opener) add({ id: opener.id, role: opener.role, display_name: opener.display_name });
  if (order) {
    add({ id: order.buyer_id, role: 'buyer', display_name: order.buyer_name });
  }
  const auth = await latestAuth(client, consignment.id);
  if (auth) {
    const pa = await client.query(`SELECT id,display_name,role FROM users WHERE id=$1`, [auth.primary_authenticator]);
    add(pa.rows[0]);
    if (auth.second_authenticator) {
      const sa = await client.query(`SELECT id,display_name,role FROM users WHERE id=$1`, [auth.second_authenticator]);
      add(sa.rows[0]);
    }
  }
  add(await staffByRole(client, 'warehouse'));
  add(await staffByRole(client, 'cs'));
  add(await staffByRole(client, 'finance'));

  const evidence = [];
  if (auth) {
    evidence.push(`auth#${auth.id}(第${auth.round}轮,结论=${auth.result}${auth.overturned ? ',已推翻初鉴' : ''})`);
    for (const ev of auth.evidence || []) evidence.push(ev);
  }
  const confs = await client.query(
    `SELECT id,checkpoint,condition_summary,photos,video_url,created_at
     FROM status_confirmations WHERE consignment_id=$1 ORDER BY id DESC LIMIT 5`, [consignment.id]);
  for (const cf of confs.rows) {
    evidence.push(`confirm#${cf.id}@${cf.checkpoint}(${cf.matches_previous ? '与前态一致' : '存在差异'}:${cf.condition_summary})`);
    for (const p of cf.photos || []) evidence.push(p);
    if (cf.video_url) evidence.push(cf.video_url);
  }
  if (order?.receiving_video_url) evidence.push(`buyer-receipt-video:${order.receiving_video_url}`);
  for (const ev of extraEvidence) if (ev) evidence.push(ev);

  return { parties: [...partyMap.values()], evidence: [...new Set(evidence)], linkedAuth: auth };
}

let disputeSeq = 0;
export function genCode(prefix) {
  disputeSeq += 1;
  const s = Math.abs(Number(String(Date.now()).slice(-7) * 31 + disputeSeq)).toString(36).toUpperCase();
  return `${prefix}-${s.padStart(6, '0').slice(-6)}`;
}

/** 统一开争议：多方入案、证据归档、寄卖单进入 disputed */
export async function openDispute(client, { consignment, order, opener, type, summary, extraEvidence = [] }) {
  const exist = await client.query(
    `SELECT id FROM disputes WHERE consignment_id=$1 AND status IN ('opened','investigating')`, [consignment.id]);
  if (exist.rows[0]) throw new HttpError(409, `该寄卖单已有进行中的争议 #${exist.rows[0].id}，请在同一案件中处理`);

  const { parties, evidence, linkedAuth } = await collectPartiesAndEvidence(client, { consignment, order, opener, extraEvidence });
  const code = genCode('D');
  const { rows } = await client.query(
    `INSERT INTO disputes
       (code,consignment_id,order_id,type,opened_by,parties,summary,linked_auth_id,linked_evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [code, consignment.id, order?.id ?? null, type, opener.id,
     JSON.stringify(parties), summary, linkedAuth?.id ?? null, JSON.stringify(evidence)]);
  await client.query(`UPDATE consignments SET status='disputed', updated_at=now() WHERE id=$1`, [consignment.id]);
  await logEvent(client, {
    consignmentId: consignment.id, actor: opener, type: 'dispute_opened',
    fromStatus: consignment.status, toStatus: 'disputed',
    note: `争议立案 ${code}：${summary}`, evidence,
  });
  // 系统入案消息
  await client.query(
    `INSERT INTO dispute_messages (dispute_id,author_id,author_role,content,evidence)
     VALUES ($1,$2,'system',$3,$4)`,
    [rows[0].id, opener.id,
      `【系统立案】争议类型 ${type}。已自动归集相关方 ${parties.length} 人、证据 ${evidence.length} 条（鉴定记录/状态复核/交付视频）。最终退款、赔付与佣金调整将引用本案编号入账。`,
      JSON.stringify(evidence.slice(0, 10))]);
  return rows[0];
}

export function canViewDispute(user, dispute) {
  if (['admin', 'ops', 'cs', 'finance', 'warehouse', 'authenticator'].includes(user.role)) return true;
  return (dispute.parties || []).some((p) => Number(p.userId) === Number(user.id));
}

export function isParty(user, dispute) {
  return (dispute.parties || []).some((p) => Number(p.userId) === Number(user.id));
}

export async function ledger(client, e) {
  await client.query(
    `INSERT INTO financial_ledger
       (consignment_id,order_id,dispute_id,account,entry_type,direction,amount,evidence_ref,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.consignmentId ?? null, e.orderId ?? null, e.disputeId ?? null,
     e.account, e.entryType, e.direction, money(e.amount), e.evidenceRef ?? null, e.createdBy ?? null]);
}

/** 站内通知 */
export async function notify(client, { userId, title, content, category = 'system', linkType = null, linkId = null }) {
  if (!userId) return null;
  const { rows } = await client.query(
    `INSERT INTO notifications (user_id,title,content,category,link_type,link_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, title, content, category, linkType, linkId ?? null]);
  return rows[0];
}

/** 初鉴/复鉴七个维度的差异描述 */
export function diffAuthentications(initial, reauth) {
  const RESULT_TXT = { authentic: '正品', fake: '假冒', suspicious: '存疑' };
  const lines = [];
  if (initial.result !== reauth.result) {
    lines.push(`真伪结论：${RESULT_TXT[initial.result]} → ${RESULT_TXT[reauth.result]}`);
  }
  if (initial.grade !== reauth.grade) {
    lines.push(`成色等级：${initial.grade || '—'} → ${reauth.grade || '—'}`);
  }
  const dims = [
    ['serial_check', '序列号'], ['hardware_check', '五金'], ['leather_check', '皮质'],
    ['stitching_check', '走线'], ['movement_check', '机芯'], ['receipt_check', '票据'],
    ['case_history', '历史案例'],
  ];
  for (const [key, label] of dims) {
    const a = (initial[key] || '').trim();
    const b = (reauth[key] || '').trim();
    if (a !== b) lines.push(`${label}：「${a || '未填'}」→「${b || '未填'}」`);
  }
  return lines.length ? lines.join('\n') : '两次结论一致，无实质差异';
}
