/**
 * Datos de demostración (todo ficticio): usuarios, horarios, pacientes,
 * agenda de las próximas dos semanas, consultas pasadas, un bloqueo y la caja del día.
 *   npm run seed
 */
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../src/lib/auth.js';
import { config } from '../src/lib/config.js';
import { pool, tx, type Db } from '../src/lib/db.js';

export const USUARIOS_DEMO = [
  { email: 'admin@demo.com', nombre: 'Administración', rol: 'admin' },
  { email: 'dra@demo.com', nombre: 'Dra. Camila Ortiz', rol: 'medico' },
  { email: 'tecnico@demo.com', nombre: 'Téc. Martín Díaz', rol: 'medico' },
  { email: 'secretaria@demo.com', nombre: 'Lucía Gómez', rol: 'secretaria' },
] as const;
export const PASSWORD_DEMO = 'demo1234';

const PILA = ['Ana', 'Luis', 'Eva', 'Juan', 'Marta', 'Pedro', 'Sofía', 'Diego', 'Laura', 'Tomás', 'Valentina', 'Ramiro', 'Carla', 'Hugo', 'Nora',
  'Julieta', 'Mateo', 'Lucía', 'Bruno', 'Camila', 'Gonzalo', 'Paula', 'Facundo', 'Agustina', 'Emilio', 'Rocío', 'Ignacio', 'Florencia', 'Martín', 'Elena'];
const APELLIDOS = ['Paz', 'Gil', 'Sol', 'Ríos', 'Luna', 'Vera', 'Rey', 'Mora', 'Ibáñez', 'Coria', 'Cruz', 'Toledo', 'Medina', 'Paredes', 'Quiroga',
  'Ledesma', 'Juárez', 'Romano', 'Acosta', 'Villalba', 'Herrera', 'Sosa', 'Navarro', 'Benítez', 'Ojeda'];
const NOMBRES = Array.from({ length: 45 }, (_, i) => `${PILA[i % PILA.length]} ${APELLIDOS[(i * 7) % APELLIDOS.length]}`);

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }

/** Fecha local (Tucumán) → timestamptz ISO */
const local = (dia: string, hhmm: string) => `${dia}T${hhmm}:00-03:00`;
const diaLocal = (offset: number) => {
  const d = new Date(Date.now() + offset * 864e5);
  return d.toLocaleDateString('en-CA', { timeZone: config.tz });
};
const dow = (dia: string) => new Date(`${dia}T12:00:00-03:00`).getUTCDay();

async function insertarTurno(db: Db, v: unknown[]) {
  await db.query('SAVEPOINT t');
  try {
    const { rows: [t] } = await db.query(`
      INSERT INTO turnos (paciente_id, profesional_id, tipo_turno_id, inicio, estado, creado_por, origen)
      VALUES ($1,$2,$3,$4,$5,$6,'secretaria') RETURNING id, fin`, v);
    await db.query('RELEASE SAVEPOINT t');
    return t;
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT t'); // chocó con otro turno: lo salteamos
    return null;
  }
}

