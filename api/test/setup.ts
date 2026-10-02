import { migrar } from '../scripts/migrate.js';

/** Base de test limpia en cada corrida: esquema completo + datos de demo. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio_test';
  process.env.DATABASE_URL = url;
  await migrar(url, { reset: true, silencioso: true });
  const { seed } = await import('../scripts/seed.js');
  const { pool } = await import('../src/lib/db.js');
  await seed({ silencioso: true });
  await pool.end();
}
