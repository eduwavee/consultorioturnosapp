import { fileURLToPath } from 'node:url';
import { fmtFecha, horarioLibre, linkGestion, linkReserva } from './lib/agenda.js';
import { config } from './lib/config.js';
import { pool, tx, type Db } from './lib/db.js';
import { proveedor, type Mensaje } from './lib/whatsapp.js';

/** Libera retenciones vencidas. */
export async function liberarVencidos(): Promise<number> {
  const { rows: [r] } = await pool.query('SELECT liberar_turnos_vencidos() AS n');
  return r.n;
}

/** Envía un mensaje y deja el resultado en la fila. Reintenta hasta 3 veces. */
async function despachar(db: Db, tabla: 'recordatorios' | 'mensajes', id: number, m: Mensaje): Promise<boolean> {
  try {
    await proveedor().enviar(m);
    await db.query(`UPDATE ${tabla} SET estado = 'enviado', enviado_at = now(), intentos = intentos + 1 WHERE id = $1`, [id]);
    return true;
  } catch (e: any) {
    await db.query(`UPDATE ${tabla} SET intentos = intentos + 1, ultimo_error = $2,
      estado = CASE WHEN intentos + 1 >= 3 THEN 'error' ELSE 'pendiente' END,
      programado_para = now() + interval '10 minutes' WHERE id = $1`, [id, String(e.message).slice(0, 500)]);
    return false;
  }
}

/**
 * Envía los recordatorios que ya tocan. FOR UPDATE SKIP LOCKED permite correr
 * varios workers a la vez sin mandar dos veces el mismo mensaje.
 */
export async function enviarRecordatorios(lote = 20): Promise<{ enviados: number; errores: number }> {
  let enviados = 0, errores = 0;
  await tx(null, async db => {
    const { rows } = await db.query(`
      SELECT r.id, t.inicio, t.token_gestion, p.telefono, p.nombre, tt.nombre AS tipo
      FROM recordatorios r
      JOIN turnos t ON t.id = r.turno_id
      JOIN pacientes p ON p.id = t.paciente_id
      JOIN tipos_turno tt ON tt.id = t.tipo_turno_id
      WHERE r.estado = 'pendiente' AND r.programado_para <= now()
        AND t.estado::text IN ('reservado', 'confirmado') AND t.inicio > now()
      ORDER BY r.programado_para LIMIT $1
      FOR UPDATE OF r SKIP LOCKED`, [lote]);
    for (const r of rows) {
      if (!r.telefono) { await db.query(`UPDATE recordatorios SET estado = 'error', ultimo_error = 'Sin teléfono' WHERE id = $1`, [r.id]); errores++; continue; }
      const tipo = r.tipo.toLowerCase(), cuando = fmtFecha(r.inicio), link = linkGestion(r.token_gestion);
      const ok = await despachar(db, 'recordatorios', r.id, {
        telefono: r.telefono,
        texto: `Hola ${r.nombre}, te recordamos tu turno de ${tipo} el ${cuando}. Respondé CONFIRMO o CANCELAR, o gestionalo acá: ${link}`,
        plantilla: config.whatsappPlantillaRecordatorio
          ? { nombre: config.whatsappPlantillaRecordatorio, parametros: [r.nombre, tipo, cuando, link] } : undefined,
      });
      ok ? enviados++ : errores++;
    }
  });
  return { enviados, errores };
}

/** Avisos a la lista de espera y respuestas al paciente. */
export async function enviarMensajes(lote = 20): Promise<{ enviados: number; errores: number }> {
  let enviados = 0, errores = 0;
  await tx(null, async db => {
    const { rows } = await db.query(`
      SELECT id, telefono, texto, plantilla, parametros FROM mensajes
      WHERE estado = 'pendiente' AND programado_para <= now()
      ORDER BY programado_para LIMIT $1 FOR UPDATE SKIP LOCKED`, [lote]);
    for (const m of rows) {
      const plantilla = m.plantilla ? { nombre: m.plantilla, parametros: m.parametros ?? [] } : undefined;
      (await despachar(db, 'mensajes', m.id, { telefono: m.telefono, texto: m.texto, plantilla })) ? enviados++ : errores++;
    }
  });
  return { enviados, errores };
}

