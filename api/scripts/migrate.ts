/**
 * Aplica las migraciones de db/migrations en orden y registra cuáles corrieron.
 *   npm run migrate            → aplica las pendientes
 *   npm run migrate -- --reset → borra TODO y vuelve a crear (solo desarrollo)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

export async function migrar(url: string, { reset = false, silencioso = false } = {}) {
  const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    if (reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('--reset no se permite en producción');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      nombre TEXT PRIMARY KEY, aplicada_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT nombre FROM schema_migrations');
    const hechas = new Set(rows.map(r => r.nombre));
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (hechas.has(f)) continue;
      // Cada archivo corre como una sola transacción implícita: o entra entero o no entra
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations (nombre) VALUES ($1)', [f]);
      if (!silencioso) console.log(`✔ ${f}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio';
  migrar(url, { reset: process.argv.includes('--reset') })
    .then(() => console.log('Migraciones al día'))
    .catch(e => { console.error(e.message); process.exit(1); });
}