export async function seed({ silencioso = false } = {}) {
  if (!config.demo) {
    if (!silencioso) console.log('Producción sin SEED_DEMO=true: no se cargan usuarios de demo (tienen contraseña pública).');
    return;
  }
  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM usuarios');
  if (n > 0) { if (!silencioso) console.log('La base ya tiene datos. Usá `npm run migrate -- --reset` para empezar de cero.'); return; }

  const hash = await hashPassword(PASSWORD_DEMO);
  const ids: Record<string, number> = {};
  await tx(null, async db => {
    for (const u of USUARIOS_DEMO) {
      const { rows: [r] } = await db.query('INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES ($1,$2,$3,$4) RETURNING id', [u.nombre, u.email, hash, u.rol]);
      ids[u.email] = r.id;
    }
  });

  await tx(ids['admin@demo.com'], async db => {
    const { rows: [dra] } = await db.query(`INSERT INTO profesionales (usuario_id, matricula, especialidad, titulo) VALUES ($1, '0000 (demo)', 'oftalmologia', 'Médica oftalmóloga') RETURNING id`, [ids['dra@demo.com']]);
    const { rows: [tec] } = await db.query(`INSERT INTO profesionales (usuario_id, matricula, especialidad, titulo) VALUES ($1, NULL, 'estudios', 'Técnico en estudios oftalmológicos') RETURNING id`, [ids['tecnico@demo.com']]);
    await db.query(`UPDATE tipos_turno SET profesional_id = CASE WHEN nombre IN ('Consulta', 'Control postop') THEN $1::bigint ELSE $2::bigint END`, [dra.id, tec.id]);
    await db.query(`
      INSERT INTO horarios_atencion (profesional_id, dia_semana, desde, hasta)
      SELECT p, d, h.desde, h.hasta FROM unnest($1::bigint[]) p, generate_series(1, 5) d,
             (VALUES ('09:00'::time, '13:00'::time), ('16:00', '20:00')) h(desde, hasta)
      UNION ALL SELECT p, 6, '09:00', '12:00' FROM unnest($1::bigint[]) p`, [[dra.id, tec.id]]);

    const pacientes: number[] = [];
    for (const [i, nom] of NOMBRES.entries()) {
      const [nombre, apellido] = nom.split(' ');
      const { rows: [p] } = await db.query(`INSERT INTO pacientes (dni, nombre, apellido, telefono, obra_social_id, fecha_nac)
        VALUES ($1,$2,$3,$4,(SELECT id FROM obras_sociales ORDER BY id OFFSET $5 LIMIT 1), $6) RETURNING id`,
        [String(30000000 + i * 1371), nombre, apellido, `381555${String(1000 + i).padStart(4, '0')}`, i % 4, `${1950 + (i * 7) % 60}-0${1 + (i % 9)}-15`]);
      pacientes.push(p.id);
    }

    const { rows: tipos } = await db.query('SELECT id, duracion_min, profesional_id FROM tipos_turno ORDER BY id');
    const r = rng(42);
    let consultasCreadas = 0;
    // Agenda: 6 días hacia atrás (atendidos) y 13 hacia adelante (reservados)
    for (let off = -6; off <= 13; off++) {
      const dia = diaLocal(off), d = dow(dia);
      if (d === 0) continue;
      const franjas = d === 6 ? [[540, 720]] : [[540, 780], [960, 1200]];
      for (const tipoProf of [dra.id, tec.id]) {
        const delProf = tipos.filter(t => t.profesional_id === tipoProf);
        for (const [a, b] of franjas) {
          for (let m = a; m + 30 <= b; m += 10) {
            if (r() > 0.34) continue;
            const tipo = delProf[Math.floor(r() * delProf.length)];
            const hh = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
            const inicio = local(dia, hh);
            if (off === 0 && new Date(inicio) < new Date()) continue;
            const pac = pacientes[Math.floor(r() * pacientes.length)];
            const estado = off < 0 ? (r() < 0.12 ? 'ausente' : 'atendido') : (r() < 0.4 ? 'confirmado' : 'reservado');
            const t = await insertarTurno(db, [pac, tipoProf, tipo.id, inicio, estado, ids['secretaria@demo.com']]);
            if (!t) continue;
            m += tipo.duracion_min - 10;
            if (off >= 0) await db.query(`INSERT INTO recordatorios (turno_id, programado_para) VALUES ($1, GREATEST($2::timestamptz - interval '24 hours', now()))`, [t.id, inicio]);
            if (estado === 'atendido' && tipoProf === dra.id && consultasCreadas < 8) {
              await db.query(`SELECT set_config('app.user_id', $1, true)`, [String(ids['dra@demo.com'])]);
              await db.query(`INSERT INTO consultas (paciente_id, profesional_id, turno_id, plantilla_id, fecha, datos, diagnostico, indicaciones, estado)
                VALUES ($1,$2,$3,1,$4,$5,$6,$7,'cerrada')`,
                [pac, dra.id, t.id, inicio,
                 { motivo: 'Control anual', av_od_cc: '10/10', av_oi_cc: '9/10', pio_od: 14 + (consultasCreadas % 4), pio_oi: 15, fo_od: 'Normal', fo_oi: 'Normal' },
                 consultasCreadas % 3 === 0 ? 'Presbicia' : 'Miopía leve', 'Control en 12 meses']);
              await db.query(`SELECT set_config('app.user_id', $1, true)`, [String(ids['admin@demo.com'])]);
              consultasCreadas++;
            }
          }
        }
      }
    }

    // Lista de espera: dos pacientes quieren adelantar su consulta y una su OCT
    await db.query(`INSERT INTO lista_espera (paciente_id, tipo_turno_id, desde, hasta, notas, creado_por)
      SELECT p, t, NULL, NULL, n, $4 FROM (VALUES ($1::bigint, 1, 'Prefiere a la mañana'), ($2::bigint, 1, NULL), ($3::bigint, 3, 'Viene de otra ciudad')) v(p, t, n)`,
      [pacientes[3], pacientes[7], pacientes[11], ids['secretaria@demo.com']]);

    // Una parte de los turnos futuros entró por la web
    await db.query(`UPDATE turnos SET origen = 'web' WHERE inicio > now() AND id % 4 = 0`);

    // Próximo viernes a la tarde: cirugías
    for (let off = 1; off <= 7; off++) {
      const dia = diaLocal(off);
      if (dow(dia) !== 5) continue;
      await db.query(`UPDATE turnos SET estado = 'cancelado' WHERE profesional_id = $1 AND inicio >= $2 AND inicio < $3`, [dra.id, local(dia, '16:00'), local(dia, '20:00')]);
      await db.query(`INSERT INTO bloqueos_agenda (profesional_id, inicio, fin, motivo) VALUES ($1,$2,$3,'Cirugías programadas')`, [dra.id, local(dia, '16:00'), local(dia, '20:00')]);
      break;
    }
  });

  // Caja de hoy con un par de cobros
  await tx(ids['secretaria@demo.com'], async db => {
    const { rows: [c] } = await db.query(`INSERT INTO cajas (fecha, abierta_por) VALUES ((now() AT TIME ZONE $1)::date, $2) RETURNING id`, [config.tz, ids['secretaria@demo.com']]);
    await db.query(`INSERT INTO pagos (caja_id, paciente_id, tipo, medio, monto, creado_por)
      SELECT $1, id, 'particular', (ARRAY['efectivo','transferencia']::medio_pago[])[1 + (id % 2)::int], 25000, $2 FROM pacientes ORDER BY id LIMIT 2`, [c.id, ids['secretaria@demo.com']]);
  });

  if (!silencioso) {
    console.log('Datos de demo cargados. Usuarios (contraseña: demo1234):');
    for (const u of USUARIOS_DEMO) console.log(`  ${u.rol.padEnd(10)} ${u.email}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}