/** Cuántas personas de la lista de espera se avisan por cada horario liberado. Reserva el primero que llega. */
const AVISOS_POR_HUECO = 3;

/**
 * Ofrece los horarios liberados a la lista de espera. Solo avisa si el horario
 * sigue libre (puede que la secretaria ya lo haya dado o que haya un bloqueo).
 */
export async function procesarHuecos(lote = 20): Promise<number> {
  let avisos = 0;
  await tx(null, async db => {
    const { rows: huecos } = await db.query(`
      SELECT h.id, h.tipo_turno_id, h.inicio, tt.nombre AS tipo
      FROM huecos_liberados h JOIN tipos_turno tt ON tt.id = h.tipo_turno_id
      WHERE h.procesado_at IS NULL ORDER BY h.creado_at LIMIT $1
      FOR UPDATE OF h SKIP LOCKED`, [lote]);
    for (const h of huecos) {
      await db.query('UPDATE huecos_liberados SET procesado_at = now() WHERE id = $1', [h.id]);
      if (!(await horarioLibre(db, h.tipo_turno_id, h.inicio))) continue;
      // Primero los que esperan hace más; a cada uno se le avisa como mucho una vez por día
      const { rows: espera } = await db.query(`
        SELECT le.id, p.nombre, p.telefono FROM lista_espera le JOIN pacientes p ON p.id = le.paciente_id
        WHERE le.resuelto_at IS NULL AND le.tipo_turno_id = $1 AND p.telefono IS NOT NULL
          AND (le.desde IS NULL OR le.desde <= ($2::timestamptz AT TIME ZONE $3)::date)
          AND (le.hasta IS NULL OR le.hasta >= ($2::timestamptz AT TIME ZONE $3)::date)
          AND (le.avisado_at IS NULL OR le.avisado_at < now() - interval '1 day')
        ORDER BY le.creado_at LIMIT $4 FOR UPDATE OF le SKIP LOCKED`, [h.tipo_turno_id, h.inicio, config.tz, AVISOS_POR_HUECO]);
      const tipo = h.tipo.toLowerCase(), cuando = fmtFecha(h.inicio), link = linkReserva(h.tipo_turno_id, h.inicio);
      for (const e of espera) {
        await db.query(`INSERT INTO mensajes (telefono, texto, plantilla, parametros, motivo) VALUES ($1, $2, $3, $4, 'lista_espera')`, [e.telefono,
          `Hola ${e.nombre}, se liberó un turno de ${tipo} el ${cuando}. Si lo querés, reservalo acá (lo toma el primero que reserve): ${link}`,
          config.whatsappPlantillaListaEspera || null,
          config.whatsappPlantillaListaEspera ? JSON.stringify([e.nombre, tipo, cuando, link]) : null]);
        await db.query('UPDATE lista_espera SET avisado_at = now() WHERE id = $1', [e.id]);
        avisos++;
      }
    }
  });
  return avisos;
}

export async function ciclo() {
  const liberados = await liberarVencidos();
  const avisos_espera = await procesarHuecos();
  const rec = await enviarRecordatorios();
  const msj = await enviarMensajes();
  await pool.query('DELETE FROM sesiones WHERE expira_at < now()');
  return { liberados, avisos_espera, enviados: rec.enviados + msj.enviados, errores: rec.errores + msj.errores };
}

export function iniciarWorker(intervaloMs = 60_000) {
  const tick = () => ciclo()
    .then(r => { if (r.liberados || r.avisos_espera || r.enviados || r.errores) console.log('[worker]', r); })
    .catch(e => console.error('[worker] error', e));
  tick();
  return setInterval(tick, intervaloMs);
}

// Ejecutado directo: `npm run worker`
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`[worker] iniciado · proveedor WhatsApp: ${proveedor().nombre}`);
  iniciarWorker();
}
