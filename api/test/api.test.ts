import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearApp } from '../src/app.js';
import { pool, q } from '../src/lib/db.js';
import { usarProveedor } from '../src/lib/whatsapp.js';
import { ciclo } from '../src/worker.js';

const app = crearApp();
const como = async (email: string) => {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email, password: 'demo1234' }).expect(204);
  return agent;
};

let dra: request.Agent, secre: request.Agent, admin: request.Agent;
beforeAll(async () => {
  [dra, secre, admin] = await Promise.all([como('dra@demo.com'), como('secretaria@demo.com'), como('admin@demo.com')]);
});
afterAll(async () => { await pool.end(); });

/** Primer horario libre de un tipo de turno según la propia API. */
async function slotLibre(tipo = 1, saltear = 0): Promise<string> {
  const r = await request(app).get(`/api/public/disponibilidad?tipo=${tipo}&dias=14`).expect(200);
  const todos = r.body.dias.flatMap((d: any) => d.slots);
  expect(todos.length).toBeGreaterThan(saltear);
  return todos[saltear];
}

describe('Reserva online', () => {
  it('retiene, confirma, crea el paciente y programa el recordatorio', async () => {
    const inicio = await slotLibre();
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    expect(ret.body.token).toMatch(/[0-9a-f-]{36}/);
    expect(new Date(ret.body.fin).getTime() - new Date(ret.body.inicio).getTime()).toBe(20 * 60_000); // la base calculó el fin

    const conf = await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
      .send({ nombre: 'Rocío Aguirre', dni: '40111222', telefono: '381 444 1234' }).expect(200);
    expect(conf.body.tipo).toBe('Consulta');

    const [t] = await q(`SELECT t.estado, p.dni, (SELECT count(*)::int FROM recordatorios r WHERE r.turno_id = t.id) AS rec
                         FROM turnos t JOIN pacientes p ON p.id = t.paciente_id WHERE t.id = $1`, [ret.body.id]);
    expect(t).toMatchObject({ estado: 'reservado', dni: '40111222', rec: 1 });
    // El token no sirve dos veces
    await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
      .send({ nombre: 'Rocío Aguirre', dni: '40111222', telefono: '381 444 1234' }).expect(404);
  });

  it('el horario reservado deja de aparecer como disponible', async () => {
    const inicio = await slotLibre();
    await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    expect(await slotLibre()).not.toBe(inicio);
  });

  it('50 reservas simultáneas del mismo horario: entra exactamente una', async () => {
    const inicio = await slotLibre(1, 3);
    const res = await Promise.all(Array.from({ length: 50 }, () =>
      request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio })));
    const st = res.map(r => r.status);
    expect(st.filter(s => s === 201)).toHaveLength(1);
    expect(st.filter(s => s === 409)).toHaveLength(49);
    expect(res.find(r => r.status === 409)!.body.codigo).toBe('sin_choque_profesional');
  });

  it('dos estudios distintos no pueden usar el mismo equipo a la vez', async () => {
    // OCT usa el equipo OCT: forzamos otro turno del mismo equipo en el mismo horario con otro profesional
    // Buscamos un horario de OCT donde la doctora esté libre, así el único choque posible es el del equipo
    const r0 = await request(app).get('/api/public/disponibilidad?tipo=3&dias=14').expect(200);
    let inicio = '';
    for (const s of r0.body.dias.flatMap((d: any) => d.slots)) {
      const [{ n }] = await q(`SELECT count(*)::int AS n FROM turnos WHERE profesional_id = 1
        AND estado::text NOT IN ('cancelado','ausente') AND tstzrange(inicio, fin) && tstzrange($1, $1::timestamptz + interval '30 min')`, [s]);
      const [{ b }] = await q(`SELECT count(*)::int AS b FROM bloqueos_agenda WHERE profesional_id = 1 AND tstzrange(inicio, fin) && tstzrange($1, $1::timestamptz + interval '30 min')`, [s]);
      if (!n && !b) { inicio = s; break; }
    }
    expect(inicio).not.toBe('');
    await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 3, inicio }).expect(201);
    const [{ id: pac }] = await q('SELECT id FROM pacientes LIMIT 1');
    const r = await secre.post('/api/turnos').send({ paciente_id: pac, tipo_turno_id: 3, profesional_id: 1, inicio });
    expect(r.status).toBe(409);
    expect(r.body.codigo).toBe('sin_choque_recurso');
  });

  it('una retención vencida se libera y el horario vuelve a estar disponible', async () => {
    const inicio = await slotLibre(1, 6);
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    await q(`UPDATE turnos SET expira_at = now() - interval '1 minute' WHERE id = $1`, [ret.body.id]);
    await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
      .send({ nombre: 'Tarde Llegó', dni: '40999888', telefono: '3815550000' }).expect(410);
    usarProveedor({ nombre: 'mudo', enviar: async () => {} });
    const r = await ciclo();
    expect(r.liberados).toBeGreaterThanOrEqual(1);
    await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
  });

  it('cerrar la página libera la retención (sendBeacon)', async () => {
    const inicio = await slotLibre(1, 12);
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    await request(app).post(`/api/public/retenciones/${ret.body.token}/liberar`).expect(204);
    const [t] = await q('SELECT estado FROM turnos WHERE id = $1', [ret.body.id]);
    expect(t.estado).toBe('cancelado');
  });

  it('rechaza turnos online fuera del horario de atención', async () => {
    const r = await request(app).post('/api/public/retenciones')
      .send({ tipo_turno_id: 1, inicio: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) + 'T14:00:00-03:00' });
    expect(r.status).toBe(422);
  });

  it('reservar con el DNI de un paciente existente no le cambia el WhatsApp', async () => {
    const [pac] = await q(`SELECT id, dni, telefono FROM pacientes WHERE telefono IS NOT NULL ORDER BY id LIMIT 1`);
    const inicio = await slotLibre(1, 15);
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
      .send({ nombre: 'Otra Persona', dni: pac.dni, telefono: '11 9999 0000' }).expect(200);
    const [despues] = await q('SELECT telefono, notas_admin FROM pacientes WHERE id = $1', [pac.id]);
    expect(despues.telefono).toBe(pac.telefono);
    expect(despues.notas_admin).toContain('11 9999 0000');
  });

  it('una retención vencida que el worker no liberó no bloquea al consultorio', async () => {
    const inicio = await slotLibre(1, 18);
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    await q(`UPDATE turnos SET expira_at = now() - interval '1 minute' WHERE id = $1`, [ret.body.id]);
    const [{ id: pac }] = await q('SELECT id FROM pacientes ORDER BY id LIMIT 1');
    await secre.post('/api/turnos').send({ paciente_id: pac, tipo_turno_id: 1, inicio }).expect(201);
  });

  it('valida los datos del paciente', async () => {
    const inicio = await slotLibre(1, 9);
    const ret = await request(app).post('/api/public/retenciones').send({ tipo_turno_id: 1, inicio }).expect(201);
    const r = await request(app).post(`/api/public/retenciones/${ret.body.token}/confirmar`)
      .send({ nombre: 'Ana', dni: '12', telefono: '1' }).expect(400);
    expect(r.body.detalles.map((d: any) => d.campo)).toEqual(expect.arrayContaining(['nombre', 'dni', 'telefono']));
  });
});

