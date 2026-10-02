import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { api, diaDe, diaSemana, ESTADO_LABEL, fecha, hora, hoyISO, minutosDelDia, pad2, plata, sumarDias, TRANSICIONES, type Bloqueo, type EstadoTurno, type Paciente, type Turno } from '../api';
import { ir, useSesion } from '../App';
import { Alerta, BuscarPaciente, Drawer, Modal, useCarga } from '../components/ui';

const DESDE = 8 * 60 + 30, HASTA = 20 * 60 + 30, PPM = 2.1, PASO = 10;
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const aHHMM = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
/** Lunes de la semana de ese día. */
const lunesDe = (dia: string) => sumarDias(dia, -((diaSemana(dia) + 6) % 7));

type Vista = 'dia' | 'semana';
/** Una columna de la grilla: un profesional en un día. */
interface Columna { key: string; titulo: string; sub: string; dia: string; prof: number; hoy: boolean }

const leerVista = (): Vista => { try { return localStorage.getItem('agenda.vista') === 'semana' ? 'semana' : 'dia'; } catch { return 'dia'; } };
const guardarVista = (v: Vista) => { try { localStorage.setItem('agenda.vista', v); } catch { /* sin storage */ } };

/** Solo se arrastran turnos con paciente que todavía se pueden mover. */
const movible = (t: Turno) => !!t.paciente_id && (t.estado === 'reservado' || t.estado === 'confirmado');

