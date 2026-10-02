import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Paciente } from '../api';

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEsc(onClose);
  return <><div className="scrim" onClick={onClose} /><div className="drawer" role="dialog" aria-modal="true">{children}</div></>;
}

export function Modal({ onClose, children, titulo }: { onClose: () => void; children: ReactNode; titulo: string }) {
  useEsc(onClose);
  return <>
    <div className="scrim" onClick={onClose} />
    <div className="modal" role="dialog" aria-modal="true" aria-label={titulo}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h2>{titulo}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Cerrar">✕</button>
      </div>
      {children}
    </div>
  </>;
}

function useEsc(fn: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') fn(); };
    addEventListener('keydown', h); return () => removeEventListener('keydown', h);
  }, [fn]);
}

export const Alerta = ({ error, ok }: { error?: string | null; ok?: string | null }) =>
  error ? <div className="alert error" role="alert">{error}</div> : ok ? <div className="alert ok" role="status">{ok}</div> : null;

/** Hook para cargar datos con estado de carga y error. */
export function useCarga<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let vivo = true;
    setError(null);
    fn().then(d => { if (vivo) setData(d); }).catch(e => { if (vivo) setError(e.message); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const recargar = useCallback(() => setN(x => x + 1), []);
  return { data, error, recargar, setData };
}

/** Buscador de pacientes por nombre o DNI con resultados en vivo. */
export function BuscarPaciente({ onElegir, autoFocus, inicial }: { onElegir: (p: Paciente) => void; autoFocus?: boolean; inicial?: Paciente | null }) {
  const [texto, setTexto] = useState('');
  const [res, setRes] = useState<Paciente[]>([]);
  const t = useRef<number>(0);
  // Nombre del paciente elegido: mientras el texto sea ese, no se vuelve a buscar
  const elegido = useRef('');
  useEffect(() => {
    if (inicial) { elegido.current = `${inicial.nombre} ${inicial.apellido}`; setTexto(elegido.current); }
  }, [inicial]);
  useEffect(() => {
    clearTimeout(t.current);
    if (texto === elegido.current) { setRes([]); return; }
    if (texto.trim().length < 2) { setRes([]); return; }
    t.current = window.setTimeout(() => api.get<Paciente[]>(`/pacientes?q=${encodeURIComponent(texto)}`).then(setRes).catch(() => {}), 220);
  }, [texto]);
  return (
    <div className="field" style={{ position: 'relative' }}>
      <label htmlFor="bp">Paciente</label>
      <input id="bp" className="input" placeholder="Nombre, apellido o DNI" value={texto} autoFocus={autoFocus}
        onChange={e => setTexto(e.target.value)} autoComplete="off" />
      {res.length > 0 && (
        <div className="card" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, padding: 6, marginTop: 4 }}>
          {res.slice(0, 6).map(p => (
            <button key={p.id} type="button" className="btn ghost" style={{ width: '100%', justifyContent: 'space-between' }}
              onClick={() => { onElegir(p); elegido.current = `${p.nombre} ${p.apellido}`; setTexto(elegido.current); setRes([]); }}>
              <span>{p.apellido}, {p.nombre}</span><span className="muted mono">{p.dni}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
