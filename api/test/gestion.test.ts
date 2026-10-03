import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { pool, q } from '../src/lib/db.js';
import { aWhatsApp, usarProveedor, type Mensaje } from '../src/lib/whatsapp.js';
import { ciclo } from '../src/worker.js';

const app = crearApp();
const como = async (email: string, password = 'demo1234') => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password }).expect(204);
  return agent;
};

/** Captura lo que el worker manda por WhatsApp. */
const enviados: Mensaje[] = [];
usarProveedor({ nombre: 'test', enviar: async m => { enviados.push(m); } });

let secre: request.Agent, admin: request.Agent, dra: request.Agent;
beforeAll(async () => {
  [secre, admin, dra] = await Promise.all([como('secretaria@demo.com'), como('admin@demo.com'), como('dra@demo.com')]);
});
afterAll(async () => { usarProveedor(null); await pool.end(); });

async function slotLibre(tipo = 1, saltear = 0): Promise<string> {
  const r = await request(app).get(`/api/public/disponibilidad?tipo=${tipo}&dias=21`).expect(200);
  const todos = r.body.dias.flatMap((d: any) => d.slots);
  expect(todos.length).toBeGreaterThan(saltear);
  return todos[saltear];
}

/** Reserva online completa; devuelve el token para que el paciente gestione el turno. */
async function reservar(saltear: number, dni: string, telefono = '381 600 0000') {
  const inicio = await slotLibre(1, saltear);
  const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
  const conf = await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
    .send({ nombre: 'Paciente Gestión', dni, telefono }).expect(200);
  return { inicio, id: conf.body.id as number, token: conf.body.token_gestion as string, link: conf.body.link_gestion as string };
}

describe('WhatsApp', () => {
  it('normaliza números argentinos al formato de WhatsApp', () => {
    expect(aWhatsApp('381 555 1234')).toBe('5493815551234');
    expect(aWhatsApp('0381 15 555-1234')).toBe('5493815551234');
    expect(aWhatsApp('+54 9 381 555 1234')).toBe('5493815551234');
    expect(aWhatsApp('11 15 2345 6789')).toBe('5491123456789');
  });

  it('Meta verifica el webhook con el token configurado', async () => {
    const ok = await request(app).get('/api/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verificar-test', 'hub.challenge': '12345' }).expect(200);
    expect(ok.text).toBe('12345');
    await request(app).get('/api/webhooks/whatsapp')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'otro', 'hub.challenge': '1' }).expect(403);
  });

  it('procesa el formato real de Meta firmado y le contesta al paciente', async () => {
    const { id } = await reservar(2, '41000001', '381 611 1111');
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ from: '5493816111111', type: 'button', button: { text: 'Confirmo' } }] } }] }],
    });
    const firma = 'sha256=' + crypto.createHmac('sha256', 'secreto-app-test').update(cuerpo).digest('hex');
    const r = await request(app).post('/api/webhooks/whatsapp').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', firma).send(cuerpo).expect(200);
    expect(r.body.resultados[0]).toMatchObject({ accion: 'confirmado', turno_id: id });
    const [m] = await q(`SELECT texto FROM mensajes WHERE telefono = '5493816111111' AND motivo = 'respuesta'`);
    expect(m.texto).toMatch(/quedó confirmado/);

    // Con una firma que no corresponde, no se toca nada
    await request(app).post('/api/webhooks/whatsapp').set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', 'sha256=' + '0'.repeat(64)).send(cuerpo).expect(401);
  });

  it('el recordatorio incluye el link para gestionar el turno', async () => {
    const { id, token } = await reservar(4, '41000002', '381 622 2222');
    await q(`UPDATE recordatorios SET programado_para = now() WHERE turno_id = $1`, [id]);
    enviados.length = 0;
    await ciclo();
    const m = enviados.find(x => x.telefono === '381 622 2222');
    expect(m?.texto).toContain(`https://consultorio.test/turno?t=${token}`);
  });
});

