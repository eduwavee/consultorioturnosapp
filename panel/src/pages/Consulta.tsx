import { useEffect, useState } from 'react';
import { api, fecha, hora, type Auditoria, type Campo, type Consulta, type Paciente, type Plantilla } from '../api';
import { useRuta } from '../App';
import { Alerta, Modal, useCarga } from '../components/ui';

/** Editor de consulta: la ficha se arma desde la plantilla (JSON) de la especialidad. */
export function ConsultaPage({ id }: { id: string | undefined }) {
  const { params } = useRuta();
  const pacienteId = Number(params.get('paciente'));
  const turnoId = params.get('turno') ? Number(params.get('turno')) : null;
  const esNueva = id === 'nueva';

  const plantillas = useCarga(() => api.get<Plantilla[]>('/plantillas'), []);
  const paciente = useCarga(() => api.get<Paciente>(`/pacientes/${pacienteId}`), [pacienteId]);
  const historia = useCarga(() => esNueva ? Promise.resolve([] as Consulta[]) : api.get<Consulta[]>(`/pacientes/${pacienteId}/historia`), [pacienteId, id]);

  const [c, setC] = useState<Partial<Consulta>>({ datos: {}, estado: 'borrador' });
  const [cid, setCid] = useState<number | null>(esNueva ? null : Number(id));
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [motivo, setMotivo] = useState<string | null>(null);
  const [ver, setVer] = useState(0);
  const hist = useCarga(() => cid ? api.get<Auditoria[]>(`/consultas/${cid}/historial`) : Promise.resolve([]), [cid, ver]);

  useEffect(() => {
    if (!esNueva && historia.data) { const x = historia.data.find(h => h.id === Number(id)); if (x) setC(x); }
  }, [historia.data, id, esNueva]);

  const plantilla = plantillas.data?.find(p => p.id === (c.plantilla_id ?? 1)) ?? plantillas.data?.[0];
  const soloLectura = c.estado === 'anulada';
  const setDato = (k: string, val: unknown) => setC(x => ({ ...x, datos: { ...x.datos, [k]: val } }));

  const guardar = async (cerrar = false) => {
    setError(null); setOk(null);
    try {
      let actual = cid;
      const cuerpo = { datos: c.datos, diagnostico: c.diagnostico ?? null, indicaciones: c.indicaciones ?? null };
      if (!actual) {
        const n = await api.post<Consulta>('/consultas', { ...cuerpo, paciente_id: pacienteId, turno_id: turnoId, plantilla_id: plantilla!.id });
        actual = n.id; setCid(n.id); history.replaceState(null, '', `#/consulta/${n.id}?paciente=${pacienteId}`);
      } else {
        await api.patch(`/consultas/${actual}`, cuerpo);
      }
      if (cerrar) { const r = await api.post<Consulta>(`/consultas/${actual}/cerrar`); setC(x => ({ ...x, estado: r.estado })); }
      setOk(cerrar ? null : 'Guardado.'); setVer(v => v + 1);
    } catch (e: any) { setError(e.message); }
  };

  const anular = async () => {
    try { const r = await api.post<Consulta>(`/consultas/${cid}/anular`, { motivo }); setC(x => ({ ...x, estado: r.estado, motivo_anulacion: r.motivo_anulacion })); setMotivo(null); setVer(v => v + 1); }
    catch (e: any) { setError(e.message); }
  };

  const [receta, setReceta] = useState(false);

  if (!pacienteId) return <Alerta error="Falta el paciente" />;
  const pac = paciente.data;

  return (
    <>
      <div className="head">
        <div>
          <a href={`#/pacientes/${pacienteId}`} className="muted" style={{ fontSize: 13 }}>← {pac ? `${pac.nombre} ${pac.apellido}` : 'Paciente'}</a>
          <h1 style={{ marginTop: 6 }}>{esNueva && !cid ? 'Nueva consulta' : `Consulta${c.fecha ? ` del ${fecha(c.fecha)}` : ''}`}</h1>
          <p className="muted">{plantilla?.nombre} · <span className={`chip ${c.estado}`}>{c.estado}</span></p>
        </div>
        {!soloLectura && (
          <div className="row">
            {cid && <button className="btn sm danger" onClick={() => setMotivo('')}>Anular</button>}
            {cid && <button className="btn sm" onClick={() => setReceta(true)}>Nueva receta</button>}
            <button className="btn sm" onClick={() => guardar(false)}>Guardar</button>
            {c.estado === 'borrador' && <button className="btn primary sm" onClick={() => guardar(true)}>Cerrar consulta</button>}
          </div>
        )}
      </div>
      {motivo !== null && (
        <div className="card row" style={{ marginBottom: 16 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Motivo de la anulación (queda registrado)" value={motivo} onChange={e => setMotivo(e.target.value)} autoFocus />
          <button className="btn sm" onClick={() => setMotivo(null)}>Cancelar</button>
          <button className="btn sm danger" onClick={anular} disabled={motivo.trim().length < 5}>Confirmar anulación</button>
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, marginBottom: 14 }}><Alerta error={error} ok={ok} />
        {soloLectura && <div className="alert error">Consulta anulada: {c.motivo_anulacion}. No se puede editar, pero se conserva.</div>}
        {c.estado === 'cerrada' && <div className="alert info">Consulta cerrada. Si corregís algo, el cambio queda en el historial con tu nombre.</div>}
      </div>

      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div className="card ficha">
          {plantilla?.esquema.secciones.map(s => (
            <section key={s.id}>
              <h3>{s.titulo}</h3>
              <div className="form-grid">{s.campos.map(f => <CampoFicha key={f.id} f={f} valor={c.datos?.[f.id]} onChange={v => setDato(f.id, v)} disabled={soloLectura} />)}</div>
            </section>
          ))}
          <section>
            <h3>Diagnóstico e indicaciones</h3>
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="field"><label htmlFor="dx">Diagnóstico</label><input id="dx" className="input" value={c.diagnostico ?? ''} onChange={e => setC(x => ({ ...x, diagnostico: e.target.value }))} disabled={soloLectura} /></div>
              <div className="field"><label htmlFor="ind">Indicaciones</label><textarea id="ind" className="input" value={c.indicaciones ?? ''} onChange={e => setC(x => ({ ...x, indicaciones: e.target.value }))} disabled={soloLectura} /></div>
            </div>
          </section>
        </div>
        <div className="card">
          {cid && <Recetas consultaId={cid} ver={ver} />}
          <h3>Historial de cambios</h3>
          {!cid && <p className="muted">Aparece cuando guardás la consulta. Cada cambio queda con fecha, usuario y valor anterior.</p>}
          <div className="timeline">
            {hist.data?.map(a => (
              <div key={a.id}>
                <b style={{ fontWeight: 600 }}>{a.accion === 'INSERT' ? 'Creada' : 'Modificada'}</b> <span className="muted">· {a.usuario ?? 'sistema'} · {fecha(a.at, { day: 'numeric', month: 'short' })} {hora(a.at)}</span>
                <Diff antes={a.antes} despues={a.despues} />
              </div>
            ))}
          </div>
        </div>
      </div>
      {receta && cid && <NuevaReceta consultaId={cid} datos={c.datos ?? {}} onClose={() => setReceta(false)} onOk={() => { setReceta(false); setVer(v => v + 1); }} />}
    </>
  );
}

const TIPOS_RECETA = { anteojos: 'Anteojos', lentes_contacto: 'Lentes de contacto', medicacion: 'Medicación', orden_estudio: 'Orden de estudio' } as const;
type TipoReceta = keyof typeof TIPOS_RECETA;
type Lente = { esf?: string; cil?: string; eje?: string };

/** Recetas ya emitidas en esta consulta, para reimprimir. */
function Recetas({ consultaId, ver }: { consultaId: number; ver: number }) {
  const h = useCarga(() => api.get<{ id: number; tipo: string; emitida_at: string }[]>(`/consultas/${consultaId}/recetas`), [consultaId, ver]);
  const recetas = h.data ?? [];
  if (!recetas.length) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <h3>Recetas emitidas</h3>
      <div className="row">{recetas.map(r => (
        <a key={r.id} className="btn sm" href={`/api/recetas/${r.id}/imprimir`} target="_blank" rel="noopener">
          {TIPOS_RECETA[r.tipo as TipoReceta] ?? r.tipo} · {fecha(r.emitida_at, { day: 'numeric', month: 'short' })}
        </a>
      ))}</div>
    </div>
  );
}

/** Emite una receta. Anteojos y lentes arrancan con la refracción cargada en la ficha. */
function NuevaReceta({ consultaId, datos, onClose, onOk }: { consultaId: number; datos: Record<string, any>; onClose: () => void; onOk: () => void }) {
  const [tipo, setTipo] = useState<TipoReceta>('anteojos');
  const [od, setOd] = useState<Lente>(datos.ref_od ?? {});
  const [oi, setOi] = useState<Lente>(datos.ref_oi ?? {});
  const [adicion, setAdicion] = useState(datos.adicion != null ? String(datos.adicion) : '');
  const [texto, setTexto] = useState('');
  const [error, setError] = useState<string | null>(null);
  const optica = tipo === 'anteojos' || tipo === 'lentes_contacto';

  const emitir = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!optica && !texto.trim()) { setError(tipo === 'medicacion' ? 'Indicá la medicación' : 'Indicá qué estudios pedís'); return; }
    // La ventana se abre antes del await para que el navegador no la bloquee
    const ventana = window.open('', '_blank');
    try {
      const contenido = optica ? { od, oi, adicion: adicion || undefined, texto: texto || undefined } : { texto };
      const r = await api.post<{ id: number }>(`/consultas/${consultaId}/recetas`, { tipo, contenido });
      if (ventana) ventana.location.href = `/api/recetas/${r.id}/imprimir`;
      onOk();
    } catch (err: any) { ventana?.close(); setError(err.message); }
  };

  const filaLente = (ojo: string, v: Lente, set: (l: Lente) => void) => (
    <div className="field"><label>{ojo} (esf / cil / eje)</label>
      <div className="refr">{(['esf', 'cil', 'eje'] as const).map(k => (
        <input key={k} className="input mono" placeholder={k} aria-label={`${ojo} ${k}`} value={v[k] ?? ''} onChange={e => set({ ...v, [k]: e.target.value })} />
      ))}</div></div>
  );

  return (
    <Modal titulo="Nueva receta" onClose={onClose}>
      <form onSubmit={emitir} style={{ display: 'grid', gap: 14 }}>
        <div className="seg" role="group" aria-label="Tipo de receta" style={{ justifySelf: 'start', flexWrap: 'wrap' }}>
          {(Object.keys(TIPOS_RECETA) as TipoReceta[]).map(t => (
            <button key={t} type="button" aria-pressed={tipo === t} onClick={() => { setTipo(t); setError(null); }}>{TIPOS_RECETA[t]}</button>
          ))}
        </div>
        {optica && <>
          {filaLente('OD', od, setOd)}
          {filaLente('OI', oi, setOi)}
          <div className="field"><label htmlFor="rx-ad">Adición</label><input id="rx-ad" className="input mono" value={adicion} onChange={e => setAdicion(e.target.value)} style={{ maxWidth: 160 }} /></div>
        </>}
        <div className="field">
          <label htmlFor="rx-tx">{tipo === 'medicacion' ? 'Medicación e indicaciones' : tipo === 'orden_estudio' ? 'Estudios solicitados' : 'Observaciones'}</label>
          <textarea id="rx-tx" className="input" value={texto} onChange={e => setTexto(e.target.value)} rows={optica ? 2 : 5}
            placeholder={tipo === 'medicacion' ? 'Ej.: Latanoprost 0,005 % · 1 gota en cada ojo a la noche' : tipo === 'orden_estudio' ? 'Ej.: OCT de nervio óptico · Campo visual 24-2' : ''} />
        </div>
        <Alerta error={error} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary">Emitir e imprimir</button>
        </div>
      </form>
    </Modal>
  );
}

