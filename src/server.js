import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { pool } from './db/pool.js';
import { runSeed } from './seed.js';
import { HttpError } from './lib.js';

import authRoutes from './routes/auth.js';
import consignmentRoutes from './routes/consignments.js';
import authenticationRoutes from './routes/authentications.js';
import quoteRoutes from './routes/quotes.js';
import orderRoutes from './routes/orders.js';
import disputeRoutes from './routes/disputes.js';
import adminRoutes from './routes/admin.js';
import reauthRoutes from './routes/reauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: { transport: undefined } });

app.register(fastifyJwt, { secret: process.env.JWT_SECRET || 'dev-secret' });
app.decorate('authenticate', async (req, reply) => {
  try {
    await req.jwtVerify();
    // 统一身份字段，供业务层以 {id, role, display_name} 使用
    req.user.id = Number(req.user.uid);
    req.user.display_name = req.user.name;
  } catch {
    reply.code(401).send({ error: '未登录或登录已失效' });
  }
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  if (err.validation) return reply.code(400).send({ error: '请求参数不合法', detail: err.message });
  req.log.error(err);
  return reply.code(500).send({ error: '服务器内部错误', detail: err.message });
});

app.get('/health', async (_req, reply) => {
  try {
    await pool.query('SELECT 1');
    return { ok: true, db: 'up' };
  } catch (e) {
    return reply.code(503).send({ ok: false, db: 'down', error: e.message });
  }
});

app.register(authRoutes);
app.register(consignmentRoutes);
app.register(authenticationRoutes);
app.register(quoteRoutes);
app.register(orderRoutes);
app.register(disputeRoutes);
app.register(adminRoutes);
app.register(reauthRoutes);

// 静态演示控制台
app.register(fastifyStatic, {
  root: path.join(__dirname, '../public'),
  prefix: '/',
});

// 兜底：非 /api 路径返回演示台（便于直接访问）
app.setNotFoundHandler(async (req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
  const html = await readFile(path.join(__dirname, '../public/index.html'));
  reply.type('text/html').send(html);
});

async function waitDb() {
  for (let i = 0; i < 40; i++) {
    try { await pool.query('SELECT 1'); return; }
    catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error('数据库连接超时');
}

async function start() {
  await waitDb();
  // 确保表结构存在（schema 幂等）
  const schema = await readFile(path.join(__dirname, 'db/schema.sql'), 'utf8');
  await pool.query(schema);
  if ((process.env.SEED_ON_START ?? 'true') === 'true') {
    await runSeed().catch((e) => app.log.error('seed error: ' + e.message));
  }
  const port = Number(process.env.PORT || 3000);
  await app.listen({ host: '0.0.0.0', port });
  app.log.info(`LuxConsign 已启动于 :${port}`);
}

start().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
