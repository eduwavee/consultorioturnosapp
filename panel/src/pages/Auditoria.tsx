import { useState } from 'react';
import { api, fecha, hora, plata, type Auditoria as Fila } from '../api';
import { Alerta, useCarga } from '../components/ui';

interface Reporte { turnos: number; ausentes: number; cancelados: number; web: number; consultorio: number; ingresos: { medio: string; total: number }[]; lista_espera: { activos: number; avisados: number } }
const TABLAS = ['', 'turnos', 'pacientes', 'consultas', 'recetas', 'pagos', 'lista_espera', 'bloqueos_agenda', 'tipos_turno', 'horarios_atencion', 'consultorio'] as const;
const ETIQUETA: Record<string, string> = { lista_espera: 'lista de espera', bloqueos_agenda: 'bloqueos', tipos_turno: 'estudios', horarios_atencion: 'horarios', consultorio: 'consultorio' };

export function Auditoria() {
  const [tabla, setTabla] = useState<string>('');
  const rep = useCarga(() => api.get<Reporte>('/admin/reportes/mes'), []);
  const log = useCarga(() => api.get<Fila[]>(`/admin/auditoria?limit=150${tabla ? `&tabla=${tabla}` : ''}`), [tabla]);
  const acc = useCarga(() => api.get<{ id: number; at: string; usuario: string; paciente: string }[]>('/admin/accesos'), []);
  const r = rep.data;
  const pct = (a: number, b: number) => b ? `${Math.round((a / b) * 100)} %` : '—';

  return (
    <>
      <div className="head"><div><h1>Auditoría</h1><p className="muted">Todo lo que se hace en el sistema queda registrado y no se puede modificar.</p></div></div>
      <Alerta error={rep.error ?? log.error} />
      {r && (
        <div className="stats">
          <div className="stat"><span>Turnos del mes</span><b className="mono">{r.turnos}</b></div>
          <div className="stat"><span>Reservados online</span><b className="mono">{pct(r.web, r.web + r.consultorio)}</b></div>
          <div className="stat"><span>Ausentismo</span><b className="mono">{pct(r.ausentes, r.turnos)}</b></div>
          <div className="stat"><span>En lista de espera</span><b className="mono">{r.lista_espera.activos}</b></div>
          <div className="stat"><span>Ingresos del mes</span><b className="mono">{plata(r.ingresos.reduce((a, i) => a + i.total, 0))}</b></div>
        </div>
      )}
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0,1.7fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div className="card" style={{ padding: 6 }}>
          <div className="row" style={{ padding: '10px 10px 4px' }}>
            {TABLAS.map(t => <button key={t} className={`btn sm${tabla === t ? ' primary' : ''}`} onClick={() => setTabla(t)}>{t ? ETIQUETA[t] ?? t : 'Todo'}</button>)}
          </div>
          <table className="table">
            <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué</th><th>Detalle</th></tr></thead>
            <tbody>{log.data?.map(a => (
              <tr key={a.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fecha(a.at, { day: 'numeric', month: 'short' })} {hora(a.at)}</td>
                <td>{a.usuario ?? <span className="muted">web / sistema</span>}</td>
                <td><span className="chip">{a.accion.toLowerCase()}</span> {a.tabla} #{a.registro_id}</td>
                <td className="muted" style={{ fontSize: 13 }}>{resumen(a)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <div className="card">
          <h3>Quién abrió historias clínicas</h3>
          <table className="table"><tbody>{acc.data?.slice(0, 30).map(a => (
            <tr key={a.id}><td className="mono" style={{ whiteSpace: 'nowrap' }}>{fecha(a.at, { day: 'numeric', month: 'short' })} {hora(a.at)}</td><td>{a.usuario}</td><td className="muted">{a.paciente}</td></tr>
          ))}{acc.data?.length === 0 && <tr><td className="muted">Sin accesos todavía.</td></tr>}</tbody></table>
        </div>
      </div>
    </>
  );
}

/** Resumen legible de un cambio. El contenido clínico no llega al admin (la API lo oculta). */
function resumen(a: Fila) {
  if (a.tabla === 'consultas' || a.tabla === 'recetas') return 'Contenido clínico protegido';
  if (!a.antes || !a.despues) {
    const d = a.despues ?? a.antes ?? {};
    if (a.tabla === 'pagos') return `${d.medio} · $ ${Number(d.monto).toLocaleString('es-AR')}`;
    if (a.tabla === 'pacientes') return `${d.nombre} ${d.apellido} · DNI ${d.dni}`;
    return d.estado ? `estado: ${d.estado}${d.origen === 'web' ? ' · web' : ''}` : '';
  }
  const c = Object.keys(a.despues).filter(k => JSON.stringify(a.antes[k]) !== JSON.stringify(a.despues[k]) && !['token_retencion', 'expira_at'].includes(k));
  return c.map(k => `${k}: ${a.antes[k] ?? '∅'} → ${a.despues[k] ?? '∅'}`).join(' · ');
}
