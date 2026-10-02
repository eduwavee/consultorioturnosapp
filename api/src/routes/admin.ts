import { Router } from 'express';
import { z } from 'zod';
import { hashPassword, requireRol } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { q, tx } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';

export const adminRouter = Router();
const admin = requireRol('admin');
const id = z.coerce.number().int().positive();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');
const hora = z.string().regex(/^\d{2}:\d{2}$/, 'Formato HH:MM');

/** Lectura del audit_log. Para la tabla consultas solo se muestran metadatos, no el contenido clínico. */
adminRouter.get('/auditoria', admin, async (req, res) => {
  const f = z.object({
    tabla: z.enum(['pacientes', 'consultas', 'recetas', 'turnos', 'pagos', 'lista_espera', 'bloqueos_agenda',
      'tipos_turno', 'horarios_atencion', 'obras_sociales', 'consultorio']).optional(),
    registro_id: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).parse(req.query);
  res.json(await q(`
    SELECT a.id, a.tabla, a.registro_id, a.accion, a.at, u.nombre AS usuario,
           CASE WHEN a.tabla IN ('consultas', 'recetas') THEN NULL ELSE a.antes END AS antes,
           CASE WHEN a.tabla IN ('consultas', 'recetas') THEN NULL ELSE a.despues END AS despues
    FROM audit_log a LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE ($1::text IS NULL OR a.tabla = $1) AND ($2::bigint IS NULL OR a.registro_id = $2)
    ORDER BY a.id DESC LIMIT $3`, [f.tabla ?? null, f.registro_id ?? null, f.limit]));
});

adminRouter.get('/accesos', admin, async (_req, res) => {
  res.json(await q(`
    SELECT a.id, a.at, u.nombre AS usuario, p.nombre || ' ' || p.apellido AS paciente
    FROM accesos_historia a JOIN usuarios u ON u.id = a.usuario_id JOIN pacientes p ON p.id = a.paciente_id
    ORDER BY a.id DESC LIMIT 100`));
});

/* ---------- Reportes ---------- */

/** Números para el tablero: turnos del mes, ausentismo y origen de las reservas. */
adminRouter.get('/reportes/mes', admin, async (_req, res) => {
  const [r] = await q(`
    SELECT count(*) FILTER (WHERE estado::text <> 'pendiente' AND paciente_id IS NOT NULL) AS turnos,
           count(*) FILTER (WHERE estado = 'ausente') AS ausentes,
           count(*) FILTER (WHERE estado = 'cancelado' AND paciente_id IS NOT NULL) AS cancelados,
           count(*) FILTER (WHERE origen = 'web' AND paciente_id IS NOT NULL) AS web,
           count(*) FILTER (WHERE origen = 'secretaria') AS consultorio
    FROM turnos
    WHERE date_trunc('month', inicio AT TIME ZONE $1) = date_trunc('month', now() AT TIME ZONE $1)`, [config.tz]);
  const ingresos = await q(`
    SELECT medio, sum(monto) AS total FROM pagos pg JOIN cajas c ON c.id = pg.caja_id
    WHERE NOT anulado AND date_trunc('month', c.fecha) = date_trunc('month', (now() AT TIME ZONE $1)::date)
    GROUP BY medio ORDER BY total DESC`, [config.tz]);
  const [espera] = await q(`SELECT count(*) FILTER (WHERE resuelto_at IS NULL) AS activos,
    count(*) FILTER (WHERE avisado_at >= date_trunc('month', now())) AS avisados FROM lista_espera`);
  res.json({ ...r, ingresos, lista_espera: espera });
});

/**
 * Prestaciones atendidas por obra social en un período, para facturar.
 * Se usa la cobertura que el paciente tiene cargada hoy.
 */
async function reporteObrasSociales(desde: string, hasta: string) {
  const params = [desde, hasta, config.tz];
  const rango = `t.inicio >= ($1::date)::timestamp AT TIME ZONE $3 AND t.inicio < ($2::date + 1)::timestamp AT TIME ZONE $3`;
  const detalle = await q(`
    SELECT to_char(t.inicio AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS fecha,
           COALESCE(o.nombre, 'Sin cobertura cargada') AS obra_social,
           p.apellido || ', ' || p.nombre AS paciente, p.dni, p.nro_afiliado,
           tt.nombre AS prestacion, u.nombre AS profesional, pr.matricula,
           COALESCE((SELECT sum(pg.monto) FROM pagos pg WHERE pg.turno_id = t.id AND NOT pg.anulado AND pg.tipo = 'copago'), 0) AS copago
    FROM turnos t
    JOIN pacientes p ON p.id = t.paciente_id LEFT JOIN obras_sociales o ON o.id = p.obra_social_id
    JOIN tipos_turno tt ON tt.id = t.tipo_turno_id
    JOIN profesionales pr ON pr.id = t.profesional_id JOIN usuarios u ON u.id = pr.usuario_id
    WHERE t.estado = 'atendido' AND ${rango}
    ORDER BY obra_social, t.inicio`, params);
  const resumen = await q(`
    SELECT COALESCE(o.nombre, 'Sin cobertura cargada') AS obra_social,
           count(*) AS prestaciones, count(DISTINCT t.paciente_id) AS pacientes,
           COALESCE(sum((SELECT sum(pg.monto) FROM pagos pg WHERE pg.turno_id = t.id AND NOT pg.anulado AND pg.tipo = 'copago')), 0) AS copagos
    FROM turnos t
    JOIN pacientes p ON p.id = t.paciente_id LEFT JOIN obras_sociales o ON o.id = p.obra_social_id
    WHERE t.estado = 'atendido' AND ${rango}
    GROUP BY 1 ORDER BY prestaciones DESC`, params);
  return { desde, hasta, resumen, detalle };
}

/** CSV para Excel en español: separador ; y BOM para que respete las tildes. */
function aCsv(filas: Record<string, unknown>[], columnas: [string, string][]) {
  const celda = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columnas.map(c => c[1]).join(';'), ...filas.map(f => columnas.map(([k]) => celda(f[k])).join(';'))].join('\r\n');
}

