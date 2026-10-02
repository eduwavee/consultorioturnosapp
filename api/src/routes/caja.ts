import { Router } from 'express';
import { z } from 'zod';
import { requireRol } from '../lib/auth.js';
import { config } from '../lib/config.js';
import { q, tx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

export const cajaRouter = Router();
const caja = requireRol('admin', 'secretaria');
const HOY = `(now() AT TIME ZONE '${config.tz}')::date`;

async function resumen() {
  const [c] = await q(`SELECT c.*, ua.nombre AS abierta_por_nombre, uc.nombre AS cerrada_por_nombre
    FROM cajas c JOIN usuarios ua ON ua.id = c.abierta_por LEFT JOIN usuarios uc ON uc.id = c.cerrada_por
    WHERE c.fecha = ${HOY}`);
  if (!c) return { caja: null, pagos: [], totales: {}, total: 0 };
  const pagos = await q(`
    SELECT pg.id, pg.monto, pg.medio, pg.tipo, pg.anulado, pg.creado_at, pg.turno_id,
           p.nombre || ' ' || p.apellido AS paciente
    FROM pagos pg JOIN pacientes p ON p.id = pg.paciente_id WHERE pg.caja_id = $1 ORDER BY pg.id DESC`, [c.id]);
  const totales: Record<string, number> = {};
  let total = 0;
  for (const p of pagos) if (!p.anulado) { totales[p.medio] = (totales[p.medio] ?? 0) + p.monto; total += p.monto; }
  return { caja: c, pagos, totales, total };
}

cajaRouter.get('/caja/hoy', caja, async (_req, res) => res.json(await resumen()));

cajaRouter.post('/caja/abrir', caja, async (req, res) => {
  await tx(req.user!.id, db => db.query(`INSERT INTO cajas (fecha, abierta_por) VALUES (${HOY}, $1)`, [req.user!.id]));
  res.status(201).json(await resumen());
});

cajaRouter.post('/caja/cerrar', caja, async (req, res) => {
  const r = await tx(req.user!.id, db => db.query(
    `UPDATE cajas SET cerrada_por = $1, cerrada_at = now() WHERE fecha = ${HOY} AND cerrada_at IS NULL`, [req.user!.id]));
  if (!r.rowCount) throw new HttpError(422, 'No hay una caja abierta hoy');
  res.json(await resumen());
});

cajaRouter.post('/pagos', caja, async (req, res) => {
  const b = z.object({
    paciente_id: z.number().int().positive(),
    turno_id: z.number().int().positive().nullable().optional(),
    tipo: z.enum(['particular', 'copago', 'obra_social']),
    medio: z.enum(['efectivo', 'transferencia', 'debito', 'credito', 'obra_social']),
    monto: z.number().nonnegative().max(10_000_000),
  }).parse(req.body);
  await tx(req.user!.id, async db => {
    const { rows: [c] } = await db.query(`SELECT id, cerrada_at FROM cajas WHERE fecha = ${HOY} FOR UPDATE`);
    if (!c) throw new HttpError(422, 'Abrí la caja del día antes de cobrar');
    if (c.cerrada_at) throw new HttpError(422, 'La caja de hoy ya está cerrada');
    await db.query(`INSERT INTO pagos (caja_id, turno_id, paciente_id, tipo, medio, monto, creado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [c.id, b.turno_id ?? null, b.paciente_id, b.tipo, b.medio, b.monto, req.user!.id]);
  });
  res.status(201).json(await resumen());
});

/** Los pagos no se borran: se anulan y queda en la auditoría. */
cajaRouter.post('/pagos/:id/anular', caja, async (req, res) => {
  const pid = z.coerce.number().int().positive().parse(req.params.id);
  await tx(req.user!.id, async db => {
    const { rows: [p] } = await db.query(`SELECT pg.id, c.cerrada_at FROM pagos pg JOIN cajas c ON c.id = pg.caja_id WHERE pg.id = $1`, [pid]);
    if (!p) throw new HttpError(404, 'Pago no encontrado');
    if (p.cerrada_at) throw new HttpError(422, 'No se puede anular un pago de una caja cerrada');
    await db.query('UPDATE pagos SET anulado = true WHERE id = $1', [pid]);
  });
  res.json(await resumen());
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
const pesos = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const MEDIOS: Record<string, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', debito: 'Débito', credito: 'Crédito', obra_social: 'Obra social' };

/** Cierre de caja listo para imprimir o guardar como PDF (hoy o un día anterior). */
cajaRouter.get('/caja/imprimir', caja, async (req, res) => {
  const { fecha } = z.object({ fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.query);
  const [c] = await q(`SELECT c.*, to_char(c.fecha, 'DD/MM/YYYY') AS dia, ua.nombre AS abierta_por_nombre, uc.nombre AS cerrada_por_nombre
    FROM cajas c JOIN usuarios ua ON ua.id = c.abierta_por LEFT JOIN usuarios uc ON uc.id = c.cerrada_por
    WHERE c.fecha = COALESCE($1::date, ${HOY})`, [fecha ?? null]);
  if (!c) throw new HttpError(404, 'No hay caja para ese día');
  const [cons] = await q('SELECT nombre, direccion FROM consultorio');
  const pagos = await q(`
    SELECT pg.monto, pg.medio, pg.tipo, pg.anulado, to_char(pg.creado_at AT TIME ZONE $2, 'HH24:MI') AS hora,
           p.apellido || ', ' || p.nombre AS paciente, u.nombre AS cobro
    FROM pagos pg JOIN pacientes p ON p.id = pg.paciente_id JOIN usuarios u ON u.id = pg.creado_por
    WHERE pg.caja_id = $1 ORDER BY pg.id`, [c.id, config.tz]);
  const totales: Record<string, number> = {};
  let total = 0, anulados = 0;
  for (const p of pagos) {
    if (p.anulado) { anulados++; continue; }
    totales[p.medio] = (totales[p.medio] ?? 0) + p.monto; total += p.monto;
  }
  const cerrada = c.cerrada_at
    ? `Cerrada por ${esc(c.cerrada_por_nombre)} el ${new Date(c.cerrada_at).toLocaleString('es-AR', { timeZone: config.tz })}`
    : '<b>Caja todavía abierta</b> (este resumen puede cambiar)';
  res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Cierre de caja ${esc(c.dia)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:32px auto;color:#14262b;padding:0 16px}h1{font:400 28px Georgia,serif;margin:0}
.m{color:#5b6f73;font-size:13px}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border-bottom:1px solid #d5e3e0;padding:7px 6px;text-align:left}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.anulado{color:#9aa;text-decoration:line-through}.tot td{font-weight:700;border-top:2px solid #14262b}
.firmas{display:flex;gap:40px;margin-top:70px}.firmas div{flex:1;border-top:1px solid #14262b;padding-top:6px;font-size:12px}@media print{button{display:none}}</style>
<button onclick="print()">Imprimir / Guardar PDF</button>
<h1>Cierre de caja · ${esc(c.dia)}</h1>
<p class="m">${esc(cons?.nombre)}${cons?.direccion ? ` · ${esc(cons.direccion)}` : ''}<br>Abierta por ${esc(c.abierta_por_nombre)} · ${cerrada}</p>
<table><tr><th>Medio</th><th class="n">Total</th></tr>
${Object.entries(totales).map(([m, t]) => `<tr><td>${esc(MEDIOS[m] ?? m)}</td><td class="n">${pesos(t)}</td></tr>`).join('')}
<tr class="tot"><td>Total</td><td class="n">${pesos(total)}</td></tr></table>
<h3>Detalle (${pagos.length} cobros${anulados ? `, ${anulados} anulados` : ''})</h3>
<table><tr><th>Hora</th><th>Paciente</th><th>Tipo</th><th>Medio</th><th>Cobró</th><th class="n">Monto</th></tr>
${pagos.map(p => `<tr class="${p.anulado ? 'anulado' : ''}"><td>${p.hora}</td><td>${esc(p.paciente)}</td><td>${esc(p.tipo.replace('_', ' '))}</td>
<td>${esc(MEDIOS[p.medio] ?? p.medio)}</td><td>${esc(p.cobro)}</td><td class="n">${pesos(p.monto)}</td></tr>`).join('')}</table>
<div class="firmas"><div>Entregó</div><div>Recibió</div></div></html>`);
});
