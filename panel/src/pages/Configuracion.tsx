import { useState } from 'react';
import { api, plata, type Rol } from '../api';
import { useSesion } from '../App';
import { Alerta, Modal, useCarga } from '../components/ui';

const PESTANAS = [
  ['consultorio', 'Consultorio'], ['usuarios', 'Usuarios'], ['estudios', 'Estudios'],
  ['horarios', 'Horarios de atención'], ['coberturas', 'Obras sociales y equipos'],
] as const;
type Pestana = typeof PESTANAS[number][0];

/** Todo lo que antes salía del seed o de SQL a mano, editable por administración. */
export function Configuracion() {
  const [tab, setTab] = useState<Pestana>('consultorio');
  return (
    <>
      <div className="head"><div><h1>Configuración</h1><p className="muted">Los cambios quedan registrados en la auditoría.</p></div></div>
      <div className="tabs" role="tablist">
        {PESTANAS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'consultorio' && <DatosConsultorio />}
      {tab === 'usuarios' && <Usuarios />}
      {tab === 'estudios' && <Estudios />}
      {tab === 'horarios' && <Horarios />}
      {tab === 'coberturas' && <div className="grid2" style={{ alignItems: 'start' }}><ListaSimple tipo="obras-sociales" titulo="Obras sociales" campoActivo="activa" /><ListaSimple tipo="recursos" titulo="Equipos y boxes" campoActivo="activo" /></div>}
    </>
  );
}

/* ---------- Consultorio ---------- */
interface DatosC { nombre: string; marca: string; especialidad: string; ciudad: string | null; direccion: string | null; telefono: string | null; whatsapp: string | null; horarios_texto: string | null }

function DatosConsultorio() {
  const { recargarCatalogos } = useSesion();
  const c = useCarga(() => api.get<DatosC>('/admin/consultorio'), []);
  const [ok, setOk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!c.data) return <Alerta error={c.error} />;
  const v = c.data;
  const set = (k: keyof DatosC) => (e: React.ChangeEvent<HTMLInputElement>) => c.setData({ ...v, [k]: e.target.value });
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault(); setOk(null); setError(null);
    try { c.setData(await api.put<DatosC>('/admin/consultorio', v)); setOk('Guardado. La web y las recetas ya muestran los datos nuevos.'); recargarCatalogos(); }
    catch (err: any) { setError(err.message); }
  };
  const campo = (k: keyof DatosC, label: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field"><label htmlFor={`c-${k}`}>{label}</label><input id={`c-${k}`} className="input" value={v[k] ?? ''} onChange={set(k)} {...extra} /></div>
  );
  return (
    <form className="card" onSubmit={guardar} style={{ display: 'grid', gap: 14, maxWidth: 760 }}>
      <div className="form-grid">
        {campo('nombre', 'Nombre (como aparece en la web)', { required: true, placeholder: 'Dra. Camila Ortiz' })}
        {campo('marca', 'Nombre corto (logo)', { required: true })}
        {campo('especialidad', 'Especialidad', { required: true })}
        {campo('ciudad', 'Ciudad')}
      </div>
      {campo('direccion', 'Dirección')}
      <div className="form-grid">
        {campo('telefono', 'Teléfono')}
        {campo('whatsapp', 'WhatsApp para consultas', { placeholder: '381 555 0000' })}
      </div>
      {campo('horarios_texto', 'Horarios (texto para la web)')}
      <Alerta error={error} ok={ok} />
      <div><button className="btn primary">Guardar</button></div>
    </form>
  );
}

/* ---------- Usuarios ---------- */
interface U { id: number; nombre: string; email: string; rol: Rol; activo: boolean; profesional_id: number | null; matricula: string | null; especialidad: string | null; titulo: string | null }
const ROLES: Record<Rol, string> = { admin: 'Administración', medico: 'Profesional', secretaria: 'Secretaría' };

