import { Router } from 'express';
import { z } from 'zod';
import { requireRol } from '../lib/auth.js';
import { q, tx } from '../lib/db.js';
import { HttpError, notFound } from '../lib/errors.js';

/**
 * Historia clínica. Solo el rol médico entra acá: la secretaria no ve
 * contenido clínico ni por API. Cada lectura queda en accesos_historia y
 * cada escritura en audit_log (triggers de la base).
 */
export const clinicaRouter = Router();
const medico = requireRol('medico');
const id = z.coerce.number().int().positive();

clinicaRouter.get('/plantillas', medico, async (_req, res) => {
  res.json(await q('SELECT id, especialidad, nombre, esquema FROM plantillas_ficha WHERE activa ORDER BY id'));
});

clinicaRouter.get('/pacientes/:id/historia', medico, async (req, res) => {
  const pid = id.parse(req.params.id);
  const out = await tx(req.user!.id, async db => {
    const { rows: [p] } = await db.query('SELECT id FROM pacientes WHERE id = $1', [pid]);
    if (!p) throw notFound('Paciente');
    await db.query('INSERT INTO accesos_historia (usuario_id, paciente_id) VALUES ($1, $2)', [req.user!.id, pid]);
    const { rows: consultas } = await db.query(`
      SELECT c.id, c.fecha, c.estado, c.diagnostico, c.indicaciones, c.datos, c.plantilla_id, c.turno_id,
             c.motivo_anulacion, u.nombre AS profesional,
             COALESCE((SELECT json_agg(r ORDER BY r.emitida_at) FROM recetas r WHERE r.consulta_id = c.id), '[]') AS recetas
      FROM consultas c
      JOIN profesionales pr ON pr.id = c.profesional_id JOIN usuarios u ON u.id = pr.usuario_id
      WHERE c.paciente_id = $1 ORDER BY c.fecha DESC`, [pid]);
    return consultas;
  });
  res.json(out);
});

const consultaBody = z.object({
  datos: z.record(z.unknown()).default({}),
  diagnostico: z.string().trim().nullable().optional(),
  indicaciones: z.string().trim().nullable().optional(),
});

