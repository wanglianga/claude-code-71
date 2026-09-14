import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { pool, tx } from './db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USERS = [
  ['admin',        'admin123',  '平台管理员', 'admin', null],
  ['seller_alice', 'alice123',  '卖家·阿琳', 'seller', null],
  ['seller_bob',   'bob123',    '卖家·柏先生', 'seller', null],
  ['buyer_cara',   'cara123',   '买家·卡拉', 'buyer', null],
  ['buyer_dan',    'dan123',    '买家·阿丹', 'buyer', null],
  ['auth_evan',    'evan123',   '鉴定师·埃文（资深·腕表）', 'authenticator', 'watch'],
  ['auth_fiona',   'fiona123',  '鉴定师·菲奥娜（资深·箱包珠宝）', 'authenticator', 'bag,jewelry'],
  ['auth_gale',    'gale123',   '鉴定师·盖尔（复核员）', 'authenticator', 'all'],
  ['wh_grace',     'grace123',  '仓库主管·格蕾丝', 'warehouse', null],
  ['ops_henry',    'henry123',  '运营·亨利', 'ops', null],
  ['cs_iris',      'iris123',   '客服·艾瑞斯', 'cs', null],
  ['fin_jack',     'jack123',    '财务·杰克', 'finance', null],
];

const STANDARDS = [
  ['QS-BAG', 'bag', '箱包成色质检标准', {
    N: ['全新未使用', '五金无氧化', '原膜/原票齐全'],
    S: ['95新以上', '轻微使用痕迹', '无破损无修复'],
    A: ['9新', '四角轻微磨损', '五金轻微划痕'],
    B: ['8新', '明显使用痕迹/边角磨损', '功能完好'],
    C: ['7新及以下', '可见损伤或需整备', '如实披露瑕疵'],
  }],
  ['QS-WATCH', 'watch', '腕表成色质检标准', {
    N: ['全新全套', '保卡表盒齐全', '走时精准'],
    S: ['95新', '表带表扣无明显划痕', '机芯状态优良'],
    A: ['9新', '表壳细微划痕', '走时正常'],
    B: ['8新', '明显佩戴痕迹/轻微抛光', '功能正常'],
    C: ['7新及以下', '磕碰或需保养', '如实披露维修史'],
  }],
  ['QS-JEWEL', 'jewelry', '珠宝首饰成色质检标准', {
    N: ['全新', '证书齐全', '无佩戴痕迹'],
    S: ['近全新', '镶嵌牢固', '金属无变形'],
    A: ['轻微佩戴痕迹', '主石无损伤'],
    B: ['可见磨损', '副石需检查'],
    C: ['缺石/修复史', '需重新鉴定'],
  }],
  ['QS-FASHION', 'fashion', '鞋服成色质检标准', {
    N: ['全新带吊牌', '无试穿痕迹'],
    S: ['近全新', '极轻微试穿'],
    A: ['轻微穿着', '无污渍破损'],
    B: ['明显穿着痕迹', '可清洁整备'],
    C: ['磨损/污渍明显', '特价处理'],
  }],
];

