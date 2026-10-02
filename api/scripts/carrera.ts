/**
 * Prueba de carrera contra la API en marcha: N personas intentan retener
 * el MISMO horario al mismo tiempo. Tiene que entrar exactamente una.
 *
 *   PUBLIC_RATE_LIMIT=1000 npm run dev      (en otra terminal)
 *   npm run carrera -- 50
 */
const BASE = process.env.API_URL ?? 'http://localhost:3000';
const N = Number(process.argv[2] ?? 50);

const disp = await fetch(`${BASE}/api/public/disponibilidad?tipo=1&dias=14`).then(r => r.json());
const inicio: string | undefined = disp.dias?.[0]?.slots?.[0];
if (!inicio) { console.error('No hay horarios libres para probar'); process.exit(1); }

console.log(`${N} reservas simultáneas para ${new Date(inicio).toLocaleString('es-AR', { timeZone: 'America/Argentina/Tucuman' })}…`);
const t0 = performance.now();
const res = await Promise.all(Array.from({ length: N }, () =>
  fetch(`${BASE}/api/public/retenciones`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tipo_turno_id: 1, inicio }),
  }).then(r => r.status)));
const ms = Math.round(performance.now() - t0);

const cuenta = res.reduce<Record<number, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {});
console.log(`\n  201 retenido: ${cuenta[201] ?? 0}`);
console.log(`  409 ocupado:  ${cuenta[409] ?? 0}`);
const otros = Object.entries(cuenta).filter(([s]) => !['201', '409'].includes(s));
if (otros.length) console.log(`  otros:        ${otros.map(([s, n]) => `${s}×${n}`).join(', ')}`);
console.log(`  tiempo total: ${ms} ms\n`);
console.log(cuenta[201] === 1 ? '✔ Exactamente una reserva. La base no permitió el choque.' : '✘ Algo anda mal: revisá los resultados.');
process.exit(cuenta[201] === 1 ? 0 : 1);
