import { Router } from 'express';
import { z } from 'zod';
import { OCUPA, programarRecordatorio, TRANSICIONES } from '../lib/agenda.js';
import { requireRol } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { q, tx } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';

export const agendaRouter = Router();
const staff = requireRol('admin', 'medico', 'secretaria');
const id = z.coerce.number().int().positive();

/* ---------- Catálogos ---------- */
agendaRouter.get('/catalogos', staff, async (_req, res) => {
  const [tipos, profesionales, recursos, obras, horarios, [consultorio]] = await Promise.all([
    q('SELECT id, nombre, duracion_min, recurso_id, profesional_id, color, precio_particular FROM tipos_turno WHERE activo ORDER BY id'),
    q('SELECT p.id, u.nombre, p.especialidad, p.titulo FROM profesionales p JOIN usuarios u ON u.id = p.usuario_id WHERE u.activo ORDER BY p.id'),
    q('SELECT id, nombre FROM recursos WHERE activo ORDER BY id'),
    q('SELECT id, nombre FROM obras_sociales WHERE activa ORDER BY nombre'),
    q(`SELECT profesional_id, dia_semana, to_char(desde, 'HH24:MI') AS desde, to_char(hasta, 'HH24:MI') AS hasta
       FROM horarios_atencion ORDER BY profesional_id, dia_semana, desde`),
    q('SELECT nombre, marca, especialidad FROM consultorio'),
  ]);
  res.json({ tipos, profesionales, recursos, obras_sociales: obras, horarios, consultorio: consultorio ?? null });
});

/* ---------- Agenda (un día o una semana) ---------- */
const SELECT_TURNO = `
    SELECT x.id, x.inicio, x.fin, x.estado, x.sobreturno, x.origen, x.profesional_id, x.recurso_id, x.tipo_turno_id,
           tt.nombre AS tipo, tt.color, tt.precio_particular AS precio, r.nombre AS recurso,
           p.id AS paciente_id, p.nombre || ' ' || p.apellido AS paciente, p.dni, p.telefono,
           u.nombre AS profesional,
           EXISTS (SELECT 1 FROM pagos pg WHERE pg.turno_id = x.id AND NOT pg.anulado) AS cobrado
    FROM turnos x`;
agendaRouter.get('/turnos', staff, async (req, res) => {
  const f = z.object({
    dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dias: z.coerce.number().int().min(1).max(7).default(1),
    profesional: z.coerce.number().int().positive().optional(),
  }).parse(req.query);
  const turnos = await q(`${SELECT_TURNO}
    JOIN tipos_turno tt ON tt.id = x.tipo_turno_id
    JOIN profesionales pr ON pr.id = x.profesional_id
    JOIN usuarios u ON u.id = pr.usuario_id
    LEFT JOIN pacientes p ON p.id = x.paciente_id
    LEFT JOIN recursos r ON r.id = x.recurso_id
    WHERE x.inicio >= ($1::date)::timestamp AT TIME ZONE $2
      AND x.inicio <  ($1::date + $3::int)::timestamp AT TIME ZONE $2
      AND ($4::bigint IS NULL OR x.profesional_id = $4)
      AND NOT (x.estado::text = 'pendiente' AND x.expira_at < now())
    ORDER BY x.inicio, x.profesional_id`, [f.dia, config.tz, f.dias, f.profesional ?? null]);
  const bloqueos = await q(`
    SELECT id, profesional_id, inicio, fin, motivo FROM bloqueos_agenda
    WHERE fin > ($1::date)::timestamp AT TIME ZONE $2 AND inicio < ($1::date + $3::int)::timestamp AT TIME ZONE $2
      AND ($4::bigint IS NULL OR profesional_id = $4)`, [f.dia, config.tz, f.dias, f.profesional ?? null]);
  res.json({ turnos, bloqueos });
});

agendaRouter.get('/turnos/:id', staff, async (req, res) => {
  const [t] = await q(`${SELECT_TURNO}
    JOIN tipos_turno tt ON tt.id = x.tipo_turno_id
    JOIN profesionales pr ON pr.id = x.profesional_id
    JOIN usuarios u ON u.id = pr.usuario_id
    LEFT JOIN pacientes p ON p.id = x.paciente_id
    LEFT JOIN recursos r ON r.id = x.recurso_id
    WHERE x.id = $1`, [id.parse(req.params.id)]);
  if (!t) throw notFound('Turno');
  res.json(t);
});

