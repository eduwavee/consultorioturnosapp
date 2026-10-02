export type Rol = 'admin' | 'medico' | 'secretaria';
export interface Usuario { id: number; nombre: string; email: string; rol: Rol; profesional_id: number | null }
export interface Tipo { id: number; nombre: string; duracion_min: number; recurso_id: number | null; profesional_id: number | null; color: string | null; precio_particular: number | null }
export interface Profesional { id: number; nombre: string; especialidad: string; titulo: string | null }
export interface ConsultorioBreve { nombre: string; marca: string; especialidad: string }
export interface Catalogos { tipos: Tipo[]; profesionales: Profesional[]; recursos: { id: number; nombre: string }[]; obras_sociales: { id: number; nombre: string }[]; horarios: { profesional_id: number; dia_semana: number; desde: string; hasta: string }[]; consultorio: ConsultorioBreve | null }
export type EstadoTurno = 'pendiente' | 'reservado' | 'confirmado' | 'en_sala' | 'atendido' | 'cancelado' | 'ausente';
export interface Turno {
  id: number; inicio: string; fin: string; estado: EstadoTurno; sobreturno: boolean; origen: string;
  profesional_id: number; recurso_id: number | null; tipo_turno_id: number; tipo: string; color: string | null; recurso: string | null;
  precio: number | null; cobrado: boolean;
  paciente_id: number | null; paciente: string | null; dni: string | null; telefono: string | null; profesional: string;
}
export interface Bloqueo { id: number; profesional_id: number; inicio: string; fin: string; motivo: string }
export interface Paciente {
  id: number; dni: string; nombre: string; apellido: string; telefono: string | null; email?: string | null;
  fecha_nac?: string | null; obra_social?: string | null; obra_social_id?: number | null; nro_afiliado?: string | null;
  notas_admin?: string | null; proximo_turno?: string | null; turnos?: { id: number; inicio: string; estado: EstadoTurno; tipo: string }[];
}
export interface Campo { id: string; tipo: 'texto' | 'texto_largo' | 'numero' | 'refraccion'; etiqueta?: string; unidad?: string }
export interface Plantilla { id: number; nombre: string; esquema: { secciones: { id: string; titulo: string; campos: Campo[] }[] } }
export interface Consulta {
  id: number; fecha: string; estado: 'borrador' | 'cerrada' | 'anulada'; diagnostico: string | null; indicaciones: string | null;
  datos: Record<string, any>; plantilla_id: number; turno_id: number | null; motivo_anulacion: string | null; profesional?: string;
  recetas?: { id: number; tipo: string; emitida_at: string }[];
}
export interface EntradaEspera {
  id: number; paciente_id: number; tipo_turno_id: number; desde: string | null; hasta: string | null; notas: string | null;
  avisado_at: string | null; resuelto_at: string | null; creado_at: string; paciente: string; telefono: string | null; tipo: string;
  turno_actual: string | null;
}
export interface Auditoria { id: number; tabla?: string; registro_id?: number; accion: string; at: string; usuario: string | null; antes: any; despues: any }

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api${url}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const detalle = data.detalles?.map((d: any) => d.mensaje).join(' · ');
    throw new ApiError(r.status, detalle ? `${data.error}: ${detalle}` : data.error ?? 'Error inesperado');
  }
  return data as T;
}

export const api = {
  get: <T>(u: string) => req<T>('GET', u),
  post: <T>(u: string, b?: unknown) => req<T>('POST', u, b ?? {}),
  patch: <T>(u: string, b: unknown) => req<T>('PATCH', u, b),
  put: <T>(u: string, b: unknown) => req<T>('PUT', u, b),
  del: (u: string) => req<void>('DELETE', u),
};

/* ---------- Fechas en hora de Tucumán ---------- */
const TZ = 'America/Argentina/Tucuman';
export const hoyISO = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const sumarDias = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00-03:00`); d.setUTCDate(d.getUTCDate() + n);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
};
export const hora = (iso: string) => new Date(iso).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const fecha = (iso: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso).toLocaleDateString('es-AR', { timeZone: TZ, ...opts });
/** Día (AAAA-MM-DD) de un instante, en hora del consultorio. */
export const diaDe = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
/** 0 = domingo, igual que horarios_atencion.dia_semana. */
export const diaSemana = (dia: string) => new Date(`${dia}T12:00:00-03:00`).getUTCDay();
export const pad2 = (n: number) => String(n).padStart(2, '0');
export const minutosDelDia = (iso: string) => {
  const [h, m] = hora(iso).split(':').map(Number); return h * 60 + m;
};
export const plata = (n: number) => n.toLocaleString('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });

export const ESTADO_LABEL: Record<EstadoTurno, string> = {
  pendiente: 'Retenido', reservado: 'Reservado', confirmado: 'Confirmado', en_sala: 'En sala',
  atendido: 'Atendido', cancelado: 'Cancelado', ausente: 'Ausente',
};
/** Misma máquina de estados que la API (lib/agenda.ts). */
export const TRANSICIONES: Record<EstadoTurno, EstadoTurno[]> = {
  pendiente: [], reservado: ['confirmado', 'en_sala', 'cancelado', 'ausente'],
  confirmado: ['en_sala', 'cancelado', 'ausente'], en_sala: ['atendido'], atendido: [], cancelado: [], ausente: [],
};