function Usuarios() {
  const { user, recargarCatalogos } = useSesion();
  const l = useCarga(() => api.get<U[]>('/admin/usuarios'), []);
  const [editar, setEditar] = useState<U | 'nuevo' | null>(null);
  const [clave, setClave] = useState<U | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activar = async (u: U) => {
    setError(null);
    try { await api.patch(`/admin/usuarios/${u.id}`, { activo: !u.activo }); l.recargar(); recargarCatalogos(); } catch (e: any) { setError(e.message); }
  };
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="muted">Los profesionales tienen agenda propia. Desactivar un usuario cierra sus sesiones.</p>
        <button className="btn primary sm" onClick={() => setEditar('nuevo')}>Nuevo usuario</button>
      </div>
      <Alerta error={error ?? l.error} />
      <div className="card" style={{ padding: 6 }}>
        <table className="table">
          <thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Datos profesionales</th><th /></tr></thead>
          <tbody>{l.data?.map(u => (
            <tr key={u.id} style={u.activo ? undefined : { opacity: .55 }}>
              <td><b style={{ fontWeight: 600 }}>{u.nombre}</b>{!u.activo && <> <span className="badge">Inactivo</span></>}</td>
              <td className="muted">{u.email}</td>
              <td>{ROLES[u.rol]}</td>
              <td className="muted" style={{ fontSize: 13 }}>{u.rol === 'medico' ? [u.titulo, u.matricula && `M.P. ${u.matricula}`].filter(Boolean).join(' · ') || '—' : ''}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                <button className="btn sm" onClick={() => setEditar(u)}>Editar</button>
                <button className="btn sm" onClick={() => setClave(u)}>Contraseña</button>
                {u.id !== user.id && <button className={`btn sm${u.activo ? ' danger' : ''}`} onClick={() => activar(u)}>{u.activo ? 'Desactivar' : 'Activar'}</button>}
              </div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {editar && <FormUsuario u={editar === 'nuevo' ? null : editar} onClose={() => setEditar(null)} onOk={() => { setEditar(null); l.recargar(); recargarCatalogos(); }} />}
      {clave && <NuevaClave u={clave} onClose={() => setClave(null)} />}
    </>
  );
}

function FormUsuario({ u, onClose, onOk }: { u: U | null; onClose: () => void; onOk: () => void }) {
  const { user } = useSesion();
  const [v, setV] = useState({ nombre: u?.nombre ?? '', email: u?.email ?? '', rol: u?.rol ?? 'secretaria' as Rol, password: '',
    matricula: u?.matricula ?? '', especialidad: u?.especialidad ?? '', titulo: u?.titulo ?? '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV(x => ({ ...x, [k]: e.target.value }));
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    const prof = v.rol === 'medico' ? { matricula: v.matricula || null, titulo: v.titulo || null, ...(v.especialidad ? { especialidad: v.especialidad } : {}) } : {};
    try {
      if (u) await api.patch(`/admin/usuarios/${u.id}`, { nombre: v.nombre, email: v.email, rol: v.rol, ...prof });
      else await api.post('/admin/usuarios', { nombre: v.nombre, email: v.email, rol: v.rol, password: v.password, ...prof });
      onOk();
    } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal titulo={u ? 'Editar usuario' : 'Nuevo usuario'} onClose={onClose}>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="u-n">Nombre</label><input id="u-n" className="input" value={v.nombre} onChange={set('nombre')} required autoFocus /></div>
          <div className="field"><label htmlFor="u-e">Email</label><input id="u-e" className="input" type="email" value={v.email} onChange={set('email')} required /></div>
          <div className="field"><label htmlFor="u-r">Rol</label>
            <select id="u-r" className="input" value={v.rol} onChange={set('rol')} disabled={u?.id === user.id}>
              {(Object.keys(ROLES) as Rol[]).map(r => <option key={r} value={r}>{ROLES[r]}</option>)}
            </select></div>
          {!u && <div className="field"><label htmlFor="u-p">Contraseña inicial</label><input id="u-p" className="input" type="password" autoComplete="new-password" minLength={8} value={v.password} onChange={set('password')} required /></div>}
        </div>
        {v.rol === 'medico' && (
          <div className="form-grid">
            <div className="field"><label htmlFor="u-t">Título (va en las recetas)</label><input id="u-t" className="input" placeholder="Médica oftalmóloga" value={v.titulo} onChange={set('titulo')} /></div>
            <div className="field"><label htmlFor="u-m">Matrícula</label><input id="u-m" className="input" value={v.matricula} onChange={set('matricula')} /></div>
            <div className="field"><label htmlFor="u-es">Especialidad</label><input id="u-es" className="input" value={v.especialidad} onChange={set('especialidad')} /></div>
          </div>
        )}
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}

function NuevaClave({ u, onClose }: { u: U; onClose: () => void }) {
  const [p, setP] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.post(`/admin/usuarios/${u.id}/password`, { password: p }); setOk(true); } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal titulo={`Contraseña de ${u.nombre}`} onClose={onClose}>
      {ok ? <div style={{ display: 'grid', gap: 14 }}><div className="alert ok">Listo. Pasale la contraseña nueva por un medio seguro; sus sesiones abiertas se cerraron.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Cerrar</button></div></div> : (
        <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
          <div className="field"><label htmlFor="np">Contraseña nueva (mínimo 8 caracteres)</label>
            <input id="np" className="input" type="password" autoComplete="new-password" minLength={8} value={p} onChange={e => setP(e.target.value)} required autoFocus /></div>
          <Alerta error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Cambiar</button></div>
        </form>
      )}
    </Modal>
  );
}

/* ---------- Estudios (tipos de turno) ---------- */
interface T { id: number; nombre: string; descripcion: string | null; duracion_min: number; recurso_id: number | null; profesional_id: number | null;
  precio_particular: number | null; color: string | null; activo: boolean; recurso: string | null; profesional: string | null }

function Estudios() {
  const { recargarCatalogos } = useSesion();
  const l = useCarga(() => api.get<T[]>('/admin/tipos'), []);
  const [editar, setEditar] = useState<T | 'nuevo' | null>(null);
  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <p className="muted">La duración y el equipo de cada estudio definen qué horarios se ofrecen online.</p>
        <button className="btn primary sm" onClick={() => setEditar('nuevo')}>Nuevo estudio</button>
      </div>
      <Alerta error={l.error} />
      <div className="card" style={{ padding: 6 }}>
        <table className="table">
          <thead><tr><th>Estudio</th><th className="n">Duración</th><th>Atiende</th><th>Equipo</th><th className="n">Precio particular</th><th /></tr></thead>
          <tbody>{l.data?.map(t => (
            <tr key={t.id} style={t.activo ? undefined : { opacity: .55 }}>
              <td><span className="swatch" style={{ background: t.color ?? 'var(--teal)' }} /><b style={{ fontWeight: 600 }}>{t.nombre}</b>
                {!t.activo && <> <span className="badge">Inactivo</span></>}
                {!t.profesional_id && t.activo && <> <span className="badge warn" title="Sin profesional asignado no se puede reservar online">Sin reserva online</span></>}</td>
              <td className="n">{t.duracion_min} min</td>
              <td>{t.profesional ?? <span className="muted">—</span>}</td>
              <td>{t.recurso ?? <span className="muted">—</span>}</td>
              <td className="n">{t.precio_particular != null ? plata(t.precio_particular) : '—'}</td>
              <td><button className="btn sm" onClick={() => setEditar(t)}>Editar</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {editar && <FormEstudio t={editar === 'nuevo' ? null : editar} onClose={() => setEditar(null)} onOk={() => { setEditar(null); l.recargar(); recargarCatalogos(); }} />}
    </>
  );
}

function FormEstudio({ t, onClose, onOk }: { t: T | null; onClose: () => void; onOk: () => void }) {
  const { cat } = useSesion();
  const recursos = useCarga(() => api.get<{ id: number; nombre: string; activo: boolean }[]>('/admin/recursos'), []);
  const [v, setV] = useState({
    nombre: t?.nombre ?? '', descripcion: t?.descripcion ?? '', duracion_min: String(t?.duracion_min ?? 20),
    profesional_id: t?.profesional_id ?? '' as number | '', recurso_id: t?.recurso_id ?? '' as number | '',
    precio_particular: t?.precio_particular != null ? String(t.precio_particular) : '', color: t?.color ?? '#2563eb', activo: t?.activo ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = {
      nombre: v.nombre, descripcion: v.descripcion || null, duracion_min: Number(v.duracion_min),
      profesional_id: v.profesional_id || null, recurso_id: v.recurso_id || null,
      precio_particular: v.precio_particular === '' ? null : Number(v.precio_particular), color: v.color, activo: v.activo,
    };
    try { t ? await api.patch(`/admin/tipos/${t.id}`, body) : await api.post('/admin/tipos', body); onOk(); }
    catch (err: any) { setError(err.message); }
  };
  return (
    <Modal titulo={t ? `Editar ${t.nombre}` : 'Nuevo estudio'} onClose={onClose}>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid">
          <div className="field"><label htmlFor="t-n">Nombre</label><input id="t-n" className="input" value={v.nombre} onChange={e => setV({ ...v, nombre: e.target.value })} required autoFocus /></div>
          <div className="field"><label htmlFor="t-d">Duración (minutos)</label><input id="t-d" className="input mono" type="number" min={5} max={480} step={5} value={v.duracion_min} onChange={e => setV({ ...v, duracion_min: e.target.value })} required /></div>
          <div className="field"><label htmlFor="t-p">Atiende (reserva online)</label>
            <select id="t-p" className="input" value={v.profesional_id} onChange={e => setV({ ...v, profesional_id: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Nadie: solo desde el consultorio</option>
              {cat.profesionales.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select></div>
          <div className="field"><label htmlFor="t-r">Equipo que usa</label>
            <select id="t-r" className="input" value={v.recurso_id} onChange={e => setV({ ...v, recurso_id: e.target.value ? Number(e.target.value) : '' })}>
              <option value="">Ninguno</option>
              {recursos.data?.filter(r => r.activo || r.id === v.recurso_id).map(r => <option key={r.id} value={r.id}>{r.nombre}</option>)}
            </select></div>
          <div className="field"><label htmlFor="t-$">Precio particular</label><input id="t-$" className="input mono" type="number" min={0} step={100} value={v.precio_particular} onChange={e => setV({ ...v, precio_particular: e.target.value })} /></div>
          <div className="field"><label htmlFor="t-c">Color en la agenda</label><input id="t-c" className="input" type="color" value={v.color} onChange={e => setV({ ...v, color: e.target.value })} style={{ padding: 4 }} /></div>
        </div>
        <div className="field"><label htmlFor="t-ds">Descripción para el paciente</label><textarea id="t-ds" className="input" value={v.descripcion} onChange={e => setV({ ...v, descripcion: e.target.value })} /></div>
        <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={v.activo} onChange={e => setV({ ...v, activo: e.target.checked })} /> Activo (se puede dar y reservar)</label>
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Guardar</button></div>
      </form>
    </Modal>
  );
}

/* ---------- Horarios de atención ---------- */
const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
interface H { id: number; profesional_id: number; dia_semana: number; desde: string; hasta: string }

function Horarios() {
  const { cat, recargarCatalogos } = useSesion();
  const [prof, setProf] = useState(cat.profesionales[0]?.id);
  const l = useCarga(() => api.get<H[]>('/admin/horarios'), []);
  const [dia, setDia] = useState(1);
  const [desde, setDesde] = useState('09:00');
  const [hasta, setHasta] = useState('13:00');
  const [error, setError] = useState<string | null>(null);
  const cambio = () => { l.recargar(); recargarCatalogos(); };
  const agregar = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.post('/admin/horarios', { profesional_id: prof, dia_semana: dia, desde, hasta }); cambio(); } catch (err: any) { setError(err.message); }
  };
  const quitar = async (id: number) => {
    setError(null);
    try { await api.del(`/admin/horarios/${id}`); cambio(); } catch (err: any) { setError(err.message); }
  };
  const delProf = (l.data ?? []).filter(h => h.profesional_id === prof);
  return (
    <div className="grid2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Franjas</h3>
          <select className="input" aria-label="Profesional" value={prof} onChange={e => setProf(Number(e.target.value))} style={{ width: 220, height: 30 }}>
            {cat.profesionales.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </div>
        <table className="table"><tbody>
          {[1, 2, 3, 4, 5, 6, 0].map(d => {
            const fr = delProf.filter(h => h.dia_semana === d);
            return (
              <tr key={d}><td style={{ width: 110 }}>{DIAS[d]}</td>
                <td>{fr.length ? <div className="row" style={{ gap: 6 }}>{fr.map(h => (
                  <span key={h.id} className="chip" style={{ paddingRight: 4 }}>{h.desde} a {h.hasta}
                    <button className="btn ghost sm" style={{ height: 20, padding: '0 4px' }} aria-label={`Quitar ${DIAS[d]} ${h.desde} a ${h.hasta}`} onClick={() => quitar(h.id)}>✕</button></span>
                ))}</div> : <span className="muted">No atiende</span>}</td></tr>
            );
          })}
        </tbody></table>
      </div>
      <form className="card" onSubmit={agregar} style={{ display: 'grid', gap: 12 }}>
        <h3>Agregar franja</h3>
        <div className="form-grid">
          <div className="field"><label htmlFor="h-d">Día</label><select id="h-d" className="input" value={dia} onChange={e => setDia(Number(e.target.value))}>{[1, 2, 3, 4, 5, 6, 0].map(d => <option key={d} value={d}>{DIAS[d]}</option>)}</select></div>
          <div className="field"><label htmlFor="h-de">Desde</label><input id="h-de" className="input" type="time" step={600} value={desde} onChange={e => setDesde(e.target.value)} required /></div>
          <div className="field"><label htmlFor="h-ha">Hasta</label><input id="h-ha" className="input" type="time" step={600} value={hasta} onChange={e => setHasta(e.target.value)} required /></div>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Quitar una franja no cancela los turnos ya dados en ese horario.</p>
        <Alerta error={error ?? l.error} />
        <div><button className="btn primary">Agregar</button></div>
      </form>
    </div>
  );
}

/* ---------- Obras sociales y equipos ---------- */
function ListaSimple({ tipo, titulo, campoActivo }: { tipo: 'obras-sociales' | 'recursos'; titulo: string; campoActivo: 'activa' | 'activo' }) {
  const { recargarCatalogos } = useSesion();
  const l = useCarga(() => api.get<({ id: number; nombre: string; pacientes?: number } & Record<string, any>)[]>(`/admin/${tipo}`), [tipo]);
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cambio = () => { l.recargar(); recargarCatalogos(); };
  const agregar = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.post(`/admin/${tipo}`, { nombre }); setNombre(''); cambio(); } catch (err: any) { setError(err.message); }
  };
  const alternar = async (id: number, activo: boolean) => {
    setError(null);
    try { await api.patch(`/admin/${tipo}/${id}`, { [campoActivo]: !activo }); cambio(); } catch (err: any) { setError(err.message); }
  };
  return (
    <div className="card">
      <h3>{titulo}</h3>
      <form className="row" onSubmit={agregar} style={{ marginBottom: 10 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Nombre" aria-label={`Nueva ${titulo.toLowerCase()}`} value={nombre} onChange={e => setNombre(e.target.value)} required minLength={2} />
        <button className="btn sm primary">Agregar</button>
      </form>
      <Alerta error={error ?? l.error} />
      <table className="table"><tbody>{l.data?.map(x => (
        <tr key={x.id} style={x[campoActivo] ? undefined : { opacity: .55 }}>
          <td>{x.nombre}{x.pacientes != null && <span className="muted" style={{ fontSize: 12.5 }}> · {x.pacientes} pacientes</span>}</td>
          <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => alternar(x.id, x[campoActivo])}>{x[campoActivo] ? 'Desactivar' : 'Activar'}</button></td>
        </tr>
      ))}</tbody></table>
    </div>
  );
}
