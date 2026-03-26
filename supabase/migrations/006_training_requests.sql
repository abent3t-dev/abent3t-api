-- =====================================================
-- Migration: Training Requests Module
-- Módulo de Solicitudes de Capacitación
-- =====================================================

-- Create enum for request status
DO $$ BEGIN
  CREATE TYPE request_status AS ENUM ('pendiente', 'aprobada', 'rechazada');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create training_requests table
CREATE TABLE IF NOT EXISTS training_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What course/edition is being requested
  course_edition_id UUID NOT NULL REFERENCES course_editions(id),

  -- Who is being enrolled (the collaborator)
  profile_id UUID NOT NULL REFERENCES profiles(id),

  -- Who made the request (jefe_area)
  requested_by UUID NOT NULL REFERENCES profiles(id),

  -- Request status
  status request_status DEFAULT 'pendiente',

  -- Optional: reason for the request
  request_reason TEXT,

  -- Approval/Rejection info
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMP,
  rejection_reason TEXT,

  -- If approved, link to the created enrollment
  enrollment_id UUID REFERENCES course_enrollments(id),

  -- Soft delete
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),

  -- Prevent duplicate requests for same person + edition
  UNIQUE(course_edition_id, profile_id, is_active)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_training_requests_status
  ON training_requests(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_training_requests_requested_by
  ON training_requests(requested_by) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_training_requests_profile
  ON training_requests(profile_id) WHERE is_active = true;

-- Add comments for documentation
COMMENT ON TABLE training_requests IS
  'Training requests made by jefe_area for their team members.
   Flow: jefe_area creates request → admin_rh reviews → approve/reject';

COMMENT ON COLUMN training_requests.requested_by IS
  'The jefe_area who submitted the request';

COMMENT ON COLUMN training_requests.profile_id IS
  'The collaborator who will be enrolled if approved';

COMMENT ON COLUMN training_requests.enrollment_id IS
  'Reference to the enrollment created upon approval';

-- =====================================================
-- RLS Policies (optional, if using Supabase RLS)
-- =====================================================

-- Enable RLS
ALTER TABLE training_requests ENABLE ROW LEVEL SECURITY;

-- Policy: jefe_area can see requests they created
CREATE POLICY "jefe_area_own_requests" ON training_requests
  FOR SELECT
  USING (requested_by = auth.uid());

-- Policy: admin_rh and super_admin can see all requests
CREATE POLICY "admin_all_requests" ON training_requests
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE id = auth.uid()
      AND role IN ('admin_rh', 'super_admin')
    )
  );

-- =====================================================
-- Notes:
--
-- Validation rules (enforced in backend):
-- 1. jefe_area can only request for profiles in THEIR department
-- 2. Cannot request if collaborator already enrolled in that edition
-- 3. Cannot request if there's already a pending request
-- 4. On approval: create enrollment and update budget
-- 5. On rejection: store reason for feedback
-- =====================================================