adminRouter.get('/reportes/obras-sociales', admin, async (req, res) => {
  const f = z.object({ desde: fecha, hasta: fecha, formato: z.enum(['json', 'csv']).default('json') }).parse(req.query);
  if (f.hasta < f.desde) throw new HttpError(400, 'La fecha "hasta" es anterior a "desde"');
  const r = await reporteObrasSociales(f.desde, f.hasta);
  if (f.formato === 'json') { res.json(r); return; }
  res.attachment(`prestaciones_${f.desde}_${f.hasta}.csv`).type('text/csv; charset=utf-8').send(aCsv(r.detalle, [
    ['fecha', 'Fecha'], ['obra_social', 'Obra social'], ['paciente', 'Paciente'], ['dni', 'DNI'], ['nro_afiliado', 'N.º afiliado'],
    ['prestacion', 'Prestación'], ['profesional', 'Profesional'], ['matricula', 'Matrícula'], ['copago', 'Copago cobrado'],
  ]));
});

/* ---------- Usuarios ---------- */
const rol = z.enum(['admin', 'medico', 'secretaria']);
const datosProfesional = {
  matricula: z.string().trim().nullable().optional(),
  especialidad: z.string().trim().min(1).optional(),
  titulo: z.string().trim().nullable().optional(),
};

adminRouter.get('/usuarios', admin, async (_req, res) => {
  res.json(await q(`
    SELECT u.id, u.nombre, u.email, u.rol, u.activo, p.id AS profesional_id, p.matricula, p.especialidad, p.titulo
    FROM usuarios u LEFT JOIN profesionales p ON p.usuario_id = u.id ORDER BY u.activo DESC, u.id`));
});

/** Los médicos necesitan una fila en profesionales para tener agenda. */
async function asegurarProfesional(db: import('../lib/db.js').Db, usuarioId: number, d: { matricula?: string | null; especialidad?: string; titulo?: string | null }) {
  const { rows: [p] } = await db.query('SELECT id FROM profesionales WHERE usuario_id = $1', [usuarioId]);
  if (!p) {
    const { rows: [c] } = await db.query('SELECT especialidad FROM consultorio');
    await db.query('INSERT INTO profesionales (usuario_id, matricula, especialidad, titulo) VALUES ($1, $2, $3, $4)',
      [usuarioId, d.matricula ?? null, d.especialidad ?? c?.especialidad ?? 'general', d.titulo ?? null]);
    return;
  }
  await db.query(`UPDATE profesionales SET
      matricula = CASE WHEN $2::boolean THEN $3 ELSE matricula END,
      especialidad = COALESCE($4, especialidad),
      titulo = CASE WHEN $5::boolean THEN $6 ELSE titulo END
    WHERE id = $1`, [p.id, 'matricula' in d, d.matricula ?? null, d.especialidad ?? null, 'titulo' in d, d.titulo ?? null]);
}

adminRouter.post('/usuarios', admin, async (req, res) => {
  const b = z.object({
    nombre: z.string().trim().min(2),
    email: z.string().trim().toLowerCase().email(),
    rol,
    password: z.string().min(8, 'La contraseña tiene que tener al menos 8 caracteres'),
    ...datosProfesional,
  }).parse(req.body);
  const hash = await hashPassword(b.password);
  const u = await tx(req.user!.id, async db => {
    const { rows: [u] } = await db.query(
      'INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1,$2,$3,$4) RETURNING id, nombre, email, rol, activo',
      [b.nombre, b.email, hash, b.rol]);
    if (b.rol === 'medico') await asegurarProfesional(db, u.id, b);
    return u;
  });
  res.status(201).json(u);
});

