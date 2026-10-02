import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} no encontrado`);

/** Traduce errores de Postgres a respuestas HTTP con mensajes para el usuario. */
function fromPg(e: any): HttpError | null {
  switch (e?.code) {
    case '23P01': // exclusion_violation: choque de turnos
      return new HttpError(409, 'Ese horario se acaba de ocupar. Elegí otro.', e.constraint);
    case '23505':
      return new HttpError(409, 'Ya existe un registro con esos datos.', e.constraint);
    case '23514':
      return new HttpError(422, 'Los datos no cumplen una regla del sistema.', e.constraint);
    case '23503':
      return new HttpError(422, 'Hace referencia a un registro que no existe.', e.constraint);
    case 'P0001': // RAISE EXCEPTION de nuestros triggers
      return new HttpError(422, e.message, 'regla_negocio');
    case '22P02':
      return new HttpError(400, 'Formato de dato inválido.');
    default:
      return null;
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Datos inválidos', detalles: err.issues.map(i => ({ campo: i.path.join('.'), mensaje: i.message })) });
    return;
  }
  const http = err instanceof HttpError ? err : fromPg(err);
  if (http) {
    res.status(http.status).json({ error: http.message, codigo: http.code });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Error interno' });
};