describe('Autogestión del paciente', () => {
  it('confirma, cambia de horario y cancela con el link, sin datos personales a la vista', async () => {
    const { token, link } = await reservar(6, '41000003');
    expect(link).toBe(`https://consultorio.test/turno?t=${token}`);

    const t = await request(app).get(`/api/public/turnos/${token}`).expect(200);
    expect(t.body).toMatchObject({ estado: 'reservado', tipo: 'Consulta', gestionable: true });
    expect(t.body).not.toHaveProperty('dni');
    expect(t.body).not.toHaveProperty('id');

    await request(app).post(`/api/public/turnos/${token}/confirmar`).expect(200);
    const otro = await slotLibre(1, 8);
    const mov = await request(app).post(`/api/public/turnos/${token}/reprogramar`).send({ inicio: otro }).expect(200);
    expect(mov.body.estado).toBe('reservado'); // hay que volver a confirmar el horario nuevo
    expect(new Date(mov.body.inicio).getTime()).toBe(new Date(otro).getTime());

    await request(app).post(`/api/public/turnos/${token}/cancelar`).expect(200);
    const r = await request(app).post(`/api/public/turnos/${token}/cancelar`).expect(422);
    expect(r.body.error).toMatch(/cancelado/);
  });

  it('no deja mover el turno a un horario que la agenda no ofrece', async () => {
    const { token } = await reservar(10, '41000004');
    const madrugada = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) + 'T03:00:00-03:00';
    await request(app).post(`/api/public/turnos/${token}/reprogramar`).send({ inicio: madrugada }).expect(409);
  });

  it('un token inventado no encuentra nada', async () => {
    await request(app).get(`/api/public/turnos/${crypto.randomUUID()}`).expect(404);
    await request(app).get('/api/public/turnos/no-es-un-token').expect(400);
  });
});

describe('Lista de espera', () => {
  it('al cancelarse un turno, avisa por WhatsApp a quien espera ese estudio', async () => {
    const [p] = await q(`SELECT id, telefono FROM pacientes WHERE telefono IS NOT NULL
      AND id NOT IN (SELECT paciente_id FROM lista_espera) ORDER BY id DESC LIMIT 1`);
    await secre.post('/api/lista-espera').send({ paciente_id: p.id, tipo_turno_id: 1, notas: 'test' }).expect(201);
    await secre.post('/api/lista-espera').send({ paciente_id: p.id, tipo_turno_id: 1 }).expect(409);
    // Que no haya avisos pendientes de otros tests: este paciente es el único que espera
    await q(`UPDATE lista_espera SET resuelto_at = now() WHERE paciente_id <> $1 AND resuelto_at IS NULL`, [p.id]);

    const [t] = await q(`SELECT x.id FROM turnos x WHERE x.estado = 'reservado' AND x.tipo_turno_id = 1 AND x.inicio > now() + interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM bloqueos_agenda b WHERE b.profesional_id = x.profesional_id AND tstzrange(b.inicio, b.fin) && tstzrange(x.inicio, x.fin))
      ORDER BY x.inicio LIMIT 1`);
    await secre.patch(`/api/turnos/${t.id}/estado`).send({ estado: 'cancelado' }).expect(200);

    enviados.length = 0;
    const r = await ciclo();
    expect(r.avisos_espera).toBeGreaterThanOrEqual(1);
    const m = enviados.find(x => x.telefono === p.telefono);
    expect(m?.texto).toMatch(/se liberó un turno de consulta/);
    expect(m?.texto).toContain('https://consultorio.test/?tipo=1&inicio=');

    const l = await secre.get('/api/lista-espera').expect(200);
    expect(l.body.find((e: any) => e.paciente_id === p.id).avisado_at).not.toBeNull();
  });

  it('no avisa si el horario liberado ya lo tomó otro', async () => {
    const [t] = await q(`SELECT x.id, x.inicio, x.profesional_id FROM turnos x WHERE x.estado = 'reservado' AND x.tipo_turno_id = 1
      AND x.inicio > now() + interval '1 day' ORDER BY x.inicio DESC LIMIT 1`);
    await secre.patch(`/api/turnos/${t.id}/estado`).send({ estado: 'cancelado' }).expect(200);
    const [{ id: pac }] = await q('SELECT id FROM pacientes ORDER BY id LIMIT 1');
    await secre.post('/api/turnos').send({ paciente_id: pac, tipo_turno_id: 1, inicio: new Date(t.inicio).toISOString() }).expect(201);
    await q(`UPDATE lista_espera SET avisado_at = NULL WHERE resuelto_at IS NULL`);
    enviados.length = 0;
    expect((await ciclo()).avisos_espera).toBe(0);
  });

  it('sacar a alguien de la lista no lo borra', async () => {
    const l = await secre.get('/api/lista-espera').expect(200);
    const e = l.body[0];
    await secre.post(`/api/lista-espera/${e.id}/resolver`).expect(204);
    const todos = await secre.get('/api/lista-espera?todos=1').expect(200);
    expect(todos.body.find((x: any) => x.id === e.id).resuelto_at).not.toBeNull();
  });
});

