import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError } from './errors.js';

export type Rol = 'admin' | 'medico' | 'secretaria';
export interface Usuario { id: number; nombre: string; email: string; rol: Rol; profesional_id: number | null }

declare global {
  namespace Express { interface Request { user?: Usuario } }
}

const COOKIE = 'sid';
const DUMMY_HASH = bcrypt.hashSync('no-existe', 10);
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export async function login(email: string, password: string) {
  const [u] = await q('SELECT id, password_hash, activo FROM usuarios WHERE lower(email) = lower($1)', [email]);
  // Comparamos igual aunque no exista, para no revelar qué emails están registrados
  const ok = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !ok || !u.activo) throw new HttpError(401, 'Email o contraseña incorrectos');
  const token = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sesiones (token_hash, usuario_id, expira_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hash(token), u.id, config.sessionDays]);
  return token;
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.isProd,
    maxAge: config.sessionDays * 864e5, path: '/',
  });
}

export async function logout(req: Request, res: Response) {
  const t = req.cookies?.[COOKIE];
  if (t) await q('DELETE FROM sesiones WHERE token_hash = $1', [hash(t)]);
  res.clearCookie(COOKIE, { path: '/' });
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const t = req.cookies?.[COOKIE];
  if (t) {
    const [u] = await q<Usuario>(`
      SELECT u.id, u.nombre, u.email, u.rol, p.id AS profesional_id
      FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
      LEFT JOIN profesionales p ON p.usuario_id = u.id
      WHERE s.token_hash = $1 AND s.expira_at > now() AND u.activo`, [hash(t)]);
    if (u) req.user = u;
  }
  next();
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) throw new HttpError(401, 'Iniciá sesión para continuar');
  next();
};

/** Restringe una ruta a ciertos roles. La secretaria nunca pasa por rutas clínicas. */
export const requireRol = (...roles: Rol[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) throw new HttpError(401, 'Iniciá sesión para continuar');
  if (!roles.includes(req.user.rol)) throw new HttpError(403, 'No tenés permiso para esta acción');
  next();
};

export const hashPassword = (p: string) => bcrypt.hash(p, 10);

/** Cambio de contraseña del propio usuario: pide la actual y cierra las otras sesiones. */
export async function cambiarPassword(req: Request, actual: string, nueva: string) {
  const usuarioId = req.user!.id;
  const [u] = await q('SELECT password_hash FROM usuarios WHERE id = $1', [usuarioId]);
  if (!u || !(await bcrypt.compare(actual, u.password_hash))) throw new HttpError(422, 'La contraseña actual no es correcta');
  await q('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [usuarioId, await hashPassword(nueva)]);
  await q('DELETE FROM sesiones WHERE usuario_id = $1 AND token_hash <> $2', [usuarioId, hash(req.cookies?.[COOKIE] ?? '')]);
}
