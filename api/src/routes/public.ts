import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { disponibilidad, linkGestion, programarRecordatorio } from '../lib/agenda.js';
import { config } from '../lib/config.js';
import { q, tx, type Db } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

export const publicRouter = Router();

// Freno contra bots que intenten retener toda la agenda
const limiteReservas = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.PUBLIC_RATE_LIMIT ?? 20),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá un minuto.' },
});

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato AAAA-MM-DD');

/** Datos del consultorio para la landing (nombre, contacto, horarios). */
publicRouter.get('/consultorio', async (_req, res) => {
  const [c] = await q('SELECT nombre, marca, especialidad, ciudad, direccion, telefono, whatsapp, horarios_texto FROM consultorio');
  res.json(c ?? null);
});

publicRouter.get('/tipos', async (_req, res) => {
  res.json(await q(`
    SELECT t.id, t.nombre, t.descripcion, t.duracion_min, t.recurso_id, t.profesional_id, u.nombre AS profesional
    FROM tipos_turno t
    JOIN profesionales p ON p.id = t.profesional_id
    JOIN usuarios u ON u.id = p.usuario_id
    WHERE t.activo ORDER BY t.id`));
});

publicRouter.get('/disponibilidad', async (req, res) => {
  const { tipo, desde, dias } = z.object({
    tipo: z.coerce.number().int().positive(),
    desde: fecha.optional(),
    dias: z.coerce.number().int().min(1).max(31).default(14),
  }).parse(req.query);
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: config.tz });
  res.json(await disponibilidad(tipo, desde ?? hoy, dias));
});

/** Paso 1: retener el horario 5 minutos. Si alguien llegó antes, la base devuelve 23P01 → 409. */
publicRouter.post('/retenciones', limiteReservas, async (req, res) => {
  const body = z.object({
    tipo_turno_id: z.number().int().positive(),
    inicio: z.string().datetime({ offset: true }),
  }).parse(req.body);

  const turno = await tx(null, async db => {
    await db.query('SELECT liberar_turnos_vencidos()');
    const { rows: [tipo] } = await db.query('SELECT profesional_id FROM tipos_turno WHERE id = $1 AND activo', [body.tipo_turno_id]);
    if (!tipo?.profesional_id) throw new HttpError(422, 'Ese estudio no se puede reservar online');
    const { rows: [t] } = await db.query(`
      INSERT INTO turnos (profesional_id, tipo_turno_id, inicio, estado, expira_at, origen, token_retencion)
      VALUES ($1, $2, $3, 'pendiente', now() + make_interval(mins => $4), 'web', gen_random_uuid())
      RETURNING id, inicio, fin, expira_at, token_retencion AS token`,
      [tipo.profesional_id, body.tipo_turno_id, body.inicio, config.holdMinutes]);
    return t;
  });
  res.status(201).json(turno);
});

/** Liberar la retención (el paciente cambió de horario o cerró la página). */
publicRouter.delete('/retenciones/:token', async (req, res) => {
  const token = z.string().uuid().parse(req.params.token);
  await tx(null, db => db.query(`
    UPDATE turnos SET estado = 'cancelado', token_retencion = NULL
    WHERE token_retencion = $1 AND estado = 'pendiente'`, [token]));
  res.status(204).end();
});

/** Igual que DELETE, pero por POST: es lo único que puede mandar navigator.sendBeacon al cerrar la página. */
publicRouter.post('/retenciones/:token/liberar', async (req, res) => {
  const token = z.string().uuid().parse(req.params.token);
  await tx(null, db => db.query(`
    UPDATE turnos SET estado = 'cancelado', token_retencion = NULL
    WHERE token_retencion = $1 AND estado = 'pendiente'`, [token]));
  res.status(204).end();
});

/** Paso 2: confirmar con los datos del paciente. */
publicRouter.post('/retenciones/:token/confirmar', limiteReservas, async (req, res) => {
  const token = z.string().uuid().parse(req.params.token);
  const body = z.object({
    nombre: z.string().trim().min(3).refine(v => v.split(/\s+/).length >= 2, 'Ingresá nombre y apellido'),
    dni: z.string().trim().regex(/^\d{7,8}$/, 'El DNI tiene 7 u 8 números'),
    telefono: z.string().trim().refine(v => v.replace(/\D/g, '').length >= 10, 'Teléfono inválido'),
    cobertura: z.enum(['Particular', 'Obra social', 'Prepaga']).default('Particular'),
  }).parse(req.body);

  const out = await tx(null, async db => {
    const { rows: [t] } = await db.query(
      `SELECT id, estado, expira_at < now() AS vencido FROM turnos WHERE token_retencion = $1 FOR UPDATE`, [token]);
    if (!t || t.estado !== 'pendiente') throw new HttpError(404, 'La reserva no existe o ya fue usada');
    if (t.vencido) throw new HttpError(410, 'Se venció el tiempo de reserva. Elegí el horario de nuevo.');

    const partes = body.nombre.split(/\s+/);
    const apellido = partes.pop()!;
    const { rows: [p] } = await db.query(`
      INSERT INTO pacientes (dni, nombre, apellido, telefono, obra_social_id, notas_admin)
      VALUES ($1, $2, $3, $4,
              (SELECT id FROM obras_sociales WHERE nombre = 'Particular' AND $5 = 'Particular'),
              CASE WHEN $5 <> 'Particular' THEN 'Cobertura declarada online: ' || $5 END)
      -- Un DNI ya cargado no alcanza para cambiar el teléfono (ahí llegan los recordatorios):
      -- se conserva el original y el nuevo queda anotado para que lo revise la secretaria
      ON CONFLICT (dni) DO UPDATE SET
        telefono = COALESCE(pacientes.telefono, EXCLUDED.telefono),
        notas_admin = CASE
          WHEN pacientes.telefono IS NOT NULL
               AND regexp_replace(pacientes.telefono, '\\D', '', 'g') <> regexp_replace(EXCLUDED.telefono, '\\D', '', 'g')
          THEN concat_ws(E'\\n', pacientes.notas_admin, 'Teléfono distinto declarado online (sin verificar): ' || EXCLUDED.telefono)
          ELSE pacientes.notas_admin END
      RETURNING id`, [body.dni, partes.join(' '), apellido, body.telefono, body.cobertura]);

    const { rows: [conf] } = await db.query(`
      UPDATE turnos SET paciente_id = $2, estado = 'reservado', expira_at = NULL, token_retencion = NULL
      WHERE id = $1
      RETURNING id, inicio, fin, token_gestion, (SELECT nombre FROM tipos_turno WHERE id = tipo_turno_id) AS tipo`, [t.id, p.id]);
    await programarRecordatorio(db, t.id);
    return { ...conf, link_gestion: linkGestion(conf.token_gestion) };
  });
  res.json(out);
});

