-- Migration: 007_audit_logs.sql
-- Feature: A3-21 - Bitácora de auditoría de acciones críticas
-- Date: 2026-03-26

-- Crear enum para tipos de acción
CREATE TYPE audit_action AS ENUM (
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'upload',
  'verify'
);

-- Crear enum para tipos de entidad
CREATE TYPE audit_entity AS ENUM (
  'course',
  'course_edition',
  'enrollment',
  'evidence',
  'budget',
  'request',
  'user'
);

-- Crear tabla de logs de auditoría
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Qué acción se realizó
  action audit_action NOT NULL,

  -- Sobre qué entidad
  entity_type audit_entity NOT NULL,
  entity_id UUID NOT NULL,
  entity_name VARCHAR(255),  -- Nombre descriptivo (ej: nombre del curso)

  -- Quién la realizó
  user_id UUID NOT NULL REFERENCES profiles(id),
  user_name VARCHAR(255),
  user_role VARCHAR(50),

  -- Qué cambió
  old_values JSONB,          -- Valores anteriores (para updates)
  new_values JSONB,          -- Valores nuevos
  description TEXT,          -- Descripción legible de la acción

  -- Contexto
  ip_address VARCHAR(45),
  user_agent TEXT,

  -- Metadatos
  created_at TIMESTAMP DEFAULT now()
);

-- Índices para búsquedas frecuentes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Comentarios
COMMENT ON TABLE audit_logs IS 'Bitácora de acciones críticas del sistema';
COMMENT ON COLUMN audit_logs.old_values IS 'Valores antes del cambio (solo para updates)';
COMMENT ON COLUMN audit_logs.new_values IS 'Valores después del cambio';
COMMENT ON COLUMN audit_logs.description IS 'Descripción legible de la acción realizada';
