-- =====================================================================
-- Migración 004: los bloqueos no traban los turnos que ya estaban dados
-- Antes, validar_turno() revisaba el bloqueo también al cambiar el estado,
-- así que un turno que quedó adentro de un bloqueo no se podía confirmar,
-- pasar a sala ni marcar atendido. Ahora el bloqueo solo se controla al
-- crear el turno o al moverlo (horario, profesional o tipo de turno).
-- =====================================================================

CREATE OR REPLACE FUNCTION validar_turno() RETURNS trigger AS $$
DECLARE
    v_tipo  tipos_turno%ROWTYPE;
    v_local TIMESTAMP;
    v_mueve BOOLEAN;
BEGIN
    SELECT * INTO v_tipo FROM tipos_turno WHERE id = NEW.tipo_turno_id;

    -- La duración y el equipo salen del tipo de turno, no del request
    NEW.fin := NEW.inicio + make_interval(mins => v_tipo.duracion_min);
    IF NEW.recurso_id IS NULL THEN
        NEW.recurso_id := v_tipo.recurso_id;
    END IF;

    v_mueve := TG_OP = 'INSERT'
        OR NEW.inicio IS DISTINCT FROM OLD.inicio
        OR NEW.profesional_id IS DISTINCT FROM OLD.profesional_id
        OR NEW.tipo_turno_id IS DISTINCT FROM OLD.tipo_turno_id
        OR OLD.estado::text IN ('cancelado', 'ausente');

    -- No se puede reservar (ni mover un turno) sobre un bloqueo
    IF v_mueve AND NEW.estado::text NOT IN ('cancelado', 'ausente') AND EXISTS (
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
