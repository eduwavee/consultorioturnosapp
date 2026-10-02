-- =====================================================================
-- Migración 003: lo que necesita la API
--   * retención pública sin paciente todavía (se completa al confirmar)
--   * token de retención para que solo quien retuvo pueda confirmar
--   * profesional por defecto de cada tipo de turno (reserva online)
--   * sesiones de usuarios del panel
--   * estados de recordatorio
-- =====================================================================

-- Una retención web se crea antes de conocer al paciente
ALTER TABLE turnos ALTER COLUMN paciente_id DROP NOT NULL;
ALTER TABLE turnos ADD CONSTRAINT paciente_requerido CHECK (
    paciente_id IS NOT NULL
    OR (origen = 'web' AND estado::text IN ('pendiente', 'cancelado'))
);

ALTER TABLE turnos ADD COLUMN token_retencion UUID UNIQUE;

-- Quién atiende cada tipo de turno cuando se reserva online
ALTER TABLE tipos_turno ADD COLUMN profesional_id BIGINT REFERENCES profesionales(id);

-- Sesiones del panel (guardamos el hash del token, nunca el token)
CREATE TABLE sesiones (
    token_hash TEXT PRIMARY KEY,
    usuario_id BIGINT NOT NULL REFERENCES usuarios(id),
    expira_at  TIMESTAMPTZ NOT NULL,
    creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sesiones_expira ON sesiones (expira_at);

-- Recordatorios: estados controlados
ALTER TABLE recordatorios ADD CONSTRAINT recordatorio_estado
    CHECK (estado IN ('pendiente', 'enviado', 'error', 'cancelado'));
ALTER TABLE recordatorios ADD COLUMN intentos INT NOT NULL DEFAULT 0;
ALTER TABLE recordatorios ADD COLUMN ultimo_error TEXT;

-- Al cancelar un turno, sus recordatorios pendientes se cancelan solos
CREATE FUNCTION cancelar_recordatorios() RETURNS trigger AS $$
BEGIN
    IF NEW.estado::text IN ('cancelado', 'ausente') AND OLD.estado IS DISTINCT FROM NEW.estado THEN
        UPDATE recordatorios SET estado = 'cancelado'
        WHERE turno_id = NEW.id AND estado = 'pendiente';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER turnos_cancelar_recordatorios
    AFTER UPDATE OF estado ON turnos
    FOR EACH ROW EXECUTE FUNCTION cancelar_recordatorios();

-- Control de migraciones aplicado por scripts/migrate.ts

-- Búsqueda de pacientes sin importar tildes (sin depender de la extensión unaccent)
CREATE FUNCTION unaccent_simple(t TEXT) RETURNS TEXT
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT translate(lower(t), 'áéíóúüñàèìòù', 'aeiouunaeiou') $$;
