import { useEffect, useState } from 'react';
import { api, hora, plata, type Paciente, type Turno } from '../api';
import { ir, useRuta } from '../App';
import { Alerta, BuscarPaciente, useCarga } from '../components/ui';

interface Resumen {
  caja: { id: number; fecha: string; cerrada_at: string | null; abierta_por_nombre: string; cerrada_por_nombre: string | null } | null;
  pagos: { id: number; monto: number; medio: string; tipo: string; anulado: boolean; creado_at: string; paciente: string }[];
  totales: Record<string, number>; total: number;
}
const MEDIOS = ['efectivo', 'transferencia', 'debito', 'credito', 'obra_social'] as const;
const MEDIO_LABEL: Record<string, string> = { efectivo: 'Efectivo', transferencia: 'Transferencia', debito: 'Débito', credito: 'Crédito', obra_social: 'Obra social' };

export function Caja() {
  const { params } = useRuta();
  const r = useCarga(() => api.get<Resumen>('/caja/hoy'), []);
  const [error, setError] = useState<string | null>(null);
  const [pac, setPac] = useState<Paciente | null>(null);
  const [monto, setMonto] = useState('25000');
  const [medio, setMedio] = useState<string>('efectivo');
  const [tipo, setTipo] = useState<string>('particular');
  const turnoId = params.get('turno') ? Number(params.get('turno')) : null;
  const pacienteParam = params.get('paciente');

  const [aviso, setAviso] = useState<string | null>(null);

  // Viniendo de "Cobrar" en la agenda: el paciente queda elegido y el monto sale del precio del estudio
  useEffect(() => {
    if (!pacienteParam) return;
    let vivo = true;
    api.get<Paciente>(`/pacientes/${pacienteParam}`).then(p => { if (vivo) setPac(p); }).catch(() => {});
    if (turnoId) api.get<Turno>(`/turnos/${turnoId}`).then(t => {
      if (!vivo) return;
      if (t.precio != null) setMonto(String(t.precio));
      setAviso(t.cobrado ? 'Este turno ya tiene un cobro registrado. Revisá antes de cobrar de nuevo.' : null);
    }).catch(() => {});
    return () => { vivo = false; };
  }, [pacienteParam, turnoId]);

  const accion = async (fn: () => Promise<Resumen>) => {
    setError(null);
    try { r.setData(await fn()); } catch (e: any) { setError(e.message); }
  };
  const cobrar = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pac) { setError('Elegí el paciente'); return; }
    accion(async () => {
      const r = await api.post<Resumen>('/pagos', { paciente_id: pac.id, turno_id: turnoId, tipo, medio, monto: Number(monto) });
      // El turno ya quedó cobrado: los próximos cobros no se le asocian
      if (turnoId) ir('/caja');
      return r;
    });
  };

  const d = r.data;
  return (
    <>
      <div className="head">
        <div><h1>Caja del día</h1>
          <p className="muted">{d?.caja ? `Abierta por ${d.caja.abierta_por_nombre}${d.caja.cerrada_at ? ` · cerrada por ${d.caja.cerrada_por_nombre} a las ${hora(d.caja.cerrada_at)}` : ''}` : 'Todavía no se abrió la caja de hoy.'}</p></div>
        {d?.caja && (
          <div className="row">
            <a className="btn sm" href="/api/caja/imprimir" target="_blank" rel="noopener">Imprimir cierre</a>
            {!d.caja.cerrada_at && <button className="btn sm" onClick={() => accion(() => api.post('/caja/cerrar'))}>Cerrar caja</button>}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}><Alerta error={error ?? r.error} />{aviso && <div className="alert info">{aviso}</div>}</div>
      {d && !d.caja && <div className="card"><p style={{ marginBottom: 12 }}>Abrí la caja para empezar a registrar cobros.</p><button className="btn primary" onClick={() => accion(() => api.post('/caja/abrir'))}>Abrir caja</button></div>}
      {d?.caja && (
        <>
          <div className="stats">
            <div className="stat"><span>Total del día</span><b className="mono">{plata(d.total)}</b></div>
            {Object.entries(d.totales).map(([m, t]) => <div className="stat" key={m}><span>{MEDIO_LABEL[m]}</span><b className="mono">{plata(t)}</b></div>)}
          </div>
          <div className="grid2" style={{ alignItems: 'start' }}>
            {!d.caja.cerrada_at ? (
              <form className="card" onSubmit={cobrar} style={{ display: 'grid', gap: 12 }}>
                <h3>Registrar cobro{turnoId ? ` · turno #${turnoId}` : ''}</h3>
                <BuscarPaciente onElegir={setPac} inicial={pac} />
                <div className="form-grid">
                  <div className="field"><label htmlFor="c-m">Monto</label><input id="c-m" className="input mono" type="number" min={0} step={100} value={monto} onChange={e => setMonto(e.target.value)} required /></div>
                  <div className="field"><label htmlFor="c-me">Medio</label><select id="c-me" className="input" value={medio} onChange={e => setMedio(e.target.value)}>{MEDIOS.map(m => <option key={m} value={m}>{MEDIO_LABEL[m]}</option>)}</select></div>
                  <div className="field"><label htmlFor="c-t">Tipo</label><select id="c-t" className="input" value={tipo} onChange={e => setTipo(e.target.value)}><option value="particular">Particular</option><option value="copago">Copago</option><option value="obra_social">Obra social</option></select></div>
                </div>
                <button className="btn primary">Cobrar</button>
              </form>
            ) : <div className="card"><p className="muted">La caja está cerrada. Los cobros nuevos van en la caja de mañana.</p></div>}
            <div className="card" style={{ padding: 6 }}>
              <table className="table">
                <thead><tr><th>Hora</th><th>Paciente</th><th>Medio</th><th style={{ textAlign: 'right' }}>Monto</th><th /></tr></thead>
                <tbody>
                  {d.pagos.map(p => (
                    <tr key={p.id} style={p.anulado ? { opacity: .5, textDecoration: 'line-through' } : undefined}>
                      <td className="mono">{hora(p.creado_at)}</td><td>{p.paciente}</td><td>{MEDIO_LABEL[p.medio]}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{plata(p.monto)}</td>
                      <td>{!p.anulado && !d.caja!.cerrada_at && <button className="btn ghost sm danger" onClick={() => accion(() => api.post(`/pagos/${p.id}/anular`))}>Anular</button>}</td>
                    </tr>
                  ))}
                  {!d.pagos.length && <tr><td colSpan={5} className="muted">Sin cobros todavía.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
