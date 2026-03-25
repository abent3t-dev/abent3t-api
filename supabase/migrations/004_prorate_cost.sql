-- =====================================================
-- Migration: Add prorate_cost to course_editions
-- Task: A3-16 - Prorrateo automático de costos
-- =====================================================

-- Add prorate_cost field to course_editions
-- When true: course cost is divided among all participants
-- When false (default): each enrollment consumes the full course cost
ALTER TABLE course_editions
ADD COLUMN IF NOT EXISTS prorate_cost BOOLEAN DEFAULT false;

-- Add comment for documentation
COMMENT ON COLUMN course_editions.prorate_cost IS
  'If true, course cost is prorated (divided) among all enrolled participants.
   Each department pays: (course_cost / total_participants) * participants_from_department';

-- =====================================================
-- Example:
-- Course cost: $10,000
-- 5 participants (3 from IT, 2 from Sales)
--
-- If prorate_cost = false (default):
--   IT pays: $30,000 (3 x $10,000)
--   Sales pays: $20,000 (2 x $10,000)
--
-- If prorate_cost = true:
--   Cost per person: $2,000
--   IT pays: $6,000 (3 x $2,000)
--   Sales pays: $4,000 (2 x $2,000)
-- =====================================================