/* ---------- Alta de turno desde el consultorio ---------- */
agendaRouter.post('/turnos', staff, async (req, res) => {
  const b = z.object({
    paciente_id: z.number().int().positive(),
    tipo_turno_id: z.number().int().positive(),
    profesional_id: z.number().int().positive().optional(),
    inicio: z.string().datetime({ offset: true }),
    sobreturno: z.boolean().default(false),
  }).parse(req.body);
  if (b.sobreturno && req.user!.rol === 'secretaria') {
    throw new HttpError(403, 'Solo el médico puede habilitar un sobreturno');
  }
  const turno = await tx(req.user!.id, async db => {
    // Una retención web vencida que el worker todavía no liberó no debe bloquear el horario
    await db.query('SELECT liberar_turnos_vencidos()');
    const { rows: [tipo] } = await db.query('SELECT profesional_id FROM tipos_turno WHERE id = $1', [b.tipo_turno_id]);
    const prof = b.profesional_id ?? tipo?.profesional_id;
    if (!prof) throw new HttpError(422, 'Indicá qué profesional atiende');
    const { rows: [t] } = await db.query(`
      INSERT INTO turnos (paciente_id, profesional_id, tipo_turno_id, inicio, sobreturno, creado_por, origen)
      VALUES ($1, $2, $3, $4, $5, $6, 'secretaria') RETURNING *`,
      [b.paciente_id, prof, b.tipo_turno_id, b.inicio, b.sobreturno, req.user!.id]);
    await programarRecordatorio(db, t.id);
    return t;
  });
  res.status(201).json(turno);
});

/* ---------- Cambio de estado con máquina de estados ---------- */
agendaRouter.patch('/turnos/:id/estado', staff, async (req, res) => {
  const turnoId = id.parse(req.params.id);
  const { estado } = z.object({ estado: z.enum(['confirmado', 'en_sala', 'atendido', 'cancelado', 'ausente']) }).parse(req.body);
  const t = await tx(req.user!.id, async db => {
    const { rows: [actual] } = await db.query('SELECT estado FROM turnos WHERE id = $1 FOR UPDATE', [turnoId]);
    if (!actual) throw notFound('Turno');
    if (!TRANSICIONES[actual.estado]?.includes(estado)) {
      throw new HttpError(422, `Un turno ${actual.estado.replace('_', ' ')} no puede pasar a ${estado.replace('_', ' ')}`);
    }
    const { rows: [t] } = await db.query('UPDATE turnos SET estado = $2 WHERE id = $1 RETURNING id, estado', [turnoId, estado]);
    return t;
  });
  res.json(t);
});

/* ---------- Reprogramar (p. ej. turnos que quedaron adentro de un bloqueo) ---------- */
agendaRouter.patch('/turnos/:id/horario', staff, async (req, res) => {
  const turnoId = id.parse(req.params.id);
  const { inicio } = z.object({ inicio: z.string().datetime({ offset: true }) }).parse(req.body);
  const t = await tx(req.user!.id, async db => {
    await db.query('SELECT liberar_turnos_vencidos()');
    const { rows: [actual] } = await db.query('SELECT estado FROM turnos WHERE id = $1 FOR UPDATE', [turnoId]);
    if (!actual) throw notFound('Turno');
    if (!['reservado', 'confirmado'].includes(actual.estado)) {
      throw new HttpError(422, `Un turno ${actual.estado.replace('_', ' ')} no se puede reprogramar`);
    }
    // El paciente había confirmado otro horario: el nuevo vuelve a quedar reservado hasta que confirme
    const { rows: [t] } = await db.query(`
      UPDATE turnos SET inicio = $2, estado = 'reservado' WHERE id = $1
      RETURNING id, inicio, fin, estado`, [turnoId, inicio]);
    await db.query(`UPDATE recordatorios SET estado = 'cancelado' WHERE turno_id = $1 AND estado = 'pendiente'`, [turnoId]);
    await programarRecordatorio(db, turnoId);
    return t;
  });
  res.json(t);
});