adminRouter.patch('/usuarios/:id', admin, async (req, res) => {
  const uid = id.parse(req.params.id);
  const b = z.object({
    nombre: z.string().trim().min(2).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    rol: rol.optional(),
    activo: z.boolean().optional(),
    ...datosProfesional,
  }).parse(req.body);
  if (uid === req.user!.id && (b.activo === false || (b.rol && b.rol !== 'admin'))) {
    throw new HttpError(422, 'No podés desactivarte ni quitarte el rol de administración a vos mismo');
  }
  const u = await tx(req.user!.id, async db => {
    const { rows: [u] } = await db.query(`
      UPDATE usuarios SET nombre = COALESCE($2, nombre), email = COALESCE($3, email),
             rol = COALESCE($4::rol_usuario, rol), activo = COALESCE($5, activo)
      WHERE id = $1 RETURNING id, nombre, email, rol, activo`,
      [uid, b.nombre ?? null, b.email ?? null, b.rol ?? null, b.activo ?? null]);
    if (!u) throw notFound('Usuario');
    if (u.rol === 'medico') await asegurarProfesional(db, uid, b);
    if (b.activo === false) await db.query('DELETE FROM sesiones WHERE usuario_id = $1', [uid]);
    return u;
  });
  res.json(u);
});

/** El admin le pone una contraseña nueva (por ejemplo, si se la olvidó). Cierra sus sesiones. */
adminRouter.post('/usuarios/:id/password', admin, async (req, res) => {
  const uid = id.parse(req.params.id);
  const { password } = z.object({ password: z.string().min(8, 'La contraseña tiene que tener al menos 8 caracteres') }).parse(req.body);
  const hash = await hashPassword(password);
  await tx(req.user!.id, async db => {
    const r = await db.query('UPDATE usuarios SET password_hash = $2 WHERE id = $1', [uid, hash]);
    if (!r.rowCount) throw notFound('Usuario');
    await db.query('DELETE FROM sesiones WHERE usuario_id = $1', [uid]);
  });
  res.status(204).end();
});

/* ---------- Datos del consultorio ---------- */
adminRouter.get('/consultorio', admin, async (_req, res) => {
  res.json((await q('SELECT * FROM consultorio'))[0] ?? null);
});

adminRouter.put('/consultorio', admin, async (req, res) => {
  const opt = z.string().trim().nullable().optional().transform(v => v || null);
  const b = z.object({
    nombre: z.string().trim().min(2), marca: z.string().trim().min(2), especialidad: z.string().trim().min(2),
    ciudad: opt, direccion: opt, telefono: opt, whatsapp: opt, horarios_texto: opt,
  }).parse(req.body);
  const c = await tx(req.user!.id, async db => (await db.query(`
    INSERT INTO consultorio (id, nombre, marca, especialidad, ciudad, direccion, telefono, whatsapp, horarios_texto)
    VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (id) DO UPDATE SET nombre = $1, marca = $2, especialidad = $3, ciudad = $4, direccion = $5,
      telefono = $6, whatsapp = $7, horarios_texto = $8
    RETURNING *`, [b.nombre, b.marca, b.especialidad, b.ciudad, b.direccion, b.telefono, b.whatsapp, b.horarios_texto])).rows[0]);
  res.json(c);
});

/* ---------- Tipos de turno (estudios) ---------- */
adminRouter.get('/tipos', admin, async (_req, res) => {
  res.json(await q(`SELECT t.*, r.nombre AS recurso, u.nombre AS profesional FROM tipos_turno t
    LEFT JOIN recursos r ON r.id = t.recurso_id
    LEFT JOIN profesionales p ON p.id = t.profesional_id LEFT JOIN usuarios u ON u.id = p.usuario_id
    ORDER BY t.activo DESC, t.id`));
});

const tipoBody = z.object({
  nombre: z.string().trim().min(2),
  descripcion: z.string().trim().nullable().optional(),
  duracion_min: z.number().int().min(5).max(480),
  recurso_id: z.number().int().positive().nullable().optional(),
  profesional_id: z.number().int().positive().nullable().optional(),
  precio_particular: z.number().nonnegative().nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  activo: z.boolean().optional(),
});

adminRouter.post('/tipos', admin, async (req, res) => {
  const b = tipoBody.parse(req.body);
  const t = await tx(req.user!.id, async db => (await db.query(`
    INSERT INTO tipos_turno (nombre, descripcion, duracion_min, recurso_id, profesional_id, precio_particular, color, activo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, true)) RETURNING *`,
    [b.nombre, b.descripcion ?? null, b.duracion_min, b.recurso_id ?? null, b.profesional_id ?? null,
     b.precio_particular ?? null, b.color ?? null, b.activo ?? null])).rows[0]);
  res.status(201).json(t);
});