/* ---------- Autogestión: el paciente maneja su turno con el link del WhatsApp ---------- */

/** Hasta cuántas horas antes el paciente puede cancelar o mover el turno por su cuenta. */
const HORAS_MINIMAS_GESTION = 2;

const turnoPorToken = `
  SELECT t.id, t.inicio, t.fin, t.estado, t.tipo_turno_id, tt.nombre AS tipo, u.nombre AS profesional,
         p.nombre AS paciente, t.inicio > now() + make_interval(hours => ${HORAS_MINIMAS_GESTION}) AS gestionable
  FROM turnos t
  JOIN tipos_turno tt ON tt.id = t.tipo_turno_id
  JOIN profesionales pr ON pr.id = t.profesional_id JOIN usuarios u ON u.id = pr.usuario_id
  JOIN pacientes p ON p.id = t.paciente_id
  WHERE t.token_gestion = $1`;

async function gestionable(db: Db, token: string) {
  const { rows: [t] } = await db.query(`${turnoPorToken} FOR UPDATE OF t`, [token]);
  if (!t) throw new HttpError(404, 'No encontramos ese turno. Revisá el link.');
  if (!['reservado', 'confirmado'].includes(t.estado)) throw new HttpError(422, `Este turno ya está ${t.estado.replace('_', ' ')}.`);
  if (!t.gestionable) throw new HttpError(422, `Faltan menos de ${HORAS_MINIMAS_GESTION} horas: para cambios, comunicate con el consultorio.`);
  return t;
}

const tokenGestion = z.string().uuid('Link inválido');

publicRouter.get('/turnos/:token', async (req, res) => {
  const [t] = await q(turnoPorToken, [tokenGestion.parse(req.params.token)]);
  if (!t) throw new HttpError(404, 'No encontramos ese turno. Revisá el link.');
  // Solo lo necesario: el link puede reenviarse, así que nada de DNI ni teléfono
  const { id: _id, ...publico } = t;
  res.json(publico);
});

publicRouter.post('/turnos/:token/confirmar', limiteReservas, async (req, res) => {
  const token = tokenGestion.parse(req.params.token);
  const out = await tx(null, async db => {
    const t = await gestionable(db, token);
    const { rows: [r] } = await db.query(`UPDATE turnos SET estado = 'confirmado' WHERE id = $1 RETURNING estado`, [t.id]);
    return r;
  });
  res.json(out);
});

publicRouter.post('/turnos/:token/cancelar', limiteReservas, async (req, res) => {
  const token = tokenGestion.parse(req.params.token);
  const out = await tx(null, async db => {
    const t = await gestionable(db, token);
    const { rows: [r] } = await db.query(`UPDATE turnos SET estado = 'cancelado' WHERE id = $1 RETURNING estado`, [t.id]);
    return r;
  });
  res.json(out);
});

/** Mover el turno a otro horario libre del mismo estudio. */
publicRouter.post('/turnos/:token/reprogramar', limiteReservas, async (req, res) => {
  const token = tokenGestion.parse(req.params.token);
  const { inicio } = z.object({ inicio: z.string().datetime({ offset: true }) }).parse(req.body);
  const out = await tx(null, async db => {
    await db.query('SELECT liberar_turnos_vencidos()');
    const t = await gestionable(db, token);
    // Solo horarios que la agenda ofrece al público (horario de atención incluido)
    const dia = new Date(inicio).toLocaleDateString('en-CA', { timeZone: config.tz });
    const disp = await disponibilidad(t.tipo_turno_id, dia, 1);
    const pedido = new Date(inicio).getTime();
    if (!disp.dias.some(d => d.slots.some(s => new Date(s).getTime() === pedido))) {
      throw new HttpError(409, 'Ese horario ya no está disponible. Elegí otro.');
    }
    const { rows: [r] } = await db.query(`
      UPDATE turnos SET inicio = $2, estado = 'reservado' WHERE id = $1 RETURNING inicio, fin, estado`, [t.id, inicio]);
    await db.query(`UPDATE recordatorios SET estado = 'cancelado' WHERE turno_id = $1 AND estado = 'pendiente'`, [t.id]);
    await programarRecordatorio(db, t.id);
    return r;
  });
  res.json(out);
});
