import { useState } from 'react';
import { api, fecha, hora, type EntradaEspera, type Paciente } from '../api';
import { ir, useSesion } from '../App';
import { Alerta, BuscarPaciente, Modal, useCarga } from '../components/ui';

/**
 * Pacientes que quieren un turno antes. Cuando se cancela o se mueve un turno,
 * el worker les avisa por WhatsApp con un link para reservar ese horario.
 */
export function ListaEspera() {
  const { cat } = useSesion();
  const [todos, setTodos] = useState(false);
  const [nuevo, setNuevo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const l = useCarga(() => api.get<EntradaEspera[]>(`/lista-espera?todos=${todos ? 1 : 0}`), [todos]);
  const [tipo, setTipo] = useState<number | ''>('');

  const resolver = async (id: number) => {
    setError(null);
    try { await api.post(`/lista-espera/${id}/resolver`); l.recargar(); } catch (e: any) { setError(e.message); }
  };
  const filas = (l.data ?? []).filter(e => tipo === '' || e.tipo_turno_id === tipo);
  const rango = (e: EntradaEspera) =>
    e.desde && e.hasta ? `del ${fecha(e.desde, { day: 'numeric', month: 'short' })} al ${fecha(e.hasta, { day: 'numeric', month: 'short' })}`
      : e.hasta ? `antes del ${fecha(e.hasta, { day: 'numeric', month: 'short' })}`
      : e.desde ? `desde el ${fecha(e.desde, { day: 'numeric', month: 'short' })}` : 'Cualquier fecha';

  return (
    <>
      <div className="head">
        <div>
          <h1>Lista de espera</h1>
          <p className="muted">Si se libera un horario, el sistema les avisa por WhatsApp a los primeros de la lista.</p>
        </div>
        <div className="row">
          <select className="input" aria-label="Filtrar por estudio" value={tipo} onChange={e => setTipo(e.target.value ? Number(e.target.value) : '')} style={{ width: 200, height: 30 }}>
            <option value="">Todos los estudios</option>
            {cat.tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
          </select>
          <label className="row" style={{ fontSize: 13.5, gap: 6 }}><input type="checkbox" checked={todos} onChange={e => setTodos(e.target.checked)} /> Ver resueltos</label>
          <button className="btn primary sm" onClick={() => setNuevo(true)}>Agregar paciente</button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }}><Alerta error={error ?? l.error} /></div>
      <div className="card" style={{ padding: 6 }}>
        <table className="table">
          <thead><tr><th>Paciente</th><th>Estudio</th><th>Cuándo le sirve</th><th>Turno actual</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {filas.map(e => (
              <tr key={e.id} style={e.resuelto_at ? { opacity: .55 } : undefined}>
                <td>
                  <button className="btn ghost sm" style={{ padding: 0, fontWeight: 600 }} onClick={() => ir(`/pacientes/${e.paciente_id}`)}>{e.paciente}</button>
                  <div className="muted mono" style={{ fontSize: 12.5 }}>{e.telefono}</div>
                  {e.notas && <div className="muted" style={{ fontSize: 12.5 }}>{e.notas}</div>}
                </td>
                <td>{e.tipo}</td>
                <td>{rango(e)}</td>
                <td className="mono">{e.turno_actual ? `${fecha(e.turno_actual, { day: 'numeric', month: 'short' })} · ${hora(e.turno_actual)}` : <span className="muted">Sin turno</span>}</td>
                <td>
                  {e.resuelto_at ? <span className="badge">Resuelto</span>
                    : e.avisado_at ? <span className="badge warn" title="Se le avisó de un horario libre">Avisado {fecha(e.avisado_at, { day: 'numeric', month: 'short' })}</span>
                    : <span className="badge ok">Esperando</span>}
                  <div className="muted" style={{ fontSize: 12 }}>desde {fecha(e.creado_at, { day: 'numeric', month: 'short' })}</div>
                </td>
                <td>{!e.resuelto_at && <button className="btn sm" onClick={() => resolver(e.id)}>Sacar de la lista</button>}</td>
              </tr>
            ))}
            {l.data && !filas.length && <tr><td colSpan={6} className="muted">No hay pacientes esperando{tipo !== '' ? ' para ese estudio' : ''}.</td></tr>}
          </tbody>
        </table>
      </div>
      {nuevo && <NuevaEspera onClose={() => setNuevo(false)} onOk={() => { setNuevo(false); l.recargar(); }} />}
    </>
  );
}

function NuevaEspera({ onClose, onOk }: { onClose: () => void; onOk: () => void }) {
  const { cat } = useSesion();
  const [pac, setPac] = useState<Paciente | null>(null);
  const [tipo, setTipo] = useState(cat.tipos[0]?.id ?? 1);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [notas, setNotas] = useState('');
  const [error, setError] = useState<string | null>(null);
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pac) { setError('Elegí un paciente'); return; }
    try {
      await api.post('/lista-espera', { paciente_id: pac.id, tipo_turno_id: tipo, desde: desde || null, hasta: hasta || null, notas: notas || null });
      onOk();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal titulo="Agregar a la lista de espera" onClose={onClose}>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <BuscarPaciente onElegir={setPac} autoFocus />
        <div className="form-grid">
          <div className="field"><label htmlFor="le-t">Estudio</label>
            <select id="le-t" className="input" value={tipo} onChange={e => setTipo(Number(e.target.value))}>
              {cat.tipos.map(t => <option key={t.id} value={t.id}>{t.nombre}</option>)}
            </select></div>
          <div className="field"><label htmlFor="le-d">Desde (opcional)</label><input id="le-d" className="input" type="date" value={desde} onChange={e => setDesde(e.target.value)} /></div>
          <div className="field"><label htmlFor="le-h">Hasta (opcional)</label><input id="le-h" className="input" type="date" value={hasta} onChange={e => setHasta(e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="le-n">Notas</label><input id="le-n" className="input" placeholder="Ej.: solo a la mañana" value={notas} onChange={e => setNotas(e.target.value)} /></div>
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary">Agregar</button>
        </div>
      </form>
    </Modal>
  );
}