/** Edición parcial genérica para tablas de configuración: solo columnas que pasaron por zod. */
async function actualizar(usuarioId: number, tabla: string, rid: number, b: Record<string, unknown>) {
  const campos = Object.keys(b);
  if (!campos.length) throw new HttpError(400, 'No hay cambios');
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const r = await tx(usuarioId, async db => (await db.query(
    `UPDATE ${tabla} SET ${sets} WHERE id = $1 RETURNING *`, [rid, ...campos.map(c => b[c] ?? null)])).rows[0]);
  if (!r) throw notFound('Registro');
  return r;
}

adminRouter.patch('/tipos/:id', admin, async (req, res) => {
  res.json(await actualizar(req.user!.id, 'tipos_turno', id.parse(req.params.id), tipoBody.partial().parse(req.body)));
});

/* ---------- Horarios de atención ---------- */
adminRouter.get('/horarios', admin, async (_req, res) => {
  res.json(await q(`SELECT h.id, h.profesional_id, h.dia_semana, to_char(h.desde, 'HH24:MI') AS desde, to_char(h.hasta, 'HH24:MI') AS hasta
    FROM horarios_atencion h ORDER BY h.profesional_id, h.dia_semana, h.desde`));
});

adminRouter.post('/horarios', admin, async (req, res) => {
  const b = z.object({
    profesional_id: z.number().int().positive(),
    dia_semana: z.number().int().min(0).max(6),
    desde: hora, hasta: hora,
  }).parse(req.body);
  if (b.hasta <= b.desde) throw new HttpError(422, 'La hora de fin tiene que ser posterior a la de inicio');
  const h = await tx(req.user!.id, async db => {
    const { rows: [choque] } = await db.query(`SELECT 1 FROM horarios_atencion WHERE profesional_id = $1 AND dia_semana = $2
      AND desde < $4::time AND hasta > $3::time`, [b.profesional_id, b.dia_semana, b.desde, b.hasta]);
    if (choque) throw new HttpError(409, 'Esa franja se superpone con otra del mismo día');
    return (await db.query(`INSERT INTO horarios_atencion (profesional_id, dia_semana, desde, hasta) VALUES ($1,$2,$3,$4)
      RETURNING id, profesional_id, dia_semana, to_char(desde, 'HH24:MI') AS desde, to_char(hasta, 'HH24:MI') AS hasta`,
      [b.profesional_id, b.dia_semana, b.desde, b.hasta])).rows[0];
  });
  res.status(201).json(h);
});

/** Quitar una franja no toca los turnos ya dados: siguen en pie. */
adminRouter.delete('/horarios/:id', admin, async (req, res) => {
  await tx(req.user!.id, db => db.query('DELETE FROM horarios_atencion WHERE id = $1', [id.parse(req.params.id)]));
  res.status(204).end();
});

/* ---------- Obras sociales y equipos ---------- */
adminRouter.get('/obras-sociales', admin, async (_req, res) => {
  res.json(await q(`SELECT o.*, (SELECT count(*) FROM pacientes p WHERE p.obra_social_id = o.id) AS pacientes
    FROM obras_sociales o ORDER BY o.activa DESC, o.nombre`));
});
adminRouter.post('/obras-sociales', admin, async (req, res) => {
  const { nombre } = z.object({ nombre: z.string().trim().min(2) }).parse(req.body);
  res.status(201).json(await tx(req.user!.id, async db =>
    (await db.query('INSERT INTO obras_sociales (nombre) VALUES ($1) RETURNING *', [nombre])).rows[0]));
});
adminRouter.patch('/obras-sociales/:id', admin, async (req, res) => {
  const b = z.object({ nombre: z.string().trim().min(2).optional(), activa: z.boolean().optional() }).parse(req.body);
  res.json(await actualizar(req.user!.id, 'obras_sociales', id.parse(req.params.id), b));
});

adminRouter.get('/recursos', admin, async (_req, res) => {
  res.json(await q('SELECT * FROM recursos ORDER BY activo DESC, id'));
});
adminRouter.post('/recursos', admin, async (req, res) => {
  const { nombre } = z.object({ nombre: z.string().trim().min(2) }).parse(req.body);
  res.status(201).json(await tx(req.user!.id, async db =>
    (await db.query('INSERT INTO recursos (nombre) VALUES ($1) RETURNING *', [nombre])).rows[0]));
});
adminRouter.patch('/recursos/:id', admin, async (req, res) => {
  const b = z.object({ nombre: z.string().trim().min(2).optional(), activo: z.boolean().optional() }).parse(req.body);
  res.json(await actualizar(req.user!.id, 'recursos', id.parse(req.params.id), b));
});
