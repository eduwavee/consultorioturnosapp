import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, type Catalogos, type Rol, type Usuario } from './api';
import { Agenda } from './pages/Agenda';
import { Auditoria } from './pages/Auditoria';
import { Alerta, Modal } from './components/ui';
import { Caja } from './pages/Caja';
import { Configuracion } from './pages/Configuracion';
import { ConsultaPage } from './pages/Consulta';
import { ListaEspera } from './pages/ListaEspera';
import { Login } from './pages/Login';
import { PacientePage } from './pages/Paciente';
import { Pacientes } from './pages/Pacientes';
import { Reportes } from './pages/Reportes';

/* ---------- Ruteo mínimo por hash: #/agenda, #/pacientes/12, #/consulta/nueva?paciente=3 ---------- */
export function useRuta() {
  const [hash, setHash] = useState(() => location.hash.slice(1) || '/agenda');
  useEffect(() => {
    const f = () => setHash(location.hash.slice(1) || '/agenda');
    addEventListener('hashchange', f); return () => removeEventListener('hashchange', f);
  }, []);
  const [path, qs = ''] = hash.split('?');
  return { partes: path.split('/').filter(Boolean), params: new URLSearchParams(qs) };
}
export const ir = (r: string) => { location.hash = r; };

/* ---------- Sesión y catálogos compartidos ---------- */
interface Ctx { user: Usuario; cat: Catalogos; puede: (...r: Rol[]) => boolean; recargarCatalogos: () => void }
const SesionCtx = createContext<Ctx>(null!);
export const useSesion = () => useContext(SesionCtx);

const NAV: { ruta: string; label: string; roles: Rol[] }[] = [
  { ruta: 'agenda', label: 'Agenda', roles: ['admin', 'medico', 'secretaria'] },
  { ruta: 'pacientes', label: 'Pacientes', roles: ['admin', 'medico', 'secretaria'] },
  { ruta: 'espera', label: 'Lista de espera', roles: ['admin', 'medico', 'secretaria'] },
  { ruta: 'caja', label: 'Caja', roles: ['admin', 'secretaria'] },
  { ruta: 'reportes', label: 'Reportes', roles: ['admin'] },
  { ruta: 'auditoria', label: 'Auditoría', roles: ['admin'] },
  { ruta: 'configuracion', label: 'Configuración', roles: ['admin'] },
];
const ROL_LABEL: Record<Rol, string> = { admin: 'Administración', medico: 'Profesional', secretaria: 'Secretaría' };

export function App() {
  const [user, setUser] = useState<Usuario | null | undefined>(undefined);
  const [cat, setCat] = useState<Catalogos | null>(null);
  const { partes } = useRuta();

  const cargar = useCallback(async () => {
    try {
      const u = await api.get<Usuario>('/auth/yo');
      setCat(await api.get<Catalogos>('/catalogos'));
      setUser(u);
    } catch { setUser(null); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);
  const recargarCatalogos = useCallback(() => { api.get<Catalogos>('/catalogos').then(setCat).catch(() => {}); }, []);
  const [cuenta, setCuenta] = useState(false);

  if (user === undefined) return null;
  if (!user || !cat) return <Login onLogin={cargar} />;

  const puede = (...r: Rol[]) => r.includes(user.rol);
  const salir = async () => { await api.post('/auth/logout'); setUser(null); };
  const seccion = partes[0] ?? 'agenda';

  let pagina;
  if (seccion === 'pacientes' && partes[1]) pagina = <PacientePage id={Number(partes[1])} />;
  else if (seccion === 'pacientes') pagina = <Pacientes />;
  else if (seccion === 'consulta' && puede('medico')) pagina = <ConsultaPage id={partes[1]} />;
  else if (seccion === 'espera') pagina = <ListaEspera />;
  else if (seccion === 'caja' && puede('admin', 'secretaria')) pagina = <Caja />;
  else if (seccion === 'reportes' && puede('admin')) pagina = <Reportes />;
  else if (seccion === 'auditoria' && puede('admin')) pagina = <Auditoria />;
  else if (seccion === 'configuracion' && puede('admin')) pagina = <Configuracion />;
  else pagina = <Agenda />;

  return (
    <SesionCtx.Provider value={{ user, cat, puede, recargarCatalogos }}>
      <div className="shell">
        <aside className="side">
          <div className="brand"><b>{cat.consultorio?.marca ?? 'Consultorio'}</b><span>Panel del consultorio</span></div>
          <nav aria-label="Secciones">
            {NAV.filter(n => n.roles.includes(user.rol)).map(n => (
              <button key={n.ruta} aria-current={seccion === n.ruta || (n.ruta === 'pacientes' && seccion === 'consulta') ? 'page' : undefined}
                onClick={() => ir(`/${n.ruta}`)}>{n.label}</button>
            ))}
          </nav>
          <div className="me">
            <b>{user.nombre}</b>
            <span className="muted">{ROL_LABEL[user.rol]}</span>
            <div className="cuenta">
              <button className="btn ghost sm" onClick={() => setCuenta(true)}>Mi contraseña</button>
              <button className="btn ghost sm" onClick={salir}>Cerrar sesión</button>
            </div>
          </div>
        </aside>
        <main className="main">{pagina}</main>
      </div>
      {cuenta && <CambiarPassword onClose={() => setCuenta(false)} />}
    </SesionCtx.Provider>
  );
}

function CambiarPassword({ onClose }: { onClose: () => void }) {
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [repetir, setRepetir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const guardar = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    if (nueva !== repetir) { setError('Las contraseñas nuevas no coinciden'); return; }
    try { await api.post('/auth/password', { actual, nueva }); setOk(true); } catch (err: any) { setError(err.message); }
  };
  return (
    <Modal titulo="Cambiar mi contraseña" onClose={onClose}>
      {ok ? <div style={{ display: 'grid', gap: 14 }}><div className="alert ok">Listo. Se cerraron tus sesiones en otros dispositivos.</div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Cerrar</button></div></div> : (
        <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
          <div className="field"><label htmlFor="pa">Contraseña actual</label><input id="pa" className="input" type="password" autoComplete="current-password" value={actual} onChange={e => setActual(e.target.value)} required autoFocus /></div>
          <div className="field"><label htmlFor="pn">Nueva (mínimo 8 caracteres)</label><input id="pn" className="input" type="password" autoComplete="new-password" minLength={8} value={nueva} onChange={e => setNueva(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pr">Repetir la nueva</label><input id="pr" className="input" type="password" autoComplete="new-password" minLength={8} value={repetir} onChange={e => setRepetir(e.target.value)} required /></div>
          <Alerta error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Cambiar</button></div>
        </form>
      )}
    </Modal>
  );
}