function CampoFicha({ f, valor, onChange, disabled }: { f: Campo; valor: any; onChange: (v: any) => void; disabled: boolean }) {
  const id = `f-${f.id}`;
  const label = f.etiqueta ?? (f.id.charAt(0).toUpperCase() + f.id.slice(1)).replace(/_/g, ' ');
  if (f.tipo === 'refraccion') {
    const v = valor ?? {};
    return (
      <div className="field" style={{ gridColumn: 'span 2' }}><label>{label}</label>
        <div className="refr">{(['esf', 'cil', 'eje'] as const).map(k => (
          <input key={k} className="input mono" placeholder={k} aria-label={`${label} ${k}`} value={v[k] ?? ''} disabled={disabled} onChange={e => onChange({ ...v, [k]: e.target.value })} />
        ))}</div></div>
    );
  }
  if (f.tipo === 'texto_largo') return <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor={id}>{label}</label><textarea id={id} className="input" value={valor ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} /></div>;
  return (
    <div className="field"><label htmlFor={id}>{label}{f.unidad ? ` (${f.unidad})` : ''}</label>
      <input id={id} className="input mono" type={f.tipo === 'numero' ? 'number' : 'text'} step="any" value={valor ?? ''} disabled={disabled}
        onChange={e => onChange(f.tipo === 'numero' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)} /></div>
  );
}

/** Muestra qué campos cambiaron entre dos versiones de la consulta. */
function Diff({ antes, despues }: { antes: any; despues: any }) {
  if (!antes || !despues) return null;
  const fmt = (v: any) => v == null || v === '' ? '∅' : typeof v === 'object' ? Object.values(v).filter(Boolean).join(' / ') || '∅' : String(v);
  const cambios: [string, any, any][] = [];
  const da = antes.datos ?? {}, dd = despues.datos ?? {};
  for (const k of new Set([...Object.keys(da), ...Object.keys(dd)])) if (JSON.stringify(da[k]) !== JSON.stringify(dd[k])) cambios.push([k.replace(/_/g, ' '), da[k], dd[k]]);
  for (const k of ['diagnostico', 'indicaciones', 'estado'] as const) if (antes[k] !== despues[k]) cambios.push([k, antes[k], despues[k]]);
  if (!cambios.length) return null;
  return <div className="diff">{cambios.map(([k, a, b]) => <span key={k}><span className="muted">{k}:</span> <del>{fmt(a)}</del> → <ins>{fmt(b)}</ins></span>)}</div>;
}

