import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { fmtFecha } from '../lib/agenda.js';
import { config } from '../lib/config.js';
import { tx } from '../lib/db.js';
import { HttpError } from '../lib/errors.js';

export const webhooksRouter = Router();

const igual = (a: string, b: string) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Qué quiso decir el paciente. "Sí" con tilde incluido; "Siempre" no cuenta. */
export function interpretar(texto: string): 'confirmado' | 'cancelado' | null {
  const t = texto.trim().toLowerCase();
  if (/^(confirm|s[ií](?![a-záéíóúñ]))/.test(t)) return 'confirmado';
  if (/^cancel/.test(t)) return 'cancelado';
  return null;
}

/**
 * Aplica la respuesta al próximo turno de ese teléfono (comparando los
 * últimos 10 dígitos, así da igual si viene con 54 9 adelante o no).
 */
async function procesarRespuesta(telefono: string, texto: string, responder: boolean) {
  const accion = interpretar(texto);
  if (!accion) return { accion: 'ignorado' as const };
  const ultimos10 = telefono.replace(/\D/g, '').slice(-10);
  return tx(null, async db => {
    const { rows: [turno] } = await db.query(`
      SELECT t.id, t.inicio, tt.nombre AS tipo FROM turnos t
      JOIN pacientes p ON p.id = t.paciente_id JOIN tipos_turno tt ON tt.id = t.tipo_turno_id
      WHERE right(regexp_replace(p.telefono, '\\D', '', 'g'), 10) = $1
        AND t.inicio > now() AND t.estado::text IN ('reservado', 'confirmado')
      ORDER BY t.inicio LIMIT 1 FOR UPDATE OF t`, [ultimos10]);
    if (!turno) {
      if (responder) await db.query(`INSERT INTO mensajes (telefono, texto, motivo) VALUES ($1, $2, 'respuesta')`,
        [telefono, 'No encontramos turnos próximos a tu nombre. Si necesitás ayuda, escribinos.']);
      return { accion: 'sin_turno' as const };
    }
    await db.query('UPDATE turnos SET estado = $2 WHERE id = $1', [turno.id, accion]);
    // Dentro de la ventana de 24 h (el paciente acaba de escribir) se puede mandar texto libre
    if (responder) await db.query(`INSERT INTO mensajes (telefono, texto, motivo) VALUES ($1, $2, 'respuesta')`, [telefono,
      accion === 'confirmado'
        ? `¡Gracias! Tu turno de ${turno.tipo.toLowerCase()} del ${fmtFecha(turno.inicio)} quedó confirmado.`
        : `Listo, cancelamos tu turno de ${turno.tipo.toLowerCase()} del ${fmtFecha(turno.inicio)}. Cuando quieras, sacá otro desde la web.`]);
    return { accion, turno_id: Number(turno.id) };
  });
}

/** Verificación que hace Meta al configurar el webhook. */
webhooksRouter.get('/whatsapp', (req, res) => {
  const { 'hub.mode': modo, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
  if (modo === 'subscribe' && config.whatsappVerifyToken && igual(String(token ?? ''), config.whatsappVerifyToken)) {
    res.type('text').send(String(challenge ?? ''));
    return;
  }
  throw new HttpError(403, 'Token de verificación inválido');
});

/** Firma de Meta: HMAC-SHA256 del cuerpo crudo con el app secret. */
function firmaMetaValida(req: Request) {
  const firma = req.get('x-hub-signature-256') ?? '';
  const raw = (req as any).rawBody as Buffer | undefined;
  if (!config.whatsappAppSecret || !raw || !firma.startsWith('sha256=')) return false;
  const esperada = 'sha256=' + crypto.createHmac('sha256', config.whatsappAppSecret).update(raw).digest('hex');
  return igual(firma, esperada);
}

const metaPayload = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        messages: z.array(z.object({
          from: z.string(),
          type: z.string(),
          text: z.object({ body: z.string() }).optional(),
          button: z.object({ text: z.string() }).optional(),
          interactive: z.object({ button_reply: z.object({ title: z.string() }).optional() }).optional(),
        }).passthrough()).optional(),
      }).passthrough(),
    })),
  })),
});

/**
 * Respuestas del paciente. Acepta dos formatos:
 *  · el real de Meta (firmado con X-Hub-Signature-256), con texto o botones de plantilla;
 *  · uno simple { telefono, texto } con x-webhook-secret, para pruebas e integraciones propias.
 */
webhooksRouter.post('/whatsapp', async (req, res) => {
  if (req.get('x-hub-signature-256')) {
    if (!firmaMetaValida(req)) throw new HttpError(401, 'Firma inválida');
    const p = metaPayload.safeParse(req.body);
    // A Meta siempre se le contesta 200 rápido; si no, reintenta el mismo evento
    if (!p.success) { res.json({ procesados: 0 }); return; }
    const resultados = [];
    for (const e of p.data.entry) for (const c of e.changes) for (const m of c.value.messages ?? []) {
      const texto = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? '';
      resultados.push(await procesarRespuesta(m.from, texto, true));
    }
    res.json({ procesados: resultados.length, resultados });
    return;
  }
  if (!igual(String(req.get('x-webhook-secret') ?? ''), config.webhookSecret)) throw new HttpError(401, 'Firma inválida');
  const { telefono, texto } = z.object({ telefono: z.string(), texto: z.string() }).parse(req.body);
  res.json(await procesarRespuesta(telefono, texto, false));
});
