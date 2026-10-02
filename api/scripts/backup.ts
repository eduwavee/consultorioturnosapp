/**
 * Backup de la base con pg_dump (formato custom, comprimido).
 *   npm run backup                       → backups/consultorio-AAAAMMDD-HHMM.dump
 *   BACKUP_DIR=/ruta BACKUP_KEEP=60 npm run backup
 *
 * Restaurar en una base vacía:
 *   pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backups/consultorio-....dump
 *
 * Requiere pg_dump instalado y de la misma versión mayor (o más nueva) que el servidor.
 * Los backups tienen historias clínicas: guardalos cifrados y fuera del repo.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const url = process.env.DATABASE_URL ?? 'postgres://consultorio:consultorio@localhost:5432/consultorio';
const dir = path.resolve(process.env.BACKUP_DIR ?? path.join(raiz, 'backups'));
const conservar = Number(process.env.BACKUP_KEEP ?? 30);

const sello = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const archivo = path.join(dir, `consultorio-${sello}.dump`);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--file', archivo, url], { stdio: ['ignore', 'inherit', 'inherit'] });
dump.on('error', e => { console.error(`No se pudo correr pg_dump: ${e.message}`); process.exit(1); });
dump.on('close', codigo => {
  if (codigo !== 0) { fs.rmSync(archivo, { force: true }); console.error(`pg_dump terminó con código ${codigo}`); process.exit(1); }
  fs.chmodSync(archivo, 0o600);
  const kb = Math.round(fs.statSync(archivo).size / 1024);
  console.log(`✔ Backup: ${archivo} (${kb} KB)`);
  // Rotación: quedan los últimos N
  const viejos = fs.readdirSync(dir).filter(f => /^consultorio-.*\.dump$/.test(f)).sort().reverse().slice(conservar);
  for (const f of viejos) fs.rmSync(path.join(dir, f));
  if (viejos.length) console.log(`  Se borraron ${viejos.length} backups viejos (se conservan ${conservar}).`);
});