/* ---------- Pacientes ---------- */
const pacienteBody = z.object({
  dni: z.string().trim().regex(/^\d{7,8}$/, 'El DNI tiene 7 u 8 números'),
  nombre: z.string().trim().min(1),
  apellido: z.string().trim().min(1),
  fecha_nac: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  telefono: z.string().trim().nullable().optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal('').transform(() => null)),
  obra_social_id: z.number().int().positive().nullable().optional(),
  nro_afiliado: z.string().trim().nullable().optional(),
  notas_admin: z.string().trim().nullable().optional(),
});

agendaRouter.get('/pacientes', staff, async (req, res) => {
  const { q: texto } = z.object({ q: z.string().trim().default('') }).parse(req.query);
  res.json(await q(`
    SELECT p.id, p.dni, p.nombre, p.apellido, p.telefono, o.nombre AS obra_social,
           (SELECT min(inicio) FROM turnos t WHERE t.paciente_id = p.id AND t.inicio > now()
              AND t.estado::text IN ('reservado', 'confirmado')) AS proximo_turno
    FROM pacientes p LEFT JOIN obras_sociales o ON o.id = p.obra_social_id
    WHERE $1 = '' OR p.dni LIKE $1 || '%'
       OR unaccent_simple(p.nombre || ' ' || p.apellido) ILIKE '%' || unaccent_simple($1) || '%'
    ORDER BY p.apellido, p.nombre LIMIT 50`, [texto]));
});

agendaRouter.get('/pacientes/:id', staff, async (req, res) => {
  const pid = id.parse(req.params.id);
  const [p] = await q(`SELECT p.*, o.nombre AS obra_social FROM pacientes p
                       LEFT JOIN obras_sociales o ON o.id = p.obra_social_id WHERE p.id = $1`, [pid]);
  if (!p) throw notFound('Paciente');
  const turnos = await q(`
    SELECT t.id, t.inicio, t.estado, tt.nombre AS tipo FROM turnos t
    JOIN tipos_turno tt ON tt.id = t.tipo_turno_id
    WHERE t.paciente_id = $1 ORDER BY t.inicio DESC LIMIT 30`, [pid]);
  res.json({ ...p, turnos });
});

agendaRouter.post('/pacientes', staff, async (req, res) => {
  const b = pacienteBody.parse(req.body);
  const [p] = await tx(req.user!.id, async db => (await db.query(`
    INSERT INTO pacientes (dni, nombre, apellido, fecha_nac, telefono, email, obra_social_id, nro_afiliado, notas_admin)
    VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),$7,$8,$9) RETURNING *`,
    [b.dni, b.nombre, b.apellido, b.fecha_nac ?? null, b.telefono ?? null, b.email ?? null,
     b.obra_social_id ?? null, b.nro_afiliado ?? null, b.notas_admin ?? null])).rows);
  res.status(201).json(p);
});

agendaRouter.patch('/pacientes/:id', staff, async (req, res) => {
  const pid = id.parse(req.params.id);
  const b = pacienteBody.partial().parse(req.body);
  const campos = Object.keys(b);
  if (!campos.length) throw new HttpError(400, 'No hay cambios');
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const p = await tx(req.user!.id, async db => (await db.query(
    `UPDATE pacientes SET ${sets} WHERE id = $1 RETURNING *`, [pid, ...campos.map(c => (b as any)[c])])).rows[0]);
  if (!p) throw notFound('Paciente');
  res.json(p);
});

/* ---------- Lista de espera ---------- */
agendaRouter.get('/lista-espera', staff, async (req, res) => {
  const { todos } = z.object({ todos: z.enum(['0', '1']).default('0') }).parse(req.query);
  res.json(await q(`
    SELECT le.id, le.paciente_id, le.tipo_turno_id, to_char(le.desde, 'YYYY-MM-DD') AS desde, to_char(le.hasta, 'YYYY-MM-DD') AS hasta,
           le.notas, le.avisado_at, le.resuelto_at, le.creado_at,
           p.nombre || ' ' || p.apellido AS paciente, p.telefono, tt.nombre AS tipo,
           (SELECT min(t.inicio) FROM turnos t WHERE t.paciente_id = le.paciente_id AND t.tipo_turno_id = le.tipo_turno_id
              AND t.inicio > now() AND t.estado::text IN ('reservado', 'confirmado')) AS turno_actual
    FROM lista_espera le JOIN pacientes p ON p.id = le.paciente_id JOIN tipos_turno tt ON tt.id = le.tipo_turno_id
    WHERE $1 OR le.resuelto_at IS NULL
    ORDER BY le.resuelto_at NULLS FIRST, le.creado_at`, [todos === '1']));
});

