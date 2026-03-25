-- =============================================
-- TABLA: enrollment_evidences
-- Almacena evidencias/certificados de cursos
-- =============================================

-- Crear tipo enum para tipo de evidencia
DO $$ BEGIN
    CREATE TYPE evidence_type AS ENUM ('certificate', 'attendance', 'assessment', 'other');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Crear tipo enum para estado de verificación
DO $$ BEGIN
    CREATE TYPE verification_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Crear tabla de evidencias
CREATE TABLE IF NOT EXISTS enrollment_evidences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relación con inscripción
    enrollment_id UUID NOT NULL REFERENCES course_enrollments(id) ON DELETE CASCADE,

    -- Información del archivo
    file_name VARCHAR(255) NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    file_type VARCHAR(100) NOT NULL,

    -- Tipo de evidencia
    evidence_type evidence_type NOT NULL DEFAULT 'certificate',

    -- Quien subió
    uploaded_by UUID NOT NULL REFERENCES profiles(id),
    uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Validación
    verification_status verification_status NOT NULL DEFAULT 'pending',
    verified_by UUID REFERENCES profiles(id),
    verified_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,

    -- Observaciones
    notes TEXT,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_evidences_enrollment ON enrollment_evidences(enrollment_id);
CREATE INDEX IF NOT EXISTS idx_evidences_status ON enrollment_evidences(verification_status) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_evidences_uploaded_by ON enrollment_evidences(uploaded_by);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_evidence_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_evidence_timestamp ON enrollment_evidences;
CREATE TRIGGER trigger_update_evidence_timestamp
    BEFORE UPDATE ON enrollment_evidences
    FOR EACH ROW
    EXECUTE FUNCTION update_evidence_timestamp();

-- RLS (Row Level Security)
ALTER TABLE enrollment_evidences ENABLE ROW LEVEL SECURITY;

-- Política: super_admin y admin_rh pueden ver todas las evidencias
CREATE POLICY "Admin can view all evidences" ON enrollment_evidences
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- Política: Colaboradores pueden ver sus propias evidencias
CREATE POLICY "Users can view own evidences" ON enrollment_evidences
    FOR SELECT
    USING (
        uploaded_by = auth.uid()
        OR EXISTS (
            SELECT 1 FROM course_enrollments ce
            WHERE ce.id = enrollment_evidences.enrollment_id
            AND ce.profile_id = auth.uid()
        )
    );

-- Política: Colaboradores pueden subir sus propias evidencias
CREATE POLICY "Users can insert own evidences" ON enrollment_evidences
    FOR INSERT
    WITH CHECK (
        uploaded_by = auth.uid()
        AND EXISTS (
            SELECT 1 FROM course_enrollments ce
            WHERE ce.id = enrollment_id
            AND ce.profile_id = auth.uid()
            AND ce.is_active = true
        )
    );

-- Política: Admin puede insertar/actualizar cualquier evidencia
CREATE POLICY "Admin can manage all evidences" ON enrollment_evidences
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- =============================================
-- STORAGE: Bucket para evidencias
-- =============================================
-- Ejecutar en Supabase Dashboard > Storage > Create bucket
-- Nombre: evidences
-- Public: false
-- File size limit: 10MB
-- Allowed MIME types: application/pdf, image/jpeg, image/png,
--                     application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
--                     application/vnd.ms-excel,
--                     application/msword,
--                     application/vnd.openxmlformats-officedocument.wordprocessingml.document

-- Storage policies (ejecutar en SQL Editor después de crear el bucket):
/*
-- Política: Usuarios autenticados pueden subir archivos
CREATE POLICY "Authenticated users can upload evidences"
ON storage.objects FOR INSERT
WITH CHECK (
    bucket_id = 'evidences'
    AND auth.role() = 'authenticated'
);

-- Política: Usuarios pueden ver sus propios archivos o admins pueden ver todos
CREATE POLICY "Users can view evidences"
ON storage.objects FOR SELECT
USING (
    bucket_id = 'evidences'
    AND (
        auth.uid()::text = (storage.foldername(name))[1]
        OR EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    )
);
*/

COMMENT ON TABLE enrollment_evidences IS 'Almacena evidencias y certificados de cursos completados';