describe('Roles y seguridad', () => {
  it('sin sesión no se accede al panel', async () => {
    await request(app).get('/api/pacientes').expect(401);
  });

  it('login incorrecto devuelve 401 sin revelar si el email existe', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'dra@demo.com', password: 'mal' }).expect(401);
    const b = await request(app).post('/api/auth/login').send({ email: 'nadie@demo.com', password: 'mal' }).expect(401);
    expect(a.body.error).toBe(b.body.error);
  });

  it('frena la fuerza bruta en el login', async () => {
    const previo = process.env.LOGIN_RATE_LIMIT;
    process.env.LOGIN_RATE_LIMIT = '3';
    const otraApp = crearApp();
    process.env.LOGIN_RATE_LIMIT = previo;
    for (let i = 0; i < 3; i++) await request(otraApp).post('/api/auth/login').send({ email: 'dra@demo.com', password: 'mal' }).expect(401);
    await request(otraApp).post('/api/auth/login').send({ email: 'dra@demo.com', password: 'demo1234' }).expect(429);
  });

  it('la secretaria NO puede leer historia clínica', async () => {
    const [{ id }] = await q('SELECT paciente_id AS id FROM consultas LIMIT 1');
    await secre.get(`/api/pacientes/${id}/historia`).expect(403);
  });

  it('la médica lee la historia y el acceso queda registrado', async () => {
    const [{ id }] = await q('SELECT paciente_id AS id FROM consultas LIMIT 1');
    const antes = (await q('SELECT count(*)::int AS n FROM accesos_historia'))[0].n;
    const r = await dra.get(`/api/pacientes/${id}/historia`).expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect((await q('SELECT count(*)::int AS n FROM accesos_historia'))[0].n).toBe(antes + 1);
  });

  it('solo el médico habilita sobreturnos', async () => {
    const [{ id: pac }] = await q('SELECT id FROM pacientes LIMIT 1');
    const inicio = new Date(Date.now() + 2 * 864e5).toISOString();
    await secre.post('/api/turnos').send({ paciente_id: pac, tipo_turno_id: 1, inicio, sobreturno: true }).expect(403);
  });
});