describe('Configuración (admin)', () => {
  it('crea un profesional que ya puede entrar y tiene agenda', async () => {
    const u = await admin.post('/api/admin/usuarios').send({
      nombre: 'Dr. Prueba Nuevo', email: 'nuevo@demo.com', rol: 'medico', password: 'clave-segura-1', titulo: 'Médico oftalmólogo', matricula: '1234',
    }).expect(201);
    const lista = await admin.get('/api/admin/usuarios').expect(200);
    expect(lista.body.find((x: any) => x.id === u.body.id)).toMatchObject({ titulo: 'Médico oftalmólogo', matricula: '1234' });
    const nuevo = await como('nuevo@demo.com', 'clave-segura-1');
    const yo = await nuevo.get('/api/auth/yo').expect(200);
    expect(yo.body.profesional_id).toBeTruthy();
    await secre.post('/api/admin/usuarios').send({ nombre: 'x', email: 'x@x.com', rol: 'admin', password: '12345678' }).expect(403);
  });

  it('cambiar la contraseña pide la actual y cierra las otras sesiones', async () => {
    const a = await como('nuevo@demo.com', 'clave-segura-1');
    const b = await como('nuevo@demo.com', 'clave-segura-1');
    await a.post('/api/auth/password').send({ actual: 'mal', nueva: 'otra-clave-2' }).expect(422);
    await a.post('/api/auth/password').send({ actual: 'clave-segura-1', nueva: 'otra-clave-2' }).expect(204);
    await a.get('/api/auth/yo').expect(200);
    await b.get('/api/auth/yo').expect(401);
    await como('nuevo@demo.com', 'otra-clave-2');
  });

  it('el admin no se puede quitar el rol a sí mismo', async () => {
    const yo = await admin.get('/api/auth/yo').expect(200);
    await admin.patch(`/api/admin/usuarios/${yo.body.id}`).send({ activo: false }).expect(422);
  });

  it('un estudio nuevo aparece en la web y se puede reservar', async () => {
    const [{ id: prof }] = await q(`SELECT p.id FROM profesionales p JOIN usuarios u ON u.id = p.usuario_id WHERE u.email = 'dra@demo.com'`);
    const t = await admin.post('/api/admin/tipos').send({
      nombre: 'Fondo de ojo', descripcion: 'Con dilatación', duracion_min: 40, profesional_id: prof, recurso_id: 1, precio_particular: 30000, color: '#123456',
    }).expect(201);
    const web = await request(app).get('/api/public/tipos').expect(200);
    expect(web.body.find((x: any) => x.id === t.body.id)).toMatchObject({ nombre: 'Fondo de ojo', descripcion: 'Con dilatación', duracion_min: 40 });
    const inicio = await slotLibre(t.body.id);
    await request(app).post('/api/public/retenciones').send({ tipo_turno_id: t.body.id, inicio }).expect(201);
    await admin.patch(`/api/admin/tipos/${t.body.id}`).send({ activo: false }).expect(200);
    expect((await request(app).get('/api/public/tipos')).body.some((x: any) => x.id === t.body.id)).toBe(false);
  });

  it('las franjas horarias no se superponen', async () => {
    const [{ id: prof }] = await q('SELECT id FROM profesionales ORDER BY id LIMIT 1');
    await admin.post('/api/admin/horarios').send({ profesional_id: prof, dia_semana: 1, desde: '12:00', hasta: '14:00' }).expect(409);
    const h = await admin.post('/api/admin/horarios').send({ profesional_id: prof, dia_semana: 0, desde: '10:00', hasta: '12:00' }).expect(201);
    await admin.delete(`/api/admin/horarios/${h.body.id}`).expect(204);
  });

  it('los datos del consultorio se ven en la web, en el panel y quedan auditados', async () => {
    const actual = (await admin.get('/api/admin/consultorio').expect(200)).body;
    await admin.put('/api/admin/consultorio').send({ ...actual, telefono: '(0381) 999-9999' }).expect(200);
    expect((await request(app).get('/api/public/consultorio')).body.telefono).toBe('(0381) 999-9999');
    expect((await secre.get('/api/catalogos')).body.consultorio.marca).toBe(actual.marca);
    const a = await admin.get('/api/admin/auditoria?tabla=consultorio&limit=1').expect(200);
    expect(a.body[0].despues.telefono).toBe('(0381) 999-9999');
  });
});