async function seedDemo(c) {
  // 直播场次
  await c.query(
    `INSERT INTO live_sessions (title,host,status) VALUES ($1,$2,'scheduled')
     ON CONFLICT DO NOTHING`,
    ['周三晚8点·名表鉴赏直播', '主播 Luna']
  );

  // 演示单 1：Alice 的 Chanel 包，已完成初鉴+报价+上架，买家可直接下单
  const alice = (await c.query(`SELECT id FROM users WHERE username='seller_alice'`)).rows[0];
  const fiona = (await c.query(`SELECT id FROM users WHERE username='auth_fiona'`)).rows[0];
  const henry = (await c.query(`SELECT id FROM users WHERE username='ops_henry'`)).rows[0];

  const exists = await c.query(`SELECT 1 FROM consignments WHERE code='C-1001'`);
  if (!exists.rowCount) {
    const { rows: [con] } = await c.query(
      `INSERT INTO consignments
        (code,seller_id,category,brand,model,serial_no,purchase_proof,accessories,flaw_photos,
         item_description,expected_price,reserve_price,declared_value,high_value,
         inbound_carrier,inbound_tracking,authenticity,grade,sale_price,channel,listed_at,status)
       VALUES ('C-1001',$1,'bag','Chanel','Classic Flap 中号 鱼子酱牛皮','CH-CF-2021-8842',
         '专柜发票#SH20210612 / 身份卡',
         '["身份卡","防尘袋","原盒","小票"]','["photo://flaw/corner-light-wear.jpg"]',
         '黑金配色，四角极轻微使用痕迹',60000,52000,65000,true,
         'SF Express','SF1002345678','authentic','S',58000,'shop',now(),'listed')
       RETURNING id`, [alice.id]);
    const cid = con.id;
    await c.query(
      `INSERT INTO consignment_events (consignment_id,actor_id,actor_role,type,from_status,to_status,note,evidence,payload)
       VALUES
       ($1,$2,'seller','created',NULL,'drafted','卖家创建寄卖单并填写期望价','["doc://invoice.jpg"]','{}'),
       ($1,$2,'seller','shipped','drafted','shipped','顺丰寄付，已拍照留档','["photo://packing.jpg"]','{"tracking":"SF1002345678"}'),
       ($1,(SELECT id FROM users WHERE username='wh_grace'),'warehouse','received','shipped','received','仓库签收并完成入库状态复核','["photo://inbound-1.jpg","photo://inbound-2.jpg"]','{}'),
       ($1,$3,'authenticator','authenticated','authenticating','authenticated','初鉴为真，成色S','["photo://serial.jpg","photo://hardware.jpg"]','{}'),
       ($1,$4,'ops','quoted','authenticated','quoted','运营按市场价与佣金生成报价','[]','{}'),
       ($1,$2,'seller','quote_accepted','quoted','listed','卖家接受报价，商品上架','[]','{"salePrice":58000}')`,
      [cid, alice.id, fiona.id, henry.id]);
    await c.query(
      `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,matches_previous)
       VALUES ($1,'inbound',(SELECT id FROM users WHERE username='wh_grace'),
         '外包完好，四角轻微磨损，与卖家描述一致',
         '["photo://inbound-1.jpg","photo://inbound-2.jpg"]',true)`, [cid]);
    await c.query(
      `INSERT INTO authentications
        (consignment_id,round,is_final,primary_authenticator,result,grade,
         serial_check,hardware_check,leather_check,stitching_check,receipt_check,case_history,summary,evidence)
       VALUES ($1,1,true,$2,'authentic','S',
         '序列号与品牌数据库年份批次吻合','五金刻字清晰、镀层工艺符合','鱼子酱牛皮纹理与气味正常',
         '针距均匀、斜皮纹路对版','小票与身份卡信息一致','历史案例库未见仿品同批次',
         '综合判定为正品，成色S，可上架','["photo://serial.jpg","doc://invoice.jpg"]')`,
      [cid, fiona.id]);
    await c.query(
      `INSERT INTO quotes (consignment_id,market_price,commission_rate,storage_fee,insurance_fee,
         reserve_price,sale_price,seller_proceeds,quote_note,created_by,seller_accepted,seller_reply)
       VALUES ($1,61000,0.1200,0,320,52000,58000,50720,
         '市场近30天成交区间 5.7w-6.2w；佣金12%，保价费320元由卖家承担',$2,true,'同意报价')`,
      [cid, henry.id]);
    await c.query(
      `INSERT INTO insurance_policies (consignment_id,declared_value,premium,coverage_stage,status)
       VALUES ($1,65000,320,'all','active')`, [cid]);
  }

  // 演示单 2：Bob 的劳力士迪通拿，高价值已入库待鉴定（走双人鉴定 + 保险箱流程）
  const bob = (await c.query(`SELECT id FROM users WHERE username='seller_bob'`)).rows[0];
  const exists2 = await c.query(`SELECT 1 FROM consignments WHERE code='C-2002'`);
  if (!exists2.rowCount) {
    const { rows: [con] } = await c.query(
      `INSERT INTO consignments
        (code,seller_id,category,brand,model,serial_no,purchase_proof,accessories,flaw_photos,
         item_description,expected_price,declared_value,high_value,limited_edition,
         inbound_carrier,inbound_tracking,status,vault_ready)
       VALUES ('C-2002',$1,'watch','Rolex','Cosmograph Daytona 116500LN 白盘','R-DT-116500-2299',
         '海外购表凭证/保卡（2022年）','["保卡","表盒","说明书","吊牌"]','[]',
         '白盘黑圈，全套附件，卖家自称95新',210000,220000,true,true,
         'FedEx','FX7788990011','received',false)
       RETURNING id`, [bob.id]);
    const cid = con.id;
    await c.query(
      `INSERT INTO consignment_events (consignment_id,actor_id,actor_role,type,from_status,to_status,note,evidence)
       VALUES
       ($1,$2,'seller','created',NULL,'drafted','创建高价值腕表寄卖单，申请双人鉴定','["doc://rolex-receipt.jpg"]'),
       ($1,$2,'seller','shipped','drafted','shipped','FedEx 高值保价寄付','["photo://watch-pack.jpg"]'),
       ($1,(SELECT id FROM users WHERE username='wh_grace'),'warehouse','received','shipped','received',
        '签收高值件，双人开箱视频已存','["video://dual-open.mp4","photo://watch-inbound.jpg"]')`,
      [cid, bob.id]);
    await c.query(
      `INSERT INTO status_confirmations (consignment_id,checkpoint,confirmer_id,condition_summary,photos,video_url,matches_previous)
       VALUES ($1,'inbound',(SELECT id FROM users WHERE username='wh_grace'),
         '表镜无划痕、表壳95新、全套附件清点一致',
         '["photo://watch-inbound.jpg"]','video://dual-open.mp4',true)`, [cid]);
    await c.query(
      `INSERT INTO insurance_policies (consignment_id,declared_value,premium,coverage_stage,status)
       VALUES ($1,220000,1100,'all','active')`, [cid]);
  }
}

export async function runSeed() {
  // 等待数据库就绪
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const schema = await readFile(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await pool.query(schema);

  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users`);
  if (rows[0].n > 0) {
    console.log('seed: 数据已存在，跳过');
    return;
  }

  await tx(async (c) => {
    for (const [username, pwd, name, role, specialty] of USERS) {
      const hash = await bcrypt.hash(pwd, 10);
      await c.query(
        `INSERT INTO users (username,password_hash,display_name,role,specialty)
         VALUES ($1,$2,$3,$4,$5)`,
        [username, hash, name, role, specialty]
      );
    }
    const admin = (await c.query(`SELECT id FROM users WHERE username='admin'`)).rows[0];
    for (const [code, category, name, rules] of STANDARDS) {
      await c.query(
        `INSERT INTO quality_standards (code,category,name,grade_rules,updated_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [code, category, name, JSON.stringify(rules), admin.id]
      );
    }
    await seedDemo(c);
  });
  console.log('seed: 演示数据写入完成');
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('seed.js');
if (invokedDirectly) {
  runSeed()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error('seed 失败:', err);
      await pool.end();
      process.exit(1);
    });
}
