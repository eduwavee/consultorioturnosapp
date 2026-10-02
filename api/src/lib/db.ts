import pg from 'pg';
import { config } from './config.js';

// Postgres devuelve BIGINT como string; los ids de este sistema entran en un number
pg.types.setTypeParser(20, v => Number(v));
// NUMERIC (montos) como number
pg.types.setTypeParser(1700, v => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export type Db = pg.PoolClient;

/**
 * Ejecuta fn dentro de una transacción y deja registrado quién la hizo.
 * La auditoría (audit_row) lee app.user_id, así que TODA escritura pasa por acá.
 */
export async function tx<T>(userId: number | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId == null ? '' : String(userId)]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query<T>(sql, params);
  return r.rows;
}