const fechaOpt = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional();
agendaRouter.post('/lista-espera', staff, async (req, res) => {
  const b = z.object({
    paciente_id: z.number().int().positive(),
    tipo_turno_id: z.number().int().positive(),
    desde: fechaOpt,
    hasta: fechaOpt,
    notas: z.string().trim().max(500).nullable().optional(),
  }).parse(req.body);
  const le = await tx(req.user!.id, async db => {
    const { rows: [ya] } = await db.query(
      'SELECT id FROM lista_espera WHERE paciente_id = $1 AND tipo_turno_id = $2 AND resuelto_at IS NULL', [b.paciente_id, b.tipo_turno_id]);
    if (ya) throw new HttpError(409, 'Ese paciente ya está en la lista de espera para ese estudio');
    const { rows: [p] } = await db.query('SELECT telefono FROM pacientes WHERE id = $1', [b.paciente_id]);
    if (!p) throw notFound('Paciente');
    if (!p.telefono) throw new HttpError(422, 'El paciente no tiene WhatsApp cargado: no le podríamos avisar');
    return (await db.query(`INSERT INTO lista_espera (paciente_id, tipo_turno_id, desde, hasta, notas, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.paciente_id, b.tipo_turno_id, b.desde ?? null, b.hasta ?? null, b.notas ?? null, req.user!.id])).rows[0];
  });
  res.status(201).json(le);
});

/** Sale de la lista (consiguió turno o ya no le interesa). No se borra: queda el historial. */
agendaRouter.post('/lista-espera/:id/resolver', staff, async (req, res) => {
  const r = await tx(req.user!.id, db => db.query(
    'UPDATE lista_espera SET resuelto_at = now() WHERE id = $1 AND resuelto_at IS NULL RETURNING id', [id.parse(req.params.id)]));
  if (!r.rowCount) throw new HttpError(422, 'Esa entrada no existe o ya estaba resuelta');
  res.status(204).end();
});

/* ---------- Bloqueos de agenda ---------- */
agendaRouter.get('/bloqueos', staff, async (_req, res) => {
  res.json(await q(`SELECT b.*, u.nombre AS profesional FROM bloqueos_agenda b
    JOIN profesionales p ON p.id = b.profesional_id JOIN usuarios u ON u.id = p.usuario_id
    WHERE b.fin > now() ORDER BY b.inicio`));
});

agendaRouter.post('/bloqueos', requireRol('admin', 'medico'), async (req, res) => {
  const b = z.object({
    profesional_id: z.number().int().positive(),
    inicio: z.string().datetime({ offset: true }),
    fin: z.string().datetime({ offset: true }),
    motivo: z.string().trim().min(3),
  }).parse(req.body);
  const out = await tx(req.user!.id, async db => {
    const { rows: [bl] } = await db.query(`INSERT INTO bloqueos_agenda (profesional_id, inicio, fin, motivo)
      VALUES ($1,$2,$3,$4) RETURNING *`, [b.profesional_id, b.inicio, b.fin, b.motivo]);
    // El trigger impide turnos nuevos sobre el bloqueo; los existentes hay que reprogramarlos
    const { rows: afectados } = await db.query(`
      SELECT x.id, x.inicio, p.nombre || ' ' || p.apellido AS paciente, p.telefono
      FROM turnos x LEFT JOIN pacientes p ON p.id = x.paciente_id
      WHERE x.profesional_id = $1 AND ${OCUPA}
        AND tstzrange(x.inicio, x.fin) && tstzrange($2, $3) ORDER BY x.inicio`, [b.profesional_id, b.inicio, b.fin]);
    return { bloqueo: bl, turnos_afectados: afectados };
  });
  res.status(201).json(out);
});

agendaRouter.delete('/bloqueos/:id', requireRol('admin', 'medico'), async (req, res) => {
  await tx(req.user!.id, db => db.query('DELETE FROM bloqueos_agenda WHERE id = $1', [id.parse(req.params.id)]));
  res.status(204).end();
});
