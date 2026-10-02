import { useEffect, useState } from 'react';
import { api, fecha, hora, type Paciente } from '../api';
import { ir, useRuta, useSesion } from '../App';
import { Alerta, Modal, useCarga } from '../components/ui';

export function Pacientes() {
  const { params } = useRuta();
  const [texto, setTexto] = useState('');
  const [busca, setBusca] = useState('');
  const [nuevo, setNuevo] = useState(params.get('nuevo') === '1');
  useEffect(() => { const t = setTimeout(() => setBusca(texto), 220); return () => clearTimeout(t); }, [texto]);
  const { data, error } = useCarga(() => api.get<Paciente[]>(`/pacientes?q=${encodeURIComponent(busca)}`), [busca]);

  return (
    <>
      <div className="head">
        <div><h1>Pacientes</h1><p className="muted">Buscá por nombre, apellido o DNI.</p></div>
        <button className="btn primary sm" onClick={() => setNuevo(true)}>Nuevo paciente</button>
      </div>
      <input className="input" placeholder="Buscar…" value={texto} onChange={e => setTexto(e.target.value)} style={{ maxWidth: 420, marginBottom: 16 }} autoFocus aria-label="Buscar pacientes" />
      <Alerta error={error} />
      <div className="card" style={{ padding: 6 }}>
        <table className="table">
          <thead><tr><th>Paciente</th><th>DNI</th><th>Cobertura</th><th>WhatsApp</th><th>Próximo turno</th></tr></thead>
          <tbody>
            {data?.map(p => (
              <tr key={p.id} className="click" onClick={() => ir(`/pacientes/${p.id}`)}>
                <td><b style={{ fontWeight: 600 }}>{p.apellido}, {p.nombre}</b></td>
                <td className="mono">{p.dni}</td>
                <td className="muted">{p.obra_social ?? '—'}</td>
                <td className="mono muted">{p.telefono ?? '—'}</td>
                <td className="mono">{p.proximo_turno ? `${fecha(p.proximo_turno, { day: 'numeric', month: 'short' })} · ${hora(p.proximo_turno)}` : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {data?.length === 0 && <tr><td colSpan={5} className="muted">No hay pacientes que coincidan con “{busca}”.</td></tr>}
          </tbody>
        </table>
      </div>
      {nuevo && <FormPaciente onClose={() => setNuevo(false)} onOk={p => ir(`/pacientes/${p.id}`)} />}
    </>
  );
}

export function FormPaciente({ inicial, onClose, onOk }: { inicial?: Paciente; onClose: () => void; onOk: (p: Paciente) => void }) {
  const { cat } = useSesion();
  const [v, setV] = useState<Partial<Paciente>>(inicial ?? {});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Paciente) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV(x => ({ ...x, [k]: k === 'obra_social_id' ? (e.target.value ? Number(e.target.value) : null) : e.target.value || null }));

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = { dni: v.dni, nombre: v.nombre, apellido: v.apellido, telefono: v.telefono ?? null, email: v.email ?? null,
      fecha_nac: v.fecha_nac ? String(v.fecha_nac).slice(0, 10) : null, obra_social_id: v.obra_social_id ?? null,
      nro_afiliado: v.nro_afiliado ?? null, notas_admin: v.notas_admin ?? null };
    try {
      const p = inicial ? await api.patch<Paciente>(`/pacientes/${inicial.id}`, body) : await api.post<Paciente>('/pacientes', body);
      onOk(p);
    } catch (err: any) { setError(err.message); }
  };

  return (
    <Modal titulo={inicial ? 'Editar paciente' : 'Nuevo paciente'} onClose={onClose}>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="p-n">Nombre</label><input id="p-n" className="input" value={v.nombre ?? ''} onChange={set('nombre')} required autoFocus /></div>
          <div className="field"><label htmlFor="p-a">Apellido</label><input id="p-a" className="input" value={v.apellido ?? ''} onChange={set('apellido')} required /></div>
          <div className="field"><label htmlFor="p-d">DNI</label><input id="p-d" className="input" inputMode="numeric" value={v.dni ?? ''} onChange={set('dni')} required pattern="\d{7,8}" /></div>
          <div className="field"><label htmlFor="p-f">Nacimiento</label><input id="p-f" className="input" type="date" value={v.fecha_nac ? String(v.fecha_nac).slice(0, 10) : ''} onChange={set('fecha_nac')} /></div>
          <div className="field"><label htmlFor="p-t">WhatsApp</label><input id="p-t" className="input" type="tel" value={v.telefono ?? ''} onChange={set('telefono')} /></div>
          <div className="field"><label htmlFor="p-e">Email</label><input id="p-e" className="input" type="email" value={v.email ?? ''} onChange={set('email')} /></div>
          <div className="field"><label htmlFor="p-o">Cobertura</label>
            <select id="p-o" className="input" value={v.obra_social_id ?? ''} onChange={set('obra_social_id')}>
              <option value="">Sin cargar</option>{cat.obras_sociales.map(o => <option key={o.id} value={o.id}>{o.nombre}</option>)}
            </select></div>
          <div className="field"><label htmlFor="p-af">N.º afiliado</label><input id="p-af" className="input" value={v.nro_afiliado ?? ''} onChange={set('nro_afiliado')} /></div>
        </div>
        <div className="field"><label htmlFor="p-no">Notas administrativas</label><textarea id="p-no" className="input" value={v.notas_admin ?? ''} onChange={set('notas_admin')} placeholder="Solo datos administrativos, nada clínico." /></div>
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}
