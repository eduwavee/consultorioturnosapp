import { config } from './config.js';
import { q, type Db } from './db.js';

/** Estados que ocupan la agenda (igual que los EXCLUDE del schema). */
export const OCUPA = `x.estado::text NOT IN ('cancelado', 'ausente')
  AND NOT (x.estado::text = 'pendiente' AND x.expira_at < now())`;

/**
 * Horarios libres para un tipo de turno, calculados íntegramente en SQL:
 * franjas de horarios_atencion cada 10 min, menos turnos que chocan por
 * profesional o por equipo, menos bloqueos. Misma regla que usa la base
 * para rechazar un INSERT, así lo que se muestra es lo que se puede reservar.
 */
export async function disponibilidad(tipoId: number, desde: string, dias: number) {
  const rows = await q<{ dia: string; inicio: Date }>(`
    WITH t AS (
      SELECT id, duracion_min, recurso_id, profesional_id,
             make_interval(mins => duracion_min) AS dur
      FROM tipos_turno WHERE id = $1 AND activo AND profesional_id IS NOT NULL
    ), dias AS (
      SELECT d::date AS dia
      FROM generate_series($2::date, $2::date + ($3::int - 1), interval '1 day') d
    )
    SELECT to_char(dias.dia, 'YYYY-MM-DD') AS dia, s AS inicio
    FROM t
    CROSS JOIN dias
    JOIN horarios_atencion h
      ON h.profesional_id = t.profesional_id AND h.dia_semana = EXTRACT(DOW FROM dias.dia)
    CROSS JOIN LATERAL generate_series(
      (dias.dia + h.desde) AT TIME ZONE $4,
      ((dias.dia + h.hasta) AT TIME ZONE $4) - t.dur,
      interval '10 minutes'
    ) s
    WHERE s >= now() + interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM turnos x
        WHERE ${OCUPA}
          AND tstzrange(x.inicio, x.fin) && tstzrange(s, s + t.dur)
          AND ((x.profesional_id = t.profesional_id AND NOT x.sobreturno)
               OR (t.recurso_id IS NOT NULL AND x.recurso_id = t.recurso_id))
      )
      AND NOT EXISTS (
        SELECT 1 FROM bloqueos_agenda b
        WHERE b.profesional_id = t.profesional_id
          AND tstzrange(b.inicio, b.fin) && tstzrange(s, s + t.dur)
      )
    ORDER BY s`, [tipoId, desde, dias, config.tz]);

  const bloqueos = await q(`
    SELECT b.inicio, b.fin, b.motivo
    FROM bloqueos_agenda b JOIN tipos_turno t ON t.profesional_id = b.profesional_id
    WHERE t.id = $1 AND b.fin > ($2::date)::timestamp AT TIME ZONE $4
      AND b.inicio < (($2::date + $3::int)::timestamp) AT TIME ZONE $4`, [tipoId, desde, dias, config.tz]);

  const porDia = new Map<string, string[]>();
  for (const r of rows) {
    if (!porDia.has(r.dia)) porDia.set(r.dia, []);
    porDia.get(r.dia)!.push(r.inicio.toISOString());
  }
  return { dias: [...porDia].map(([fecha, slots]) => ({ fecha, slots })), bloqueos };
}

/** Máquina de estados del turno: qué transiciones están permitidas. */
export const TRANSICIONES: Record<string, string[]> = {
  pendiente: ['reservado', 'cancelado'],
  reservado: ['confirmado', 'en_sala', 'cancelado', 'ausente'],
  confirmado: ['en_sala', 'cancelado', 'ausente'],
  en_sala: ['atendido'],
  atendido: [],
  cancelado: [],
  ausente: [],
};

/** "sábado 3 de octubre a las 10:30 h", en hora del consultorio. */
export function fmtFecha(d: Date) {
  const dia = d.toLocaleDateString('es-AR', { timeZone: config.tz, weekday: 'long', day: 'numeric', month: 'long' });
  const hora = d.toLocaleTimeString('es-AR', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${dia} a las ${hora} h`;
}

/** Link que recibe el paciente para confirmar, cancelar o cambiar su turno. */
export const linkGestion = (token: string) => `${config.publicUrl}/turno?t=${token}`;

/** Link a la landing con el estudio y el horario ya elegidos (aviso de lista de espera). */
export const linkReserva = (tipoId: number, inicio: Date) =>
  `${config.publicUrl}/?tipo=${tipoId}&inicio=${encodeURIComponent(inicio.toISOString())}#turnos`;

/**
 * ¿Sigue libre ese horario para ese tipo de turno? Mismas reglas que la
 * disponibilidad pública: profesional, equipo, bloqueos y anticipación.
 */
export async function horarioLibre(db: Db, tipoId: number, inicio: Date | string): Promise<boolean> {
  const { rows: [r] } = await db.query(`
    SELECT NOT EXISTS (
             SELECT 1 FROM turnos x
             WHERE ${OCUPA}
               AND tstzrange(x.inicio, x.fin) && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => t.duracion_min))
               AND ((x.profesional_id = t.profesional_id AND NOT x.sobreturno)
                    OR (t.recurso_id IS NOT NULL AND x.recurso_id = t.recurso_id)))
       AND NOT EXISTS (
             SELECT 1 FROM bloqueos_agenda b
             WHERE b.profesional_id = t.profesional_id
               AND tstzrange(b.inicio, b.fin) && tstzrange($2::timestamptz, $2::timestamptz + make_interval(mins => t.duracion_min)))
       AND $2::timestamptz >= now() + interval '1 hour' AS libre
    FROM tipos_turno t WHERE t.id = $1 AND t.activo`, [tipoId, inicio]);
  return !!r?.libre;
}

export async function programarRecordatorio(db: Db, turnoId: number) {
  await db.query(`
    INSERT INTO recordatorios (turno_id, programado_para)
    SELECT id, GREATEST(inicio - interval '24 hours', now()) FROM turnos WHERE id = $1`, [turnoId]);
}
