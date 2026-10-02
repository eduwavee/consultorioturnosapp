import { useState } from 'react';
import { api, hoyISO, plata } from '../api';
import { Alerta, useCarga } from '../components/ui';

interface Reporte {
  desde: string; hasta: string;
  resumen: { obra_social: string; prestaciones: number; pacientes: number; copagos: number }[];
  detalle: { fecha: string; obra_social: string; paciente: string; dni: string; nro_afiliado: string | null; prestacion: string; profesional: string; copago: number }[];
}

/** Primer y último día del mes anterior, que es lo que se suele facturar. */
function mesAnterior() {
  const [a, m] = hoyISO().split('-').map(Number);
  const anio = m === 1 ? a - 1 : a, mes = m === 1 ? 12 : m - 1;
  const ultimo = new Date(Date.UTC(anio, mes, 0)).getUTCDate();
  const mm = String(mes).padStart(2, '0');
  return { desde: `${anio}-${mm}-01`, hasta: `${anio}-${mm}-${ultimo}` };
}

export function Reportes() {
  const [rango, setRango] = useState(mesAnterior);
  const [os, setOs] = useState('');
  const r = useCarga(() => api.get<Reporte>(`/admin/reportes/obras-sociales?desde=${rango.desde}&hasta=${rango.hasta}`), [rango.desde, rango.hasta]);
  const detalle = (r.data?.detalle ?? []).filter(d => !os || d.obra_social === os);
  const csv = `/api/admin/reportes/obras-sociales?desde=${rango.desde}&hasta=${rango.hasta}&formato=csv`;

  return (
    <>
      <div className="head">
        <div><h1>Reportes</h1><p className="muted">Prestaciones atendidas por obra social, para facturar.</p></div>
        <div className="row">
          <input className="input" type="date" aria-label="Desde" value={rango.desde} onChange={e => e.target.value && setRango(x => ({ ...x, desde: e.target.value }))} style={{ width: 160, height: 30 }} />
          <span className="muted">a</span>
          <input className="input" type="date" aria-label="Hasta" value={rango.hasta} onChange={e => e.target.value && setRango(x => ({ ...x, hasta: e.target.value }))} style={{ width: 160, height: 30 }} />
          <button className="btn sm" onClick={() => setRango(mesAnterior())}>Mes anterior</button>
          <a className="btn primary sm" href={csv} download>Descargar CSV</a>
        </div>
      </div>
      <Alerta error={r.error} />
      {r.data && (
        <div className="grid2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.8fr)', alignItems: 'start' }}>
          <div className="card" style={{ padding: 6 }}>
            <table className="table">
              <thead><tr><th>Obra social</th><th className="n">Prestaciones</th><th className="n">Pacientes</th><th className="n">Copagos</th></tr></thead>
              <tbody>
                {r.data.resumen.map(x => (
                  <tr key={x.obra_social} className="click" onClick={() => setOs(os === x.obra_social ? '' : x.obra_social)}
                    style={os === x.obra_social ? { background: 'var(--teal-50)' } : undefined}>
                    <td>{x.obra_social}</td><td className="n">{x.prestaciones}</td><td className="n">{x.pacientes}</td><td className="n">{plata(x.copagos)}</td>
                  </tr>
                ))}
                {!r.data.resumen.length && <tr><td colSpan={4} className="muted">No hay turnos atendidos en ese período.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="card" style={{ padding: 6 }}>
            <div className="row" style={{ padding: '10px 10px 4px', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{os || 'Todas las obras sociales'} · {detalle.length}</h3>
              {os && <button className="btn ghost sm" onClick={() => setOs('')}>Ver todas</button>}
            </div>
            <table className="table">
              <thead><tr><th>Fecha</th><th>Paciente</th><th>Afiliado</th><th>Prestación</th><th>Profesional</th></tr></thead>
              <tbody>{detalle.slice(0, 300).map((d, i) => (
                <tr key={i}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{d.fecha}</td>
                  <td>{d.paciente}<div className="muted mono" style={{ fontSize: 12.5 }}>DNI {d.dni}</div></td>
                  <td className="mono">{d.nro_afiliado ?? <span className="muted">—</span>}</td>
                  <td>{d.prestacion}</td><td className="muted">{d.profesional}</td>
                </tr>
              ))}</tbody>
            </table>
            {detalle.length > 300 && <p className="muted" style={{ padding: 10, fontSize: 13 }}>Se muestran 300 de {detalle.length}. El CSV tiene todas.</p>}
          </div>
        </div>
      )}
      <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>Se usa la cobertura que cada paciente tiene cargada hoy. Si alguien cambió de obra social en el período, revisalo antes de facturar.</p>
    </>
  );
}
