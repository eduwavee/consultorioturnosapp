import { useEffect, useState } from 'react';
import { api } from '../api';
import { Alerta } from '../components/ui';

const DEMO = [
  { email: 'secretaria@demo.com', rol: 'Secretaría' },
  { email: 'dra@demo.com', rol: 'Médica' },
  { email: 'admin@demo.com', rol: 'Administración' },
];

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);
  // Los accesos de demo solo se muestran si el servidor los cargó
  const [demo, setDemo] = useState(false);
  useEffect(() => { api.get<{ demo?: boolean }>('/salud').then(r => setDemo(!!r.demo)).catch(() => {}); }, []);

  const entrar = async (e?: React.FormEvent, cred?: { email: string; password: string }) => {
    e?.preventDefault();
    setCargando(true); setError(null);
    try { await api.post('/auth/login', cred ?? { email, password }); onLogin(); }
    catch (err: any) { setError(err.message); }
    finally { setCargando(false); }
  };

  return (
    <div className="login">
      <div className="art">
        <span style={{ fontSize: 13, letterSpacing: '.06em', textTransform: 'uppercase' }}>Panel del consultorio</span>
        <h1>La agenda, las historias y la caja, <em>en un solo lugar</em>.</h1>
        {demo && <span style={{ fontSize: 13, opacity: .8 }}>Datos ficticios de demostración</span>}
      </div>
      <form onSubmit={entrar}>
        <h2>Ingresar</h2>
        <div className="field"><label htmlFor="em">Email</label><input id="em" className="input" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="pw">Contraseña</label><input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></div>
        <Alerta error={error} />
        <button className="btn primary" disabled={cargando}>{cargando ? 'Ingresando…' : 'Ingresar'}</button>
        {demo && <div className="demo">
          <p className="muted" style={{ fontSize: 13 }}>Usuarios de demo (contraseña demo1234):</p>
          {DEMO.map(d => (
            <button type="button" key={d.email} onClick={() => entrar(undefined, { email: d.email, password: 'demo1234' })}>
              {d.rol}<span>{d.email}</span>
            </button>
          ))}
        </div>}
      </form>
    </div>
  );
}