describe('Historia clínica auditada', () => {
  let consultaId: number;
  it('crear, editar y cerrar una consulta deja el historial con usuario, antes y después', async () => {
    const [{ id: pac }] = await q('SELECT id FROM pacientes ORDER BY id LIMIT 1');
    const c = await dra.post('/api/consultas').send({ paciente_id: pac, plantilla_id: 1, datos: { pio_od: 14 } }).expect(201);
    consultaId = c.body.id;
    await dra.patch(`/api/consultas/${consultaId}`).send({ datos: { pio_od: 16 }, diagnostico: 'Hipertensión ocular' }).expect(200);
    await dra.post(`/api/consultas/${consultaId}/cerrar`).expect(200);
    const h = await dra.get(`/api/consultas/${consultaId}/historial`).expect(200);
    expect(h.body.map((x: any) => x.accion)).toEqual(['INSERT', 'UPDATE', 'UPDATE']);
    expect(h.body[1]).toMatchObject({ usuario: 'Dra. Camila Ortiz', antes: { datos: { pio_od: 14 } }, despues: { datos: { pio_od: 16 } } });
  });

  it('una consulta no se borra: se anula, y solo con motivo', async () => {
    await expect(q('DELETE FROM consultas WHERE id = $1', [consultaId])).rejects.toThrow(/solo lectura/);
    await dra.post(`/api/consultas/${consultaId}/anular`).send({ motivo: 'no' }).expect(400);
    await dra.post(`/api/consultas/${consultaId}/anular`).send({ motivo: 'Paciente equivocado' }).expect(200);
    await dra.patch(`/api/consultas/${consultaId}`).send({ diagnostico: 'x' }).expect(422);
  });

  it('el audit_log no se puede modificar', async () => {
    await expect(q(`UPDATE audit_log SET accion = 'X'`)).rejects.toThrow(/solo lectura/);
  });

  it('emite una receta de anteojos imprimible', async () => {
    const [{ id }] = await q(`SELECT id FROM consultas WHERE estado = 'cerrada' LIMIT 1`);
    const r = await dra.post(`/api/consultas/${id}/recetas`).send({ tipo: 'anteojos', contenido: { od: { esf: '-1.25' }, oi: { esf: '-1.00', cil: '-0.50', eje: '90' } } }).expect(201);
    const html = await dra.get(`/api/recetas/${r.body.id}/imprimir`).expect(200);
    expect(html.text).toContain('-1.25');
  });
});

