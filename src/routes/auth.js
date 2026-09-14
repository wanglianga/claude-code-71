import bcrypt from 'bcryptjs';
import { query } from '../db/pool.js';
import { requireBody } from '../lib.js';

export default async function authRoutes(fastify) {
  fastify.post('/api/auth/login', async (req, reply) => {
    requireBody(req.body, ['username', 'password']);
    const { username, password } = req.body;
    const { rows } = await query(`SELECT * FROM users WHERE username=$1`, [username]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    if (user.blacklisted) {
      return reply.code(403).send({ error: `账号已被列入平台黑名单：${user.blacklist_reason || '违规'}` });
    }
    const token = await reply.jwtSign(
      { uid: Number(user.id), role: user.role, name: user.display_name },
      { expiresIn: '12h' }
    );
    return {
      token,
      user: {
        id: Number(user.id), username: user.username, displayName: user.display_name,
        role: user.role, specialty: user.specialty, blacklisted: user.blacklisted,
      },
    };
  });

  fastify.get('/api/auth/me', { onRequest: [fastify.authenticate] }, async (req) => {
    const { rows } = await query(
      `SELECT id,username,display_name,role,specialty,blacklisted,blacklist_reason FROM users WHERE id=$1`,
      [req.user.uid]);
    const u = rows[0];
    return { id: Number(u.id), username: u.username, displayName: u.display_name, role: u.role, specialty: u.specialty, blacklisted: u.blacklisted };
  });
}