describe('Caja, recetas y reportes', () => {
  it('la agenda trae precio y si el turno ya se cobró', async () => {
    const [t] = await q(`SELECT id, paciente_id FROM turnos WHERE estado = 'reservado' AND tipo_turno_id = 1 AND inicio > now() LIMIT 1`);
    expect((await secre.get(`/api/turnos/${t.id}`).expect(200)).body).toMatchObject({ precio: 25000, cobrado: false });
    await secre.post('/api/pagos').send({ paciente_id: t.paciente_id, turno_id: t.id, tipo: 'particular', medio: 'efectivo', monto: 25000 }).expect(201);
    expect((await secre.get(`/api/turnos/${t.id}`)).body.cobrado).toBe(true);
  });

  it('vista semanal de un profesional', async () => {
    const [{ id: prof }] = await q('SELECT id FROM profesionales ORDER BY id LIMIT 1');
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Tucuman' });
    const r = await secre.get(`/api/turnos?dia=${hoy}&dias=7&profesional=${prof}`).expect(200);
    expect(r.body.turnos.length).toBeGreaterThan(0);
    expect(r.body.turnos.every((t: any) => t.profesional_id === prof)).toBe(true);
  });

  it('imprime el cierre de caja', async () => {
    const r = await secre.get('/api/caja/imprimir').expect(200);
    expect(r.text).toContain('Cierre de caja');
    await dra.get('/api/caja/imprimir').expect(403);
  });

  it('emite e imprime recetas de medicación con el título del profesional', async () => {
    const [{ id }] = await q(`SELECT c.id FROM consultas c JOIN profesionales p ON p.id = c.profesional_id
      WHERE c.estado = 'cerrada' AND p.titulo = 'Médica oftalmóloga' LIMIT 1`);
    const r = await dra.post(`/api/consultas/${id}/recetas`).send({ tipo: 'medicacion', contenido: { texto: 'Latanoprost 1 gota por noche' } }).expect(201);
    const html = await dra.get(`/api/recetas/${r.body.id}/imprimir`).expect(200);
    expect(html.text).toContain('Latanoprost');
    expect(html.text).toContain('Médica oftalmóloga');
    const lista = await dra.get(`/api/consultas/${id}/recetas`).expect(200);
    expect(lista.body.some((x: any) => x.tipo === 'medicacion')).toBe(true);
  });

  it('reporte por obra social en JSON y CSV para Excel', async () => {
    const desde = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10), hasta = new Date().toISOString().slice(0, 10);
    const r = await admin.get(`/api/admin/reportes/obras-sociales?desde=${desde}&hasta=${hasta}`).expect(200);
    expect(r.body.resumen.length).toBeGreaterThan(0);
    const total = r.body.resumen.reduce((a: number, x: any) => a + x.prestaciones, 0);
    expect(total).toBe(r.body.detalle.length);
    const csv = await admin.get(`/api/admin/reportes/obras-sociales?desde=${desde}&hasta=${hasta}&formato=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('﻿Fecha;Obra social;Paciente;DNI;N.º afiliado;Prestación;Profesional;Matrícula;Copago cobrado');
    await secre.get(`/api/admin/reportes/obras-sociales?desde=${desde}&hasta=${hasta}`).expect(403);
  });
});

describe('Cron externo', () => {
  it('corre el ciclo del worker solo con el secreto', async () => {
    await request(app).post('/api/interno/ciclo').expect(401);
    await request(app).post('/api/interno/ciclo').set('x-cron-secret', 'otro-secreto').expect(401);
    const r = await request(app).post('/api/interno/ciclo').set('x-cron-secret', 'cron-test').expect(200);
    expect(r.body).toHaveProperty('liberados');
  });
});

describe('Acceso al panel', () => {
  const hayBuild = fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../panel/dist/index.html'));

  it.skipIf(!hayBuild)('el manifest de la app instalable lleva el nombre del consultorio', async () => {
    const r = await request(app).get('/panel/manifest.webmanifest').expect(200);
    expect(r.headers['content-type']).toMatch(/manifest\+json/);
    const m = JSON.parse(r.text);
    const [c] = await q('SELECT marca FROM consultorio');
    expect(m).toMatchObject({ name: `${c.marca} · Panel`, start_url: '/panel/', scope: '/panel/', display: 'standalone' });
    expect(m.icons.some((i: any) => i.purpose === 'maskable')).toBe(true);
    const sw = await request(app).get('/panel/sw.js').expect(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
  });

  it('el panel, la API y la página del turno no se indexan; la landing sí', async () => {
    expect((await request(app).get('/api/salud')).headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await request(app).get('/turno')).headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await request(app).get('/')).headers['x-robots-tag']).toBeUndefined();
    const robots = await request(app).get('/robots.txt').expect(200);
    expect(robots.text).toContain('Disallow: /panel');
  });
});
