-- =====================================================================
-- Migración 005: lo que hace falta para usarlo en un consultorio real
--   * datos del consultorio configurables (nada fijo en el código)
--   * título del profesional y descripción de cada estudio
--   * token para que el paciente gestione su turno sin llamar
--   * lista de espera: huecos liberados y mensajes salientes
--   * auditoría también sobre la configuración
-- =====================================================================

-- ---------- Datos del consultorio (una sola fila) ----------
CREATE TABLE consultorio (
    id             INT  PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    nombre         TEXT NOT NULL,          -- 'Dra. Camila Ortiz'
    marca          TEXT NOT NULL,          -- texto corto del logo: 'Camila Ortiz'
    especialidad   TEXT NOT NULL,          -- 'Oftalmología'
    ciudad         TEXT,
    direccion      TEXT,
    telefono       TEXT,
    whatsapp       TEXT,                   -- número público para consultas
    horarios_texto TEXT                    -- cómo se muestran los horarios en la web
);
INSERT INTO consultorio (nombre, marca, especialidad, ciudad, direccion, telefono, whatsapp, horarios_texto) VALUES (
    'Dra. Camila Ortiz', 'Camila Ortiz', 'Oftalmología', 'San Miguel de Tucumán',
    'Av. Ejemplo 1234, 2.º piso, San Miguel de Tucumán', '(0381) 000-0000', NULL,
    'Lunes a viernes de 9 a 13 y de 16 a 20 · Sábados de 9 a 12'
);

-- Cómo firma el profesional las recetas: 'Médica oftalmóloga', 'Kinesiólogo'...
ALTER TABLE profesionales ADD COLUMN titulo TEXT;

-- Texto corto que ve el paciente al elegir el estudio
ALTER TABLE tipos_turno ADD COLUMN descripcion TEXT;
UPDATE tipos_turno SET descripcion = CASE nombre
    WHEN 'Consulta'           THEN 'Agudeza visual, graduación, presión ocular y fondo de ojo. Si necesitás anteojos, te vas con la receta.'
    WHEN 'Control postop'     THEN 'Seguimiento de cirugías de cataratas y refractivas, con turnos cortos.'
    WHEN 'OCT'                THEN 'Tomografía de retina y nervio óptico. Detecta glaucoma y lesiones maculares antes de que se noten.'
    WHEN 'Campo visual'       THEN 'Mide la visión periférica. Es el estudio de control del glaucoma.'
    WHEN 'Topografía corneal' THEN 'Mapa de la córnea para adaptar lentes de contacto o evaluar cirugía refractiva.'
END;

-- ---------- Autogestión del turno por el paciente ----------
-- Cada turno tiene un token secreto que va en el link del WhatsApp
ALTER TABLE turnos ADD COLUMN token_gestion UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX idx_turnos_token_gestion ON turnos (token_gestion);

-- ---------- Lista de espera ----------
ALTER TABLE lista_espera
    ADD COLUMN notas       TEXT,
    ADD COLUMN creado_por  BIGINT REFERENCES usuarios(id),
    ADD COLUMN resuelto_at TIMESTAMPTZ,       -- consiguió turno o ya no le interesa
    ADD CONSTRAINT lista_espera_rango CHECK (hasta IS NULL OR desde IS NULL OR hasta >= desde);
CREATE INDEX idx_lista_espera_activa ON lista_espera (tipo_turno_id, creado_at) WHERE resuelto_at IS NULL;

-- Horarios que se liberan (cancelaciones y reprogramaciones). El worker los
-- ofrece a la lista de espera. Lo llena un trigger, así no depende de por
-- dónde se canceló el turno (panel, WhatsApp o el link del paciente).
CREATE TABLE huecos_liberados (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profesional_id BIGINT      NOT NULL REFERENCES profesionales(id),
    tipo_turno_id  BIGINT      NOT NULL REFERENCES tipos_turno(id),
    inicio         TIMESTAMPTZ NOT NULL,
    creado_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    procesado_at   TIMESTAMPTZ
);
CREATE INDEX idx_huecos_pend ON huecos_liberados (creado_at) WHERE procesado_at IS NULL;

CREATE FUNCTION registrar_hueco() RETURNS trigger AS $$
BEGIN
    -- Solo turnos reales (con paciente) que estaban ocupando la agenda,
    -- y con margen suficiente para que alguien de la lista llegue
    IF OLD.paciente_id IS NULL OR OLD.estado::text NOT IN ('reservado', 'confirmado')
       OR OLD.inicio < now() + interval '2 hours' THEN
        RETURN NEW;
    END IF;
    IF NEW.estado::text = 'cancelado' OR NEW.inicio IS DISTINCT FROM OLD.inicio THEN
        INSERT INTO huecos_liberados (profesional_id, tipo_turno_id, inicio)
        VALUES (OLD.profesional_id, OLD.tipo_turno_id, OLD.inicio);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER turnos_registrar_hueco
    AFTER UPDATE OF estado, inicio ON turnos
    FOR EACH ROW EXECUTE FUNCTION registrar_hueco();

-- Si alguien de la lista ya fue avisado y saca turno de ese estudio, sale de la lista solo
CREATE FUNCTION resolver_lista_espera() RETURNS trigger AS $$
BEGIN
    IF NEW.paciente_id IS NOT NULL AND NEW.estado::text IN ('reservado', 'confirmado')
       AND (TG_OP = 'INSERT' OR OLD.paciente_id IS DISTINCT FROM NEW.paciente_id) THEN
        UPDATE lista_espera SET resuelto_at = now()
        WHERE paciente_id = NEW.paciente_id AND tipo_turno_id = NEW.tipo_turno_id
          AND resuelto_at IS NULL AND avisado_at IS NOT NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER turnos_resolver_lista_espera
    AFTER INSERT OR UPDATE OF paciente_id ON turnos
    FOR EACH ROW EXECUTE FUNCTION resolver_lista_espera();

-- ---------- Mensajes salientes que no son recordatorios ----------
-- (avisos a la lista de espera, respuestas a lo que escribe el paciente)
CREATE TABLE mensajes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    telefono        TEXT        NOT NULL,
    texto           TEXT        NOT NULL,
    plantilla       TEXT,                     -- plantilla de Meta, si hay que salir de la ventana de 24 h
    parametros      JSONB,
    motivo          TEXT        NOT NULL,     -- 'lista_espera', 'respuesta'
    programado_para TIMESTAMPTZ NOT NULL DEFAULT now(),
    estado          TEXT        NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'enviado', 'error')),
    intentos        INT         NOT NULL DEFAULT 0,
    ultimo_error    TEXT,
    enviado_at      TIMESTAMPTZ,
    creado_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mensajes_pend ON mensajes (programado_para) WHERE estado = 'pendiente';

-- ---------- Auditoría también sobre la configuración ----------
CREATE TRIGGER audit_consultorio AFTER INSERT OR UPDATE OR DELETE ON consultorio
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_tipos_turno AFTER INSERT OR UPDATE OR DELETE ON tipos_turno
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_horarios AFTER INSERT OR UPDATE OR DELETE ON horarios_atencion
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_obras_sociales AFTER INSERT OR UPDATE OR DELETE ON obras_sociales
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_lista_espera AFTER INSERT OR UPDATE OR DELETE ON lista_espera
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_bloqueos AFTER INSERT OR UPDATE OR DELETE ON bloqueos_agenda
    FOR EACH ROW EXECUTE FUNCTION audit_row();
