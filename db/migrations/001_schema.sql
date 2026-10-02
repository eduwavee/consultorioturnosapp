-- =====================================================================
-- Sistema de gestión para consultorios (genérico, 1er caso: oftalmología)
-- PostgreSQL 14+
-- Ideas clave:
--   1) Anti-colisión de turnos a nivel base de datos (EXCLUDE constraint)
--   2) Auditoría inmutable (audit_log append-only + triggers)
--   3) Nada de la historia clínica se borra, solo se anula con motivo
--   4) Ficha clínica configurable por especialidad (JSONB + plantillas)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------- Tipos ----------
CREATE TYPE rol_usuario     AS ENUM ('admin', 'medico', 'secretaria');
CREATE TYPE estado_turno    AS ENUM ('reservado', 'confirmado', 'en_sala', 'atendido', 'cancelado', 'ausente');
CREATE TYPE estado_consulta AS ENUM ('borrador', 'cerrada', 'anulada');
CREATE TYPE medio_pago      AS ENUM ('efectivo', 'transferencia', 'debito', 'credito', 'obra_social');
CREATE TYPE tipo_cobro      AS ENUM ('particular', 'copago', 'obra_social');

-- ---------- Usuarios y profesionales ----------
CREATE TABLE usuarios (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre        TEXT        NOT NULL,
    email         TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    rol           rol_usuario NOT NULL,
    activo        BOOLEAN     NOT NULL DEFAULT TRUE,
    creado_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE profesionales (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    usuario_id   BIGINT NOT NULL UNIQUE REFERENCES usuarios(id),
    matricula    TEXT,
    especialidad TEXT   NOT NULL            -- 'oftalmologia', 'kinesiologia', etc.
);

-- Recursos físicos: boxes, equipos (OCT, campímetro, topógrafo...)
CREATE TABLE recursos (
    id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre TEXT NOT NULL,
    activo BOOLEAN NOT NULL DEFAULT TRUE
);

-- Tipos de turno configurables (la duración y el recurso salen de acá)
CREATE TABLE tipos_turno (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre             TEXT    NOT NULL,        -- 'Consulta', 'OCT', 'Campo visual'...
    duracion_min       INT     NOT NULL CHECK (duracion_min > 0),
    recurso_id         BIGINT  REFERENCES recursos(id),  -- NULL = no necesita equipo
    precio_particular  NUMERIC(12,2),
    color              TEXT,
    activo             BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Pacientes ----------
CREATE TABLE obras_sociales (
    id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    activa BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE pacientes (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dni             TEXT NOT NULL UNIQUE,
    nombre          TEXT NOT NULL,
    apellido        TEXT NOT NULL,
    fecha_nac       DATE,
    telefono        TEXT,                        -- para recordatorios WhatsApp
    email           TEXT,
    obra_social_id  BIGINT REFERENCES obras_sociales(id),
    nro_afiliado    TEXT,
    notas_admin     TEXT,                        -- solo datos administrativos
    creado_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Turnos (anti-colisión a nivel DB) ----------
CREATE TABLE turnos (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    paciente_id    BIGINT NOT NULL REFERENCES pacientes(id),
    profesional_id BIGINT NOT NULL REFERENCES profesionales(id),
    tipo_turno_id  BIGINT NOT NULL REFERENCES tipos_turno(id),
    recurso_id     BIGINT REFERENCES recursos(id),
    inicio         TIMESTAMPTZ NOT NULL,
    fin            TIMESTAMPTZ NOT NULL,
    estado         estado_turno NOT NULL DEFAULT 'reservado',
    sobreturno     BOOLEAN NOT NULL DEFAULT FALSE,   -- habilitado por el médico
    creado_por     BIGINT REFERENCES usuarios(id),
    creado_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (fin > inicio),

    -- Un profesional no puede tener dos turnos activos superpuestos
    -- (los sobreturnos quedan fuera del chequeo a propósito)
    CONSTRAINT sin_choque_profesional EXCLUDE USING gist (
        profesional_id WITH =,
        tstzrange(inicio, fin) WITH &&
    ) WHERE (estado NOT IN ('cancelado', 'ausente') AND NOT sobreturno),

    -- Un equipo/box no puede usarse en dos turnos a la vez
    CONSTRAINT sin_choque_recurso EXCLUDE USING gist (
        recurso_id WITH =,
        tstzrange(inicio, fin) WITH &&
    ) WHERE (recurso_id IS NOT NULL AND estado NOT IN ('cancelado', 'ausente'))
);
CREATE INDEX idx_turnos_inicio ON turnos (inicio);
CREATE INDEX idx_turnos_paciente ON turnos (paciente_id);

CREATE TABLE lista_espera (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    paciente_id    BIGINT NOT NULL REFERENCES pacientes(id),
    tipo_turno_id  BIGINT NOT NULL REFERENCES tipos_turno(id),
    desde          DATE,
    hasta          DATE,
    avisado_at     TIMESTAMPTZ,
    creado_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Historia clínica ----------
-- La plantilla define los campos de la ficha por especialidad.
CREATE TABLE plantillas_ficha (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    especialidad TEXT  NOT NULL,
    nombre       TEXT  NOT NULL,
    esquema      JSONB NOT NULL,                 -- lista de campos/secciones
    activa       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE consultas (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    paciente_id    BIGINT NOT NULL REFERENCES pacientes(id),
    profesional_id BIGINT NOT NULL REFERENCES profesionales(id),
    turno_id       BIGINT REFERENCES turnos(id),
    plantilla_id   BIGINT REFERENCES plantillas_ficha(id),
    fecha          TIMESTAMPTZ NOT NULL DEFAULT now(),
    datos          JSONB NOT NULL DEFAULT '{}',  -- valores de la ficha
    diagnostico    TEXT,
    indicaciones   TEXT,
    estado         estado_consulta NOT NULL DEFAULT 'borrador',
    motivo_anulacion TEXT,
    CHECK (estado <> 'anulada' OR motivo_anulacion IS NOT NULL)
);
CREATE INDEX idx_consultas_paciente ON consultas (paciente_id, fecha DESC);

CREATE TABLE recetas (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    consulta_id  BIGINT NOT NULL REFERENCES consultas(id),
    tipo         TEXT   NOT NULL,                -- 'anteojos', 'lentes_contacto', 'medicacion', 'orden_estudio'
    contenido    JSONB  NOT NULL,
    emitida_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Caja y cobros ----------
CREATE TABLE cajas (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha       DATE   NOT NULL UNIQUE,
    abierta_por BIGINT NOT NULL REFERENCES usuarios(id),
    cerrada_por BIGINT REFERENCES usuarios(id),
    cerrada_at  TIMESTAMPTZ
);

CREATE TABLE pagos (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    caja_id     BIGINT NOT NULL REFERENCES cajas(id),
    turno_id    BIGINT REFERENCES turnos(id),
    paciente_id BIGINT NOT NULL REFERENCES pacientes(id),
    tipo        tipo_cobro NOT NULL,
    medio       medio_pago NOT NULL,
    monto       NUMERIC(12,2) NOT NULL CHECK (monto >= 0),
    anulado     BOOLEAN NOT NULL DEFAULT FALSE,
    creado_por  BIGINT NOT NULL REFERENCES usuarios(id),
    creado_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Recordatorios (WhatsApp) ----------
CREATE TABLE recordatorios (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    turno_id      BIGINT NOT NULL REFERENCES turnos(id),
    canal         TEXT   NOT NULL DEFAULT 'whatsapp',
    programado_para TIMESTAMPTZ NOT NULL,
    enviado_at    TIMESTAMPTZ,
    respuesta     TEXT,                          -- 'confirmo', 'cancelo'
    estado        TEXT NOT NULL DEFAULT 'pendiente'
);
CREATE INDEX idx_recordatorios_pend ON recordatorios (programado_para) WHERE estado = 'pendiente';

-- =====================================================================
-- AUDITORÍA INMUTABLE
-- El backend, al abrir cada transacción, ejecuta:
--   SELECT set_config('app.user_id', '<id del usuario>', true);
-- =====================================================================
CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tabla       TEXT NOT NULL,
    registro_id BIGINT,
    accion      TEXT NOT NULL,                   -- INSERT / UPDATE / DELETE
    usuario_id  BIGINT,
    antes       JSONB,
    despues     JSONB,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tabla_reg ON audit_log (tabla, registro_id);

CREATE FUNCTION audit_row() RETURNS trigger AS $$
DECLARE
    v_antes   JSONB;
    v_despues JSONB;
    v_id      BIGINT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_despues := to_jsonb(NEW);  v_id := NEW.id;
    ELSIF TG_OP = 'UPDATE' THEN
        v_antes := to_jsonb(OLD);    v_despues := to_jsonb(NEW);  v_id := NEW.id;
    ELSE
        v_antes := to_jsonb(OLD);    v_id := OLD.id;
    END IF;

    INSERT INTO audit_log (tabla, registro_id, accion, usuario_id, antes, despues)
    VALUES (TG_TABLE_NAME, v_id, TG_OP,
            NULLIF(current_setting('app.user_id', true), '')::BIGINT,
            v_antes, v_despues);

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- El log no se puede modificar ni borrar
CREATE FUNCTION bloquear_modificacion() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'La tabla % es de solo lectura (% no permitido)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_inmutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- La historia clínica y los pacientes no se borran (se anulan)
CREATE TRIGGER consultas_no_delete BEFORE DELETE ON consultas
    FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER recetas_no_delete BEFORE DELETE ON recetas
    FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();
CREATE TRIGGER pacientes_no_delete BEFORE DELETE ON pacientes
    FOR EACH ROW EXECUTE FUNCTION bloquear_modificacion();

-- Auditoría sobre las tablas sensibles
CREATE TRIGGER audit_pacientes AFTER INSERT OR UPDATE OR DELETE ON pacientes
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_consultas AFTER INSERT OR UPDATE OR DELETE ON consultas
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_recetas AFTER INSERT OR UPDATE OR DELETE ON recetas
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_turnos AFTER INSERT OR UPDATE OR DELETE ON turnos
    FOR EACH ROW EXECUTE FUNCTION audit_row();
CREATE TRIGGER audit_pagos AFTER INSERT OR UPDATE OR DELETE ON pagos
    FOR EACH ROW EXECUTE FUNCTION audit_row();

-- =====================================================================
-- SEED: datos de ejemplo (todo ficticio)
-- =====================================================================
INSERT INTO recursos (nombre) VALUES ('Box 1'), ('OCT'), ('Campímetro'), ('Topógrafo');

INSERT INTO tipos_turno (nombre, duracion_min, recurso_id, precio_particular, color) VALUES
  ('Consulta',            20, 1,    25000, '#2563eb'),
  ('Control postop',      15, 1,    15000, '#16a34a'),
  ('OCT',                 30, 2,    40000, '#9333ea'),
  ('Campo visual',        30, 3,    35000, '#ea580c'),
  ('Topografía corneal',  25, 4,    35000, '#0891b2');

INSERT INTO obras_sociales (nombre) VALUES ('Particular'), ('Obra social provincial (demo)'), ('Obra social nacional (demo)'), ('Prepaga (demo)');

INSERT INTO plantillas_ficha (especialidad, nombre, esquema) VALUES (
  'oftalmologia', 'Consulta oftalmológica general',
  '{
    "secciones": [
      {"id": "motivo", "titulo": "Motivo de consulta",
       "campos": [{"id": "motivo", "tipo": "texto_largo"}]},
      {"id": "agudeza", "titulo": "Agudeza visual",
       "campos": [
         {"id": "av_od_sc", "tipo": "texto", "etiqueta": "OD sin corrección"},
         {"id": "av_oi_sc", "tipo": "texto", "etiqueta": "OI sin corrección"},
         {"id": "av_od_cc", "tipo": "texto", "etiqueta": "OD con corrección"},
         {"id": "av_oi_cc", "tipo": "texto", "etiqueta": "OI con corrección"}]},
      {"id": "refraccion", "titulo": "Refracción",
       "campos": [
         {"id": "ref_od", "tipo": "refraccion", "etiqueta": "OD (esf / cil / eje)"},
         {"id": "ref_oi", "tipo": "refraccion", "etiqueta": "OI (esf / cil / eje)"},
         {"id": "adicion", "tipo": "numero", "etiqueta": "Adición"},
         {"id": "dip", "tipo": "numero", "etiqueta": "DIP (mm)"}]},
      {"id": "pio", "titulo": "Presión intraocular",
       "campos": [
         {"id": "pio_od", "tipo": "numero", "unidad": "mmHg", "etiqueta": "OD"},
         {"id": "pio_oi", "tipo": "numero", "unidad": "mmHg", "etiqueta": "OI"}]},
      {"id": "biomicroscopia", "titulo": "Biomicroscopía",
       "campos": [{"id": "bio_od", "tipo": "texto_largo", "etiqueta": "OD"},
                  {"id": "bio_oi", "tipo": "texto_largo", "etiqueta": "OI"}]},
      {"id": "fondo", "titulo": "Fondo de ojo",
       "campos": [{"id": "fo_od", "tipo": "texto_largo", "etiqueta": "OD"},
                  {"id": "fo_oi", "tipo": "texto_largo", "etiqueta": "OI"}]}
    ]
  }'::jsonb
);