export function Agenda() {
  const { cat, puede, user } = useSesion();
  const [dia, setDia] = useState(hoyISO());
  const [vista, setVistaState] = useState<Vista>(leerVista);
  const [profSemana, setProfSemana] = useState<number>(() => user.profesional_id ?? cat.profesionales[0]?.id);
  const setVista = (v: Vista) => { setVistaState(v); guardarVista(v); };

  const lunes = lunesDe(dia);
  const url = vista === 'dia' ? `/turnos?dia=${dia}` : `/turnos?dia=${lunes}&dias=7&profesional=${profSemana}`;
  const { data, error, recargar } = useCarga(() => api.get<{ turnos: Turno[]; bloqueos: Bloqueo[] }>(url), [url]);
  const [sel, setSel] = useState<Turno | null>(null);
  const [nuevo, setNuevo] = useState(false);
  const [bloqueo, setBloqueo] = useState(false);
  const [ahora, setAhora] = useState(() => minutosDelDia(new Date().toISOString()));
  const [mover, setMover] = useState<{ t: Turno; dia: string; hora: string } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [destino, setDestino] = useState<{ col: string; min: number } | null>(null);

  // Refresco periódico: las reservas online aparecen solas
  useEffect(() => {
    const t = setInterval(() => { recargar(); setAhora(minutosDelDia(new Date().toISOString())); }, 30_000);
    return () => clearInterval(t);
  }, [recargar]);

  const hoy = hoyISO();
  const columnas: Columna[] = useMemo(() => {
    if (vista === 'dia') {
      return cat.profesionales.map(p => ({
        key: String(p.id), titulo: p.nombre, sub: p.titulo ?? p.especialidad, dia, prof: p.id, hoy: dia === hoy,
      }));
    }
    // Semana: de lunes a sábado, y el domingo solo si ese profesional atiende
    const atiendeDomingo = cat.horarios.some(h => h.profesional_id === profSemana && h.dia_semana === 0);
    return Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i))
      .filter(d => diaSemana(d) !== 0 || atiendeDomingo)
      .map(d => ({
        key: d, titulo: fecha(d, { weekday: 'short', day: 'numeric' }), sub: fecha(d, { month: 'long' }),
        dia: d, prof: profSemana, hoy: d === hoy,
      }));
  }, [vista, cat, dia, lunes, profSemana, hoy]);

  const turnos = data?.turnos ?? [];
  const activos = turnos.filter(t => t.estado !== 'cancelado');
  const resumen = useMemo(() => {
    const r: Partial<Record<EstadoTurno, number>> = {};
    for (const t of turnos) r[t.estado] = (r[t.estado] ?? 0) + 1;
    return r;
  }, [turnos]);

  const paso = vista === 'dia' ? 1 : 7;
  const tituloFecha = vista === 'dia'
    ? fecha(dia, { weekday: 'long', day: 'numeric', month: 'long' })
    : `Semana del ${fecha(lunes, { day: 'numeric', month: 'long' })}`;

  /* ---------- Arrastrar y soltar para reprogramar ---------- */
  const minutoEn = (e: DragEvent<HTMLDivElement>, offset: number) => {
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    const m = Math.round((DESDE + y / PPM - offset) / PASO) * PASO;
    return Math.max(DESDE, Math.min(HASTA - PASO, m));
  };
  const leerArrastre = (e: DragEvent) => {
    try { return JSON.parse(e.dataTransfer.getData('application/x-turno')) as { id: number; offset: number }; } catch { return null; }
  };
  const alSoltar = (e: DragEvent<HTMLDivElement>, col: Columna) => {
    e.preventDefault();
    setDestino(null);
    const d = leerArrastre(e);
    const t = d && turnos.find(x => x.id === d.id);
    if (!d || !t) return;
    if (t.profesional_id !== col.prof) { setAviso('Para cambiar de profesional, cancelá el turno y dá uno nuevo.'); return; }
    const h = aHHMM(minutoEn(e, d.offset));
    if (col.dia === diaDe(t.inicio) && h === hora(t.inicio)) return;
    setMover({ t, dia: col.dia, hora: h });
  };
  const arrastrando = (e: DragEvent<HTMLDivElement>, col: Columna) => {
    if (!e.dataTransfer.types.includes('application/x-turno')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Durante el arrastre no se puede leer el dato: la línea guía usa el borde superior del puntero
    const m = minutoEn(e, 0);
    if (destino?.col !== col.key || destino.min !== m) setDestino({ col: col.key, min: m });
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Agenda</h1>
          <p className="muted">{tituloFecha} · {activos.length} turnos</p>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Vista">
            <button aria-pressed={vista === 'dia'} onClick={() => setVista('dia')}>Día</button>
            <button aria-pressed={vista === 'semana'} onClick={() => setVista('semana')}>Semana</button>
          </div>
          {vista === 'semana' && (
            <select className="input" aria-label="Profesional" value={profSemana} onChange={e => setProfSemana(Number(e.target.value))} style={{ width: 190, height: 30 }}>
              {cat.profesionales.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
          )}
          <button className="btn sm" onClick={() => setDia(sumarDias(dia, -paso))} aria-label={vista === 'dia' ? 'Día anterior' : 'Semana anterior'}>←</button>
          <button className="btn sm" onClick={() => setDia(hoyISO())}>Hoy</button>
          <button className="btn sm" onClick={() => setDia(sumarDias(dia, paso))} aria-label={vista === 'dia' ? 'Día siguiente' : 'Semana siguiente'}>→</button>
          <input className="input" type="date" aria-label="Ir a fecha" value={dia} onChange={e => e.target.value && setDia(e.target.value)} style={{ width: 160, height: 30 }} />
          {puede('admin', 'medico') && <button className="btn sm" onClick={() => setBloqueo(true)}>Bloquear horario</button>}
          <button className="btn primary sm" onClick={() => setNuevo(true)}>Nuevo turno</button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 14 }}>
        {(Object.keys(ESTADO_LABEL) as EstadoTurno[]).filter(e => resumen[e]).map(e => (
          <span key={e} className={`chip ${e}`}>{ESTADO_LABEL[e]} · {resumen[e]}</span>
        ))}
        <span className="muted" style={{ fontSize: 12.5, marginLeft: 'auto' }}>Arrastrá un turno para cambiarlo de horario</span>
      </div>
      <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}><Alerta error={error ?? aviso} /></div>

      <div className="agenda" style={{ ['--cols' as any]: columnas.length, ['--mins' as any]: HASTA - DESDE, ['--ppm' as any]: `${PPM}px` }}>
        <div className="corner" />
        {columnas.map(c => <div key={c.key} className={`colhead${c.hoy && vista === 'semana' ? ' hoy' : ''}`}>{c.titulo}<small>{c.sub}</small></div>)}
        <div className="hours">
          {Array.from({ length: 12 }, (_, i) => 9 + i).map(h => <span key={h} style={{ top: (h * 60 - DESDE) * PPM }}>{h}:00</span>)}
        </div>
        {columnas.map(c => {
          const dow = diaSemana(c.dia);
          const franjas = cat.horarios.filter(h => h.profesional_id === c.prof && h.dia_semana === dow).map(h => [toMin(h.desde), toMin(h.hasta)]);
          const cerrados: [number, number][] = [];
          let cursor = DESDE;
          for (const [a, b] of franjas) { if (a > cursor) cerrados.push([cursor, a]); cursor = Math.max(cursor, b); }
          if (cursor < HASTA) cerrados.push([cursor, HASTA]);
          const delDia = activos.filter(t => t.profesional_id === c.prof && diaDe(t.inicio) === c.dia);
          // Un bloqueo puede durar varios días: en cada columna se dibuja la parte de ese día
          const bloqueos = (data?.bloqueos ?? []).filter(b => b.profesional_id === c.prof && diaDe(b.inicio) <= c.dia && diaDe(b.fin) >= c.dia);
          return (
            <div key={c.key} className={`col${destino?.col === c.key ? ' drop' : ''}`}
              onDragOver={e => arrastrando(e, c)} onDragLeave={() => setDestino(null)} onDrop={e => alSoltar(e, c)}>
              {cerrados.map(([a, b]) => <div key={a} className="closed" style={{ top: (a - DESDE) * PPM, height: (b - a) * PPM }} />)}
              {bloqueos.map(b => {
                const a = diaDe(b.inicio) === c.dia ? Math.max(minutosDelDia(b.inicio), DESDE) : DESDE;
                const z = diaDe(b.fin) === c.dia ? Math.min(minutosDelDia(b.fin), HASTA) : HASTA;
                return z > a ? <div key={b.id} className="bloqueo" style={{ top: (a - DESDE) * PPM, height: (z - a) * PPM }}>{b.motivo}</div> : null;
              })}
              {c.hoy && ahora > DESDE && ahora < HASTA && <div className="now" style={{ top: (ahora - DESDE) * PPM }} />}
              {destino?.col === c.key && <div className="slot-fantasma" style={{ top: (destino.min - DESDE) * PPM }} />}
              {delDia.map(t => {
                const a = minutosDelDia(t.inicio), z = minutosDelDia(t.fin);
                return (
                  <button key={t.id} className={`tb ${t.estado}${t.sobreturno ? ' sobre' : ''}${t.cobrado ? ' cobrado' : ''}`} onClick={() => setSel(t)}
                    draggable={movible(t)}
                    onDragStart={e => {
                      const offset = (e.clientY - e.currentTarget.getBoundingClientRect().top) / PPM;
                      e.dataTransfer.setData('application/x-turno', JSON.stringify({ id: t.id, offset }));
                      e.dataTransfer.effectAllowed = 'move';
                      setAviso(null);
                    }}
                    onDragEnd={() => setDestino(null)}
                    title={t.cobrado ? 'Cobrado' : undefined}
                    style={{ top: (a - DESDE) * PPM + 1, height: Math.max((z - a) * PPM - 2, 18), ['--c' as any]: t.color ?? undefined }}>
                    <span className="t">{hora(t.inicio)}</span> <b>{t.paciente ?? 'Retenido online'}</b>
                    {(z - a) >= 20 && <><br /><span className="t">{t.tipo}{t.origen === 'web' ? ' · web' : ''}</span></>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {sel && <DetalleTurno t={sel} onClose={() => setSel(null)} onCambio={() => { setSel(null); recargar(); }} />}
      {nuevo && <NuevoTurno dia={dia} onClose={() => setNuevo(false)} onOk={() => { setNuevo(false); recargar(); }} />}
      {bloqueo && <NuevoBloqueo dia={dia} onClose={() => setBloqueo(false)} onOk={recargar} />}
      {mover && <ConfirmarMovida {...mover} onClose={() => setMover(null)} onOk={() => { setMover(null); recargar(); }} />}
    </>
  );
}

/** Confirmación antes de mover un turno arrastrado (evita movidas accidentales). */
function ConfirmarMovida({ t, dia, hora: nueva, onClose, onOk }: { t: Turno; dia: string; hora: string; onClose: () => void; onOk: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const confirmar = async () => {
    setEnviando(true); setError(null);
    try { await api.patch(`/turnos/${t.id}/horario`, { inicio: `${dia}T${nueva}:00-03:00` }); onOk(); }
    catch (e: any) { setError(e.message); setEnviando(false); }
  };
  return (
    <Modal titulo="Mover turno" onClose={onClose}>
      <div style={{ display: 'grid', gap: 14 }}>
        <p><b>{t.paciente}</b> · {t.tipo}</p>
        <div className="kv" style={{ margin: 0 }}>
          <span>Antes</span><span style={{ color: 'inherit' }}>{fecha(t.inicio, { weekday: 'long', day: 'numeric', month: 'long' })} · {hora(t.inicio)}</span>
          <span>Ahora</span><b>{fecha(dia, { weekday: 'long', day: 'numeric', month: 'long' })} · {nueva}</b>
        </div>
        {t.estado === 'confirmado' && <p className="muted" style={{ fontSize: 13 }}>El turno vuelve a quedar "reservado" y se le programa un recordatorio nuevo al paciente.</p>}
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" onClick={confirmar} disabled={enviando}>Mover turno</button>
        </div>
      </div>
    </Modal>
  );
}

const ACCION: Partial<Record<EstadoTurno, string>> = {
  confirmado: 'Confirmar', en_sala: 'Pasar a sala', atendido: 'Marcar atendido', ausente: 'Ausente', cancelado: 'Cancelar turno',
};

function DetalleTurno({ t, onClose, onCambio }: { t: Turno; onClose: () => void; onCambio: () => void }) {
  const { puede } = useSesion();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [mover, setMover] = useState(false);
  const [nf, setNf] = useState(() => diaDe(t.inicio));
  const [nh, setNh] = useState(() => hora(t.inicio));
  const cambiar = async (estado: EstadoTurno) => {
    try { await api.patch(`/turnos/${t.id}/estado`, { estado }); onCambio(); }
    catch (e: any) { setError(e.message); }
  };
  const reprogramar = async (e: React.FormEvent) => {
    e.preventDefault();
    try { await api.patch(`/turnos/${t.id}/horario`, { inicio: `${nf}T${nh}:00-03:00` }); onCambio(); }
    catch (err: any) { setError(err.message); }
  };
  /** Quiere venir antes: queda en la lista y se le avisa si se libera un horario. */
  const aListaEspera = async () => {
    setError(null); setOk(null);
    try {
      await api.post('/lista-espera', { paciente_id: t.paciente_id, tipo_turno_id: t.tipo_turno_id, hasta: diaDe(t.inicio), notas: 'Quiere adelantar el turno' });
      setOk('Quedó en la lista de espera. Si se libera un horario antes, le avisamos por WhatsApp.');
    } catch (e: any) { setError(e.message); }
  };
  return (
    <Drawer onClose={onClose}>
      <div className="row">
        <span className={`chip ${t.estado}`}>{ESTADO_LABEL[t.estado]}</span>
        {t.cobrado && <span className="badge ok">Cobrado</span>}
      </div>
      <h2 style={{ marginTop: 12 }}>{t.paciente ?? 'Retención online en curso'}</h2>
      <div className="kv">
        <span>Horario</span><b className="mono">{fecha(t.inicio, { weekday: 'short', day: 'numeric', month: 'short' })} · {hora(t.inicio)} – {hora(t.fin)}</b>
        <span>Estudio</span><span style={{ color: 'inherit' }}>{t.tipo}{t.recurso ? ` · ${t.recurso}` : ''}</span>
        <span>Atiende</span><span style={{ color: 'inherit' }}>{t.profesional}</span>
        {t.dni && <><span>DNI</span><span className="mono" style={{ color: 'inherit' }}>{t.dni}</span></>}
        {t.telefono && <><span>WhatsApp</span><span className="mono" style={{ color: 'inherit' }}>{t.telefono}</span></>}
        {t.precio != null && <><span>Precio</span><span className="mono" style={{ color: 'inherit' }}>{plata(t.precio)} (particular)</span></>}
        <span>Origen</span><span style={{ color: 'inherit' }}>{t.origen === 'web' ? 'Reserva online' : 'Consultorio'}{t.sobreturno ? ' · sobreturno' : ''}</span>
      </div>
      <Alerta error={error} ok={ok} />
      <div className="row" style={{ marginTop: 12 }}>
        {TRANSICIONES[t.estado].map(e => (
          <button key={e} className={`btn sm${e === 'cancelado' || e === 'ausente' ? ' danger' : e === 'confirmado' || e === 'en_sala' ? ' primary' : ''}`} onClick={() => cambiar(e)}>{ACCION[e]}</button>
        ))}
        {movible(t) && !mover && <button className="btn sm" onClick={() => setMover(true)}>Reprogramar</button>}
      </div>
      {mover && (
        <form className="row" style={{ marginTop: 12 }} onSubmit={reprogramar}>
          <input className="input" type="date" aria-label="Nuevo día" value={nf} onChange={e => setNf(e.target.value)} required style={{ width: 160, height: 30 }} />
          <input className="input" type="time" aria-label="Nueva hora" step={600} value={nh} onChange={e => setNh(e.target.value)} required style={{ width: 140, height: 30 }} />
          <button className="btn primary sm">Mover turno</button>
          <button type="button" className="btn sm" onClick={() => setMover(false)}>Cancelar</button>
        </form>
      )}
      {t.paciente_id && (
        <div className="row" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }}>
          <button className="btn sm" onClick={() => ir(`/pacientes/${t.paciente_id}`)}>Ver paciente</button>
          {puede('medico') && ['en_sala', 'confirmado', 'reservado'].includes(t.estado) &&
            <button className="btn primary sm" onClick={() => ir(`/consulta/nueva?paciente=${t.paciente_id}&turno=${t.id}`)}>Iniciar consulta</button>}
          {puede('admin', 'secretaria') && !t.cobrado && <button className="btn sm" onClick={() => ir(`/caja?paciente=${t.paciente_id}&turno=${t.id}`)}>Cobrar</button>}
          {movible(t) && <button className="btn sm" onClick={aListaEspera}>Quiere venir antes</button>}
        </div>
      )}
    </Drawer>
  );
}

function NuevoTurno({ dia, onClose, onOk }: { dia: string; onClose: () => void; onOk: () => void }) {
  const { cat, puede } = useSesion();
  const [pac, setPac] = useState<Paciente | null>(null);
  const [tipo, setTipo] = useState(cat.tipos[0]?.id ?? 1);
  const tipoSel = cat.tipos.find(t => t.id === tipo);
  const [prof, setProf] = useState<number | ''>('');
  const [f, setF] = useState(dia);
  const [h, setH] = useState('09:00');
  const [sobre, setSobre] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pac) { setError('Elegí un paciente'); return; }
    try {
      await api.post('/turnos', { paciente_id: pac.id, tipo_turno_id: tipo, profesional_id: prof || undefined, inicio: `${f}T${h}:00-03:00`, sobreturno: sobre });
      onOk();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <Modal titulo="Nuevo turno" onClose={onClose}>
      <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
        <BuscarPaciente onElegir={setPac} autoFocus />
        <p className="muted" style={{ fontSize: 13, marginTop: -6 }}>¿Es nuevo? <a href="#/pacientes?nuevo=1">Cargalo en Pacientes</a>.</p>
        <div className="form-grid">
          <div className="field"><label htmlFor="nt-tipo">Estudio</label>
            <select id="nt-tipo" className="input" value={tipo} onChange={e => setTipo(Number(e.target.value))}>
              {cat.tipos.map(t => <option key={t.id} value={t.id}>{t.nombre} · {t.duracion_min} min</option>)}
            </select></div>
          <div className="field"><label htmlFor="nt-prof">Atiende</label>
            <select id="nt-prof" className="input" value={prof} onChange={e => setProf(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{cat.profesionales.find(p => p.id === tipoSel?.profesional_id)?.nombre ?? 'Por defecto'}</option>
              {cat.profesionales.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select></div>
          <div className="field"><label htmlFor="nt-f">Día</label><input id="nt-f" className="input" type="date" value={f} onChange={e => setF(e.target.value)} required /></div>
          <div className="field"><label htmlFor="nt-h">Hora</label><input id="nt-h" className="input" type="time" step={600} value={h} onChange={e => setH(e.target.value)} required /></div>
        </div>
        {puede('medico', 'admin') && <label className="row" style={{ fontSize: 14 }}><input type="checkbox" checked={sobre} onChange={e => setSobre(e.target.checked)} /> Sobreturno (se superpone a propósito)</label>}
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary">Guardar turno</button>
        </div>
      </form>
    </Modal>
  );
}

function NuevoBloqueo({ dia, onClose, onOk }: { dia: string; onClose: () => void; onOk: () => void }) {
  const { cat, user } = useSesion();
  const [prof, setProf] = useState(user.profesional_id ?? cat.profesionales[0]?.id);
  const [desde, setDesde] = useState('16:00');
  const [hasta, setHasta] = useState('20:00');
  const [motivo, setMotivo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [afectados, setAfectados] = useState<{ id: number; inicio: string; paciente: string | null; telefono: string | null }[] | null>(null);

  const guardar = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api.post<{ turnos_afectados: typeof afectados }>('/bloqueos', { profesional_id: prof, inicio: `${dia}T${desde}:00-03:00`, fin: `${dia}T${hasta}:00-03:00`, motivo });
      setAfectados(r.turnos_afectados ?? []); onOk();
    } catch (err: any) { setError(err.message); }
  };

  return (
    <Modal titulo={`Bloquear horario · ${fecha(dia, { day: 'numeric', month: 'long' })}`} onClose={onClose}>
      {afectados ? (
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="alert ok">Horario bloqueado. Ya nadie puede reservar en esa franja.</div>
          {afectados.length > 0 ? <>
            <p>Estos turnos ya estaban dados y hay que reprogramarlos:</p>
            <table className="table"><tbody>{afectados.map(a => <tr key={a.id}><td className="mono">{hora(a.inicio)}</td><td>{a.paciente}</td><td className="mono muted">{a.telefono}</td></tr>)}</tbody></table>
          </> : <p className="muted">No había turnos en esa franja.</p>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Listo</button></div>
        </div>
      ) : (
        <form onSubmit={guardar} style={{ display: 'grid', gap: 14 }}>
          <div className="form-grid">
            <div className="field"><label htmlFor="b-p">Profesional</label>
              <select id="b-p" className="input" value={prof} onChange={e => setProf(Number(e.target.value))}>{cat.profesionales.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select></div>
            <div className="field"><label htmlFor="b-d">Desde</label><input id="b-d" className="input" type="time" value={desde} onChange={e => setDesde(e.target.value)} /></div>
            <div className="field"><label htmlFor="b-h">Hasta</label><input id="b-h" className="input" type="time" value={hasta} onChange={e => setHasta(e.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor="b-m">Motivo</label><input id="b-m" className="input" placeholder="Cirugías, congreso, vacaciones…" value={motivo} onChange={e => setMotivo(e.target.value)} required minLength={3} /></div>
          <Alerta error={error} />
          <div className="row" style={{ justifyContent: 'flex-end' }}><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary">Bloquear</button></div>
        </form>
      )}
    </Modal>
  );
}
