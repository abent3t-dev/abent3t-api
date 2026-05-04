-- Migration: 009_proposal_attachments.sql
-- Feature: Permite adjuntar archivos (documentos del curso) a una propuesta de curso externo
-- Date: 2026-05-04

-- =====================================================
-- TABLA: proposal_attachments
-- Archivos adjuntos por propuesta (uno o varios)
-- =====================================================
CREATE TABLE IF NOT EXISTS proposal_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES course_proposals(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_type VARCHAR(100) NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES profiles(id),
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proposal_attachments_proposal_id
  ON proposal_attachments(proposal_id);

CREATE INDEX IF NOT EXISTS idx_proposal_attachments_active
  ON proposal_attachments(proposal_id, is_active);

-- =====================================================
-- STORAGE BUCKET
-- Crear bucket privado para archivos adjuntos de propuestas
-- =====================================================
-- Ejecutar en el dashboard de Supabase (Storage) o por SQL:
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'proposal-attachments',
  'proposal-attachments',
  false,
  10485760, -- 10MB
  ARRAY[
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO NOTHING;