describe('Agenda y estados', () => {
  it('respeta la máquina de estados del turno', async () => {
    const [{ id }] = await q(`SELECT id FROM turnos WHERE estado = 'reservado' AND inicio > now() LIMIT 1`);
    await secre.patch(`/api/turnos/${id}/estado`).send({ estado: 'atendido' }).expect(422); // salta en_sala
    await secre.patch(`/api/turnos/${id}/estado`).send({ estado: 'en_sala' }).expect(200);
    await secre.patch(`/api/turnos/${id}/estado`).send({ estado: 'atendido' }).expect(200);
    await secre.patch(`/api/turnos/${id}/estado`).send({ estado: 'cancelado' }).expect(422);
  });

  it('un bloqueo devuelve los turnos que quedan afectados', async () => {
    const [t] = await q(`SELECT profesional_id, inicio, fin FROM turnos WHERE estado = 'reservado' AND inicio > now() + interval '2 days' ORDER BY inicio LIMIT 1`);
    const r = await dra.post('/api/bloqueos').send({ profesional_id: t.profesional_id, inicio: t.inicio, fin: t.fin, motivo: 'Congreso' }).expect(201);
    expect(r.body.turnos_afectados.length).toBeGreaterThanOrEqual(1);
  });

  it('un turno que quedó adentro de un bloqueo se puede confirmar y reprogramar', async () => {
    const [t] = await q(`SELECT id, profesional_id, inicio, fin FROM turnos
      WHERE estado = 'reservado' AND tipo_turno_id = 1 AND inicio > now() + interval '4 days' ORDER BY inicio DESC LIMIT 1`);
    await dra.post('/api/bloqueos').send({ profesional_id: t.profesional_id, inicio: t.inicio, fin: t.fin, motivo: 'Cirugía urgente' }).expect(201);
    await secre.patch(`/api/turnos/${t.id}/estado`).send({ estado: 'confirmado' }).expect(200);
    const nuevo = await slotLibre(1, 20);
    const r = await secre.patch(`/api/turnos/${t.id}/horario`).send({ inicio: nuevo }).expect(200);
    expect(r.body).toMatchObject({ estado: 'reservado' });
    expect(new Date(r.body.inicio).getTime()).toBe(new Date(nuevo).getTime());
    const rec = await q(`SELECT estado FROM recordatorios WHERE turno_id = $1 AND estado = 'pendiente'`, [t.id]);
    expect(rec).toHaveLength(1);
  });

  it('no se puede reprogramar un turno sobre un bloqueo', async () => {
    const [b] = await q(`SELECT profesional_id, inicio FROM bloqueos_agenda WHERE inicio > now() ORDER BY inicio LIMIT 1`);
    const [t] = await q(`SELECT id FROM turnos WHERE estado = 'reservado' AND profesional_id = $1 AND inicio > now() LIMIT 1`, [b.profesional_id]);
    const r = await secre.patch(`/api/turnos/${t.id}/horario`).send({ inicio: new Date(b.inicio).toISOString() });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/bloqueada/);
  });

  it('cancelar un turno cancela su recordatorio pendiente', async () => {
    const [{ id }] = await q(`SELECT t.id FROM turnos t JOIN recordatorios r ON r.turno_id = t.id
      WHERE t.estado = 'reservado' AND r.estado = 'pendiente' AND t.inicio > now() + interval '3 days' LIMIT 1`);
    await secre.patch(`/api/turnos/${id}/estado`).send({ estado: 'cancelado' }).expect(200);
    const [r] = await q('SELECT estado FROM recordatorios WHERE turno_id = $1', [id]);
    expect(r.estado).toBe('cancelado');
  });

  it('el paciente confirma respondiendo el WhatsApp', async () => {
    const [t] = await q(`SELECT t.id, p.telefono FROM turnos t JOIN pacientes p ON p.id = t.paciente_id
      WHERE t.estado = 'reservado' AND t.inicio > now() ORDER BY t.inicio LIMIT 1`);
    // Usa el próximo turno de ese teléfono, que puede ser otro del mismo paciente
    const r = await request(app).post('/api/webhooks/whatsapp').set('x-webhook-secret', 'cambiame')
      .send({ telefono: '+54 9 ' + t.telefono, texto: 'Confirmo' }).expect(200);
    expect(r.body.accion).toBe('confirmado');
    await request(app).post('/api/webhooks/whatsapp').send({ telefono: t.telefono, texto: 'Confirmo' }).expect(401);
  });

  it('entiende "Sí" con tilde y no confunde otras palabras', async () => {
    const [t] = await q(`SELECT p.telefono FROM turnos t JOIN pacientes p ON p.id = t.paciente_id
      WHERE t.estado = 'reservado' AND t.inicio > now() ORDER BY t.inicio DESC LIMIT 1`);
    const enviar = (texto: string) => request(app).post('/api/webhooks/whatsapp').set('x-webhook-secret', 'cambiame')
      .send({ telefono: t.telefono, texto }).expect(200);
    expect((await enviar('Siempre llego tarde')).body.accion).toBe('ignorado');
    expect((await enviar('Sí, gracias')).body.accion).toBe('confirmado');
  });
});

describe('Caja', () => {
  it('cobra, anula y totaliza por medio de pago', async () => {
    const [{ id: pac }] = await q('SELECT id FROM pacientes LIMIT 1');
    const antes = (await secre.get('/api/caja/hoy').expect(200)).body.total;
    const r = await secre.post('/api/pagos').send({ paciente_id: pac, tipo: 'particular', medio: 'debito', monto: 30000 }).expect(201);
    expect(r.body.total).toBe(antes + 30000);
    const pagoId = r.body.pagos[0].id;
    const an = await secre.post(`/api/pagos/${pagoId}/anular`).expect(200);
    expect(an.body.total).toBe(antes);
    await dra.get('/api/caja/hoy').expect(403); // la médica no maneja caja
  });

  it('la auditoría del admin oculta el contenido clínico', async () => {
    const r = await admin.get('/api/admin/auditoria?tabla=consultas&limit=5').expect(200);
    expect(r.body.length).toBeGreaterThan(0);
    expect(r.body.every((a: any) => a.antes === null && a.despues === null)).toBe(true);
  });
});
