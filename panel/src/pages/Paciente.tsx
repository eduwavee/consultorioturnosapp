import { useState } from 'react';
import { api, ESTADO_LABEL, fecha, hora, type Consulta, type Paciente } from '../api';
import { ir, useSesion } from '../App';
import { Alerta, useCarga } from '../components/ui';
import { FormPaciente } from './Pacientes';

export function PacientePage({ id }: { id: number }) {
  const { puede } = useSesion();
  const p = useCarga(() => api.get<Paciente>(`/pacientes/${id}`), [id]);
  const [editar, setEditar] = useState(false);

  if (p.error) return <Alerta error={p.error} />;
  if (!p.data) return null;
  const d = p.data;
  const edad = d.fecha_nac ? Math.floor((Date.now() - new Date(d.fecha_nac).getTime()) / 31_557_600_000) : null;

  return (
    <>
      <div className="head">
        <div>
          <a href="#/pacientes" className="muted" style={{ fontSize: 13 }}>← Pacientes</a>
          <h1 style={{ marginTop: 6 }}>{d.nombre} {d.apellido}</h1>
          <p className="muted">DNI {d.dni}{edad != null ? ` · ${edad} años` : ''}{d.obra_social ? ` · ${d.obra_social}` : ''}</p>
        </div>
        <div className="row">
          <button className="btn sm" onClick={() => setEditar(true)}>Editar datos</button>
          {puede('medico') && <button className="btn primary sm" onClick={() => ir(`/consulta/nueva?paciente=${d.id}`)}>Nueva consulta</button>}
        </div>
      </div>

      <div className="grid2" style={{ alignItems: 'start' }}>
        <div>
          <div className="card">
            <h3>Datos de contacto</h3>
            <div className="kv" style={{ margin: 0 }}>
              <span>WhatsApp</span><span className="mono" style={{ color: 'inherit' }}>{d.telefono ?? '—'}</span>
              <span>Email</span><span style={{ color: 'inherit' }}>{d.email ?? '—'}</span>
              <span>Afiliado</span><span className="mono" style={{ color: 'inherit' }}>{d.nro_afiliado ?? '—'}</span>
              <span>Notas</span><span style={{ color: 'inherit' }}>{d.notas_admin ?? '—'}</span>
            </div>
          </div>
          <div className="card">
            <h3>Turnos</h3>
            <table className="table"><tbody>
              {d.turnos?.map(t => (
                <tr key={t.id}><td className="mono">{fecha(t.inicio)} · {hora(t.inicio)}</td><td>{t.tipo}</td><td><span className={`chip ${t.estado}`}>{ESTADO_LABEL[t.estado]}</span></td></tr>
              ))}
              {!d.turnos?.length && <tr><td className="muted">Sin turnos.</td></tr>}
            </tbody></table>
          </div>
        </div>
        {puede('medico') ? <Historia pacienteId={d.id} /> : (
          <div className="card"><h3>Historia clínica</h3><p className="muted">Solo el profesional puede ver la historia clínica. El acceso queda registrado.</p></div>
        )}
      </div>
      {editar && <FormPaciente inicial={d} onClose={() => setEditar(false)} onOk={() => { setEditar(false); p.recargar(); }} />}
    </>
  );
}

function Historia({ pacienteId }: { pacienteId: number }) {
  const { data, error } = useCarga(() => api.get<Consulta[]>(`/pacientes/${pacienteId}/historia`), [pacienteId]);
  return (
    <div className="card">
      <h3>Historia clínica</h3>
      <Alerta error={error} />
      <div className="timeline">
        {data?.map(c => (
          <div key={c.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b style={{ fontWeight: 600 }}>{fecha(c.fecha)}</b><span className={`chip ${c.estado}`}>{c.estado}</span>
            </div>
            <p style={{ marginTop: 4 }}>{c.diagnostico ?? <span className="muted">Sin diagnóstico</span>}</p>
            {c.estado === 'anulada' && <p className="muted" style={{ fontSize: 13 }}>Anulada: {c.motivo_anulacion}</p>}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => ir(`/consulta/${c.id}?paciente=${pacienteId}`)}>Abrir</button>
              {c.recetas?.map(r => <a key={r.id} className="btn ghost sm" href={`/api/recetas/${r.id}/imprimir`} target="_blank" rel="noopener">Receta {r.tipo.replace('_', ' ')}</a>)}
            </div>
          </div>
        ))}
        {data?.length === 0 && <p className="muted">Todavía no hay consultas.</p>}
      </div>
    </div>
  );
}
