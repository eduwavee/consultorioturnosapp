-- =====================================================================
-- Migración 002: reserva online desde la landing
-- Agrega lo que necesita el turnero público y que el schema base no tenía:
--   * estado 'pendiente' con vencimiento (retención de 5 min)
--   * horarios de atención y bloqueos de agenda
--   * la base calcula fin y recurso desde el tipo de turno (no confía en el cliente)
--   * registro de accesos de lectura a la historia clínica
-- Correr DESPUÉS de schema.sql, fuera de una transacción (por ALTER TYPE ... ADD VALUE).
-- =====================================================================

ALTER TYPE estado_turno ADD VALUE IF NOT EXISTS 'pendiente' BEFORE 'reservado';

ALTER TABLE turnos
    ADD COLUMN expira_at TIMESTAMPTZ,
    ADD COLUMN origen    TEXT NOT NULL DEFAULT 'secretaria'
        CHECK (origen IN ('secretaria', 'web', 'whatsapp'));

ALTER TABLE turnos
    ADD CONSTRAINT pendiente_con_vencimiento
    CHECK (estado::text <> 'pendiente' OR expira_at IS NOT NULL);

-- ---------- Horarios de atención (dia_semana: 0 = domingo) ----------
CREATE TABLE horarios_atencion (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profesional_id BIGINT   NOT NULL REFERENCES profesionales(id),
    dia_semana     SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
    desde          TIME     NOT NULL,
    hasta          TIME     NOT NULL,
    CHECK (hasta > desde)
);

-- ---------- Bloqueos (vacaciones, cirugías, congresos) ----------
CREATE TABLE bloqueos_agenda (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profesional_id BIGINT      NOT NULL REFERENCES profesionales(id),
    inicio         TIMESTAMPTZ NOT NULL,
    fin            TIMESTAMPTZ NOT NULL,
    motivo         TEXT        NOT NULL,
    CHECK (fin > inicio),
    EXCLUDE USING gist (profesional_id WITH =, tstzrange(inicio, fin) WITH &&)
);

-- ---------- Validación de turnos en la base ----------
CREATE FUNCTION validar_turno() RETURNS trigger AS $$
DECLARE
    v_tipo  tipos_turno%ROWTYPE;
    v_local TIMESTAMP;
BEGIN
    SELECT * INTO v_tipo FROM tipos_turno WHERE id = NEW.tipo_turno_id;

    -- La duración y el equipo salen del tipo de turno, no del request
    NEW.fin := NEW.inicio + make_interval(mins => v_tipo.duracion_min);
    IF NEW.recurso_id IS NULL THEN
        NEW.recurso_id := v_tipo.recurso_id;
    END IF;

    -- No se puede reservar sobre un bloqueo
    IF NEW.estado::text NOT IN ('cancelado', 'ausente') AND EXISTS (
        SELECT 1 FROM bloqueos_agenda b
        WHERE b.profesional_id = NEW.profesional_id
          AND tstzrange(b.inicio, b.fin) && tstzrange(NEW.inicio, NEW.fin)
    ) THEN
        RAISE EXCEPTION 'La agenda está bloqueada en ese horario' USING ERRCODE = 'P0001';
    END IF;

    -- Desde la web, solo dentro del horario de atención
    -- (solo al crear o mover el turno: confirmar o cancelar no revalida)
    IF NEW.origen = 'web' AND (TG_OP = 'INSERT' OR NEW.inicio IS DISTINCT FROM OLD.inicio) THEN
        v_local := NEW.inicio AT TIME ZONE 'America/Argentina/Tucuman';
        IF NOT EXISTS (
            SELECT 1 FROM horarios_atencion h
            WHERE h.profesional_id = NEW.profesional_id
              AND h.dia_semana = EXTRACT(DOW FROM v_local)
              AND v_local::time >= h.desde
              AND (NEW.fin AT TIME ZONE 'America/Argentina/Tucuman')::time <= h.hasta
        ) THEN
            RAISE EXCEPTION 'Fuera del horario de atención' USING ERRCODE = 'P0001';
        END IF;
        IF NEW.inicio < now() + interval '1 hour' THEN
            RAISE EXCEPTION 'Los turnos online se sacan con al menos 1 hora de anticipación' USING ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER turnos_validar
    BEFORE INSERT OR UPDATE OF inicio, tipo_turno_id, profesional_id, estado ON turnos
    FOR EACH ROW EXECUTE FUNCTION validar_turno();

-- ---------- Liberar retenciones vencidas ----------
-- Lo llama un job cada minuto (BullMQ / node-cron / pg_cron) y también el
-- endpoint de reserva al inicio de su transacción.
CREATE FUNCTION liberar_turnos_vencidos() RETURNS INT AS $$
DECLARE n INT;
BEGIN
    UPDATE turnos SET estado = 'cancelado'
    WHERE estado = 'pendiente' AND expira_at < now();
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------- Quién abrió cada historia clínica ----------
CREATE TABLE accesos_historia (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id  BIGINT NOT NULL REFERENCES usuarios(id),
    paciente_id BIGINT NOT NULL REFERENCES pacientes(id),
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER accesos_historia_inmutable
    BEFORE UPDATE OR DELETE ON accesos_historia
    FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- ---------- Seed: horarios del consultorio demo ----------
-- (asume profesional 1 = la doctora, 2 = técnico de estudios)
-- INSERT INTO horarios_atencion (profesional_id, dia_semana, desde, hasta)
-- SELECT p, d, h.desde, h.hasta
-- FROM unnest(ARRAY[1,2]) p, generate_series(1,5) d,
--      (VALUES ('09:00'::time, '13:00'::time), ('16:00', '20:00')) h(desde, hasta)
-- UNION ALL SELECT p, 6, '09:00', '12:00' FROM unnest(ARRAY[1,2]) p;
