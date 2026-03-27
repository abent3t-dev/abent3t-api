-- =====================================================
-- Migration: Course Proposals Module
-- Módulo de Propuestas de Cursos Externos
-- =====================================================

-- Create enum for proposal status
DO $$ BEGIN
  CREATE TYPE proposal_status AS ENUM ('pendiente', 'en_investigacion', 'aprobada', 'rechazada');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create course_proposals table
CREATE TABLE IF NOT EXISTS course_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who is proposing the course
  proposed_by UUID NOT NULL REFERENCES profiles(id),

  -- Who will take the course (can be same as proposed_by or a team member)
  profile_id UUID NOT NULL REFERENCES profiles(id),

  -- Proposed course details
  course_name VARCHAR(255) NOT NULL,
  institution_name VARCHAR(255),
  course_url TEXT,
  estimated_cost NUMERIC DEFAULT 0,
  estimated_hours INT DEFAULT 0,
  modality VARCHAR(50),  -- presencial, virtual, hibrido
  start_date DATE,
  end_date DATE,

  -- Justification/reason for the proposal
  justification TEXT,

  -- Proposal status
  status proposal_status DEFAULT 'pendiente',

  -- Review info (by admin_rh)
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMP,
  review_notes TEXT,
  rejection_reason TEXT,

  -- If approved, references to created entities
  course_id UUID REFERENCES courses(id),
  course_edition_id UUID REFERENCES course_editions(id),
  enrollment_id UUID REFERENCES course_enrollments(id),

  -- Soft delete
  is_active BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_course_proposals_status
  ON course_proposals(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_course_proposals_proposed_by
  ON course_proposals(proposed_by) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_course_proposals_profile
  ON course_proposals(profile_id) WHERE is_active = true;

-- Add comments for documentation
COMMENT ON TABLE course_proposals IS
  'Proposals for external courses not yet in the system.
   Flow: colaborador/jefe_area proposes → admin_rh investigates → approve (create course + enroll) / reject';

COMMENT ON COLUMN course_proposals.proposed_by IS
  'The user who submitted the proposal (colaborador or jefe_area)';

COMMENT ON COLUMN course_proposals.profile_id IS
  'The collaborator who will be enrolled if approved';

COMMENT ON COLUMN course_proposals.status IS
  'pendiente: awaiting review, en_investigacion: admin is researching, aprobada: course created, rechazada: not viable';

-- =====================================================
-- RLS Policies
-- =====================================================

-- Enable RLS
ALTER TABLE course_proposals ENABLE ROW LEVEL SECURITY;

-- Policy: Users can see proposals they created
CREATE POLICY "users_own_proposals" ON course_proposals
  FOR SELECT
  USING (proposed_by = auth.uid() OR profile_id = auth.uid());

-- Policy: Users can create proposals
CREATE POLICY "users_create_proposals" ON course_proposals
  FOR INSERT
  WITH CHECK (proposed_by = auth.uid());

-- Policy: admin_rh and super_admin can see and manage all proposals
CREATE POLICY "admin_all_proposals" ON course_proposals
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
-- Workflow:
-- 1. Colaborador/jefe_area proposes a course they found
-- 2. admin_rh sees proposal in their dashboard
-- 3. admin_rh can mark as "en_investigacion" while researching
-- 4. If viable: admin_rh creates course, edition, enrolls the person
-- 5. If not viable: admin_rh rejects with reason
--
-- Validation rules (enforced in backend):
-- 1. jefe_area can propose for their team members
-- 2. colaborador can only propose for themselves
-- 3. Cannot have duplicate pending proposals for same person/course
-- =====================================================