clinicaRouter.post('/consultas', medico, async (req, res) => {
  const b = consultaBody.extend({
    paciente_id: z.number().int().positive(),
    turno_id: z.number().int().positive().nullable().optional(),
    plantilla_id: z.number().int().positive(),
  }).parse(req.body);
  if (!req.user!.profesional_id) throw new HttpError(403, 'Tu usuario no está asociado a un profesional');
  const c = await tx(req.user!.id, async db => (await db.query(`
    INSERT INTO consultas (paciente_id, profesional_id, turno_id, plantilla_id, datos, diagnostico, indicaciones)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.paciente_id, req.user!.profesional_id, b.turno_id ?? null, b.plantilla_id, b.datos,
     b.diagnostico ?? null, b.indicaciones ?? null])).rows[0]);
  res.status(201).json(c);
});

clinicaRouter.patch('/consultas/:id', medico, async (req, res) => {
  const cid = id.parse(req.params.id);
  const b = consultaBody.partial().parse(req.body);
  const c = await tx(req.user!.id, async db => {
    const { rows: [actual] } = await db.query('SELECT estado FROM consultas WHERE id = $1 FOR UPDATE', [cid]);
    if (!actual) throw notFound('Consulta');
    if (actual.estado === 'anulada') throw new HttpError(422, 'Una consulta anulada no se puede editar');
    const { rows: [c] } = await db.query(`
      UPDATE consultas SET
        datos = COALESCE($2, datos),
        diagnostico = CASE WHEN $3::boolean THEN $4 ELSE diagnostico END,
        indicaciones = CASE WHEN $5::boolean THEN $6 ELSE indicaciones END
      WHERE id = $1 RETURNING *`,
      [cid, b.datos ?? null, 'diagnostico' in b, b.diagnostico ?? null, 'indicaciones' in b, b.indicaciones ?? null]);
    return c;
  });
  res.json(c);
});

clinicaRouter.post('/consultas/:id/cerrar', medico, async (req, res) => {
  const cid = id.parse(req.params.id);
  const c = await tx(req.user!.id, async db => {
    const { rows: [c] } = await db.query(
      `UPDATE consultas SET estado = 'cerrada' WHERE id = $1 AND estado = 'borrador' RETURNING *`, [cid]);
    if (!c) throw new HttpError(422, 'Solo se puede cerrar una consulta en borrador');
    // Si venía de un turno en sala, el turno pasa a atendido
    if (c.turno_id) await db.query(`UPDATE turnos SET estado = 'atendido' WHERE id = $1 AND estado = 'en_sala'`, [c.turno_id]);
    return c;
  });
  res.json(c);
});

clinicaRouter.post('/consultas/:id/anular', medico, async (req, res) => {
  const cid = id.parse(req.params.id);
  const { motivo } = z.object({ motivo: z.string().trim().min(5, 'Explicá el motivo de la anulación') }).parse(req.body);
  const c = await tx(req.user!.id, async db => (await db.query(
    `UPDATE consultas SET estado = 'anulada', motivo_anulacion = $2 WHERE id = $1 AND estado <> 'anulada' RETURNING *`,
    [cid, motivo])).rows[0]);
  if (!c) throw new HttpError(422, 'La consulta no existe o ya está anulada');
  res.json(c);
});

/** Historial de cambios de una consulta, leído del audit_log inmutable. */
clinicaRouter.get('/consultas/:id/historial', medico, async (req, res) => {
  const cid = id.parse(req.params.id);
  res.json(await q(`
    SELECT a.id, a.accion, a.at, u.nombre AS usuario, a.antes, a.despues
    FROM audit_log a LEFT JOIN usuarios u ON u.id = a.usuario_id
    WHERE a.tabla = 'consultas' AND a.registro_id = $1 ORDER BY a.id`, [cid]));
});

/* ---------- Recetas ---------- */
const lente = z.object({ esf: z.string().optional(), cil: z.string().optional(), eje: z.string().optional() }).partial();

/** Recetas de una consulta (solo tipo y fecha, para reimprimir). */
clinicaRouter.get('/consultas/:id/recetas', medico, async (req, res) => {
  res.json(await q('SELECT id, tipo, emitida_at FROM recetas WHERE consulta_id = $1 ORDER BY emitida_at', [id.parse(req.params.id)]));
});

clinicaRouter.post('/consultas/:id/recetas', medico, async (req, res) => {
  const cid = id.parse(req.params.id);
  const b = z.object({
    tipo: z.enum(['anteojos', 'lentes_contacto', 'medicacion', 'orden_estudio']),
    contenido: z.object({ od: lente.optional(), oi: lente.optional(), adicion: z.string().optional(), texto: z.string().optional() }),
  }).parse(req.body);
  const r = await tx(req.user!.id, async db => {
    const { rows: [c] } = await db.query('SELECT estado FROM consultas WHERE id = $1', [cid]);
    if (!c) throw notFound('Consulta');
    if (c.estado === 'anulada') throw new HttpError(422, 'No se pueden emitir recetas de una consulta anulada');
    return (await db.query('INSERT INTO recetas (consulta_id, tipo, contenido) VALUES ($1,$2,$3) RETURNING *', [cid, b.tipo, b.contenido])).rows[0];
  });
  res.status(201).json(r);
});

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** Receta lista para imprimir o guardar como PDF desde el navegador. */
clinicaRouter.get('/recetas/:id/imprimir', medico, async (req, res) => {
  const [r] = await q(`
    SELECT r.*, c.diagnostico, p.nombre || ' ' || p.apellido AS paciente, p.dni,
           u.nombre AS profesional, pr.matricula, pr.titulo,
           (SELECT direccion FROM consultorio) AS direccion, (SELECT telefono FROM consultorio) AS telefono_consultorio
    FROM recetas r JOIN consultas c ON c.id = r.consulta_id
    JOIN pacientes p ON p.id = c.paciente_id
    JOIN profesionales pr ON pr.id = c.profesional_id JOIN usuarios u ON u.id = pr.usuario_id
    WHERE r.id = $1`, [id.parse(req.params.id)]);
  if (!r) throw notFound('Receta');
  const k = r.contenido ?? {};
  const fila = (ojo: string, v: any = {}) => `<tr><th>${ojo}</th><td>${esc(v.esf)}</td><td>${esc(v.cil)}</td><td>${esc(v.eje)}</td></tr>`;
  const cuerpo = r.tipo === 'anteojos' || r.tipo === 'lentes_contacto'
    ? `<table><tr><th></th><th>Esférico</th><th>Cilíndrico</th><th>Eje</th></tr>${fila('OD', k.od)}${fila('OI', k.oi)}</table>
       ${k.adicion ? `<p>Adición: ${esc(k.adicion)}</p>` : ''}${k.texto ? `<p>${esc(k.texto)}</p>` : ''}`
    : `<p style="white-space:pre-wrap">${esc(k.texto)}</p>`;
  res.type('html').send(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Receta ${r.id}</title>
<style>body{font:15px/1.5 Georgia,serif;max-width:640px;margin:40px auto;color:#14262b}h1{font-size:26px;margin:0}
.m{color:#5b6f73;font-size:13px}hr{border:0;border-top:1px solid #d5e3e0;margin:20px 0}table{border-collapse:collapse;width:100%}
th,td{border:1px solid #d5e3e0;padding:8px;text-align:center}.firma{margin-top:80px;border-top:1px solid #14262b;width:260px;padding-top:6px;font-size:13px}
@media print{button{display:none}}</style>
<button onclick="print()">Imprimir / Guardar PDF</button>
<h1>${esc(r.profesional)}</h1><div class="m">${[r.titulo, r.matricula ? `M.P. ${r.matricula}` : null].filter(Boolean).map(esc).join(' · ')}
${r.direccion || r.telefono_consultorio ? `<br>${[r.direccion, r.telefono_consultorio].filter(Boolean).map(esc).join(' · ')}` : ''}</div><hr>
<p><b>Paciente:</b> ${esc(r.paciente)} · DNI ${esc(r.dni)}<br><b>Fecha:</b> ${new Date(r.emitida_at).toLocaleDateString('es-AR')}
<br><b>Tipo:</b> ${esc(r.tipo.replace('_', ' '))}</p>${r.diagnostico ? `<p><b>Diagnóstico:</b> ${esc(r.diagnostico)}</p>` : ''}
${cuerpo}<div class="firma">Firma y sello</div></html>`);
});
