-- =====================================================
-- Migration: Add 'proposal' to audit_entity enum
-- =====================================================

-- Add 'proposal' value to audit_entity enum if it doesn't exist
DO $$ BEGIN
  ALTER TYPE audit_entity ADD VALUE IF NOT EXISTS 'proposal';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
