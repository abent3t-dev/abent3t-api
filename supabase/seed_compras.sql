-- =====================================================
-- SEED DATA PARA MODULO DE COMPRAS
-- Ejecutar despues de la migracion 011_purchase_module.sql
-- =====================================================

-- IMPORTANTE: Necesitas IDs reales de profiles para las FK
-- Primero obtengamos algunos UUIDs de usuarios existentes

-- =====================================================
-- 1. TIPOS DE COMPRA (purchase_types)
-- =====================================================
INSERT INTO purchase_types (name, key, requires_contract, description) VALUES
('Adjudicación Directa', 'adjudicacion_directa', false, 'Compras menores sin proceso de licitación'),
('Licitación Pública', 'licitacion_publica', true, 'Proceso formal de licitación abierta'),
('Invitación Restringida', 'invitacion_restringida', true, 'Invitación a proveedores preseleccionados'),
('Convenio Marco', 'convenio_marco', true, 'Compras bajo acuerdo marco existente'),
('Compra Consolidada', 'compra_consolidada', false, 'Compras agrupadas de múltiples áreas')
ON CONFLICT (key) DO NOTHING;

-- =====================================================
-- 2. DIAS FESTIVOS MEXICO 2026
-- =====================================================
INSERT INTO holidays (holiday_date, description) VALUES
('2026-01-01', 'Año Nuevo'),
('2026-02-02', 'Día de la Constitución'),
('2026-03-16', 'Natalicio de Benito Juárez'),
('2026-04-02', 'Jueves Santo'),
('2026-04-03', 'Viernes Santo'),
('2026-05-01', 'Día del Trabajo'),
('2026-09-16', 'Día de la Independencia'),
('2026-11-02', 'Día de Muertos'),
('2026-11-16', 'Revolución Mexicana'),
('2026-12-25', 'Navidad')
ON CONFLICT (holiday_date) DO NOTHING;

-- =====================================================
-- 3. PROVEEDORES (suppliers)
-- =====================================================
INSERT INTO suppliers (id, legal_name, commercial_name, tax_id, email, phone, address, contact_name, contact_email, contact_phone, performance_score, is_blocked) VALUES
('11111111-1111-1111-1111-111111111111', 'Tecnología Avanzada S.A. de C.V.', 'TecnoAvanza', 'TAV860515ABC', 'ventas@tecnoavanza.com', '55-1234-5678', 'Av. Reforma 123, CDMX', 'Carlos Mendez', 'carlos@tecnoavanza.com', '55-1234-5679', 85, false),
('22222222-2222-2222-2222-222222222222', 'Suministros Industriales del Norte S.A.', 'SumiNorte', 'SIN920310XYZ', 'contacto@suminorte.mx', '81-9876-5432', 'Blvd. Industrial 456, Monterrey', 'Ana García', 'ana@suminorte.mx', '81-9876-5433', 92, false),
('33333333-3333-3333-3333-333333333333', 'Equipos y Maquinaria Global S.A.', 'EquiGlobal', 'EMG880720DEF', 'info@equiglobal.com', '33-5555-1234', 'Calz. del Valle 789, Guadalajara', 'Roberto Sánchez', 'roberto@equiglobal.com', '33-5555-1235', 78, false),
('44444444-4444-4444-4444-444444444444', 'Servicios Profesionales Integrados', 'ServiPro', 'SPI951105GHI', 'servicios@servipro.mx', '55-2222-3333', 'Insurgentes Sur 1500, CDMX', 'María López', 'maria@servipro.mx', '55-2222-3334', 88, false),
('55555555-5555-5555-5555-555555555555', 'Construcciones y Materiales Unidos', 'ConMatU', 'CMU870825JKL', 'ventas@conmatu.com', '222-333-4444', 'Av. 5 de Mayo 200, Puebla', 'Juan Pérez', 'juan@conmatu.com', '222-333-4445', 45, true)
ON CONFLICT (id) DO UPDATE SET
  legal_name = EXCLUDED.legal_name,
  performance_score = EXCLUDED.performance_score;

-- Actualizar blocked_reason para el proveedor bloqueado
UPDATE suppliers SET blocked_reason = 'Incumplimiento en entregas recurrente' WHERE id = '55555555-5555-5555-5555-555555555555';

-- =====================================================
-- 4. REQUISICIONES (requisitions)
-- Necesitamos un profile_id real - usaremos una subconsulta
-- =====================================================

-- Primero creemos una variable temporal con el primer profile encontrado
DO $$
DECLARE
    v_requester_id UUID;
    v_buyer_id UUID;
    v_dept_id UUID;
    v_rq1_id UUID := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    v_rq2_id UUID := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    v_rq3_id UUID := 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    v_rq4_id UUID := 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    v_rq5_id UUID := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    v_rq6_id UUID := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    v_purchase_type_id UUID;
BEGIN
    -- Obtener IDs reales del sistema
    SELECT id INTO v_requester_id FROM profiles WHERE is_active = true LIMIT 1;
    SELECT id INTO v_buyer_id FROM profiles WHERE is_active = true OFFSET 1 LIMIT 1;
    SELECT id INTO v_dept_id FROM departments WHERE is_active = true LIMIT 1;
    SELECT id INTO v_purchase_type_id FROM purchase_types WHERE key = 'adjudicacion_directa' LIMIT 1;

    -- Si no hay buyer, usar el mismo que requester
    IF v_buyer_id IS NULL THEN
        v_buyer_id := v_requester_id;
    END IF;

    -- Insertar requisiciones con diferentes estados
    INSERT INTO requisitions (id, rq_number, description, requester_id, buyer_id, department_id, status, expense_type, source, estimated_amount, justification, created_date, required_date, business_days_elapsed)
    VALUES
    -- En Revisión
    (v_rq1_id, 'RQ-2026-00001', 'Compra de equipos de cómputo para área de desarrollo', v_requester_id, v_buyer_id, v_dept_id, 'en_revision', 'CAPEX', 'manual', 150000.00, 'Renovación de equipos obsoletos para mejorar productividad', '2026-04-01', '2026-04-30', 5),

    -- En Aprobación
    (v_rq2_id, 'RQ-2026-00002', 'Licencias de software especializado', v_requester_id, v_buyer_id, v_dept_id, 'en_aprobacion', 'OPEX', 'manual', 85000.00, 'Licencias anuales de herramientas de diseño', '2026-03-25', '2026-04-15', 10),

    -- Aprobada
    (v_rq3_id, 'RQ-2026-00003', 'Mobiliario de oficina para nueva área', v_requester_id, v_buyer_id, v_dept_id, 'aprobada', 'CAPEX', 'manual', 220000.00, 'Equipamiento de nuevas oficinas planta 3', '2026-03-15', '2026-04-20', 15),

    -- En Progreso (ya tiene PO)
    (v_rq4_id, 'RQ-2026-00004', 'Servicio de mantenimiento preventivo maquinaria', v_requester_id, v_buyer_id, v_dept_id, 'en_progreso', 'OPEX', 'maximo', 45000.00, 'Mantenimiento trimestral de equipos de producción', '2026-03-01', '2026-03-30', 20),

    -- Cerrada
    (v_rq5_id, 'RQ-2026-00005', 'Material de oficina Q1 2026', v_requester_id, v_buyer_id, v_dept_id, 'cerrada', 'OPEX', 'manual', 12500.00, 'Resurtido trimestral de papelería', '2026-01-15', '2026-02-01', 12),

    -- Cancelada
    (v_rq6_id, 'RQ-2026-00006', 'Proyecto de automatización cancelado', v_requester_id, NULL, v_dept_id, 'cancelada', 'CAPEX', 'sap', 500000.00, 'Proyecto pospuesto indefinidamente', '2026-02-01', '2026-06-01', 0)

    ON CONFLICT (id) DO UPDATE SET
      description = EXCLUDED.description,
      status = EXCLUDED.status;

    -- Actualizar closed_date para la cerrada
    UPDATE requisitions SET closed_date = '2026-02-10' WHERE id = v_rq5_id;

    -- =====================================================
    -- 5. ORDENES DE COMPRA (purchase_orders)
    -- =====================================================
    INSERT INTO purchase_orders (id, po_number, requisition_id, supplier_id, purchase_type_id, expense_type, amount, currency, expected_delivery_date, status, buyer_id, notes)
    VALUES
    -- PO para RQ en progreso
    ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'PO-2026-00001', v_rq4_id, '22222222-2222-2222-2222-222222222222', v_purchase_type_id, 'OPEX', 45000.00, 'MXN', '2026-04-15', 'en_transito', v_buyer_id, 'Servicio programado para abril'),

    -- PO para RQ cerrada
    ('b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2', 'PO-2026-00002', v_rq5_id, '11111111-1111-1111-1111-111111111111', v_purchase_type_id, 'OPEX', 12500.00, 'MXN', '2026-02-05', 'entregada_completa', v_buyer_id, 'Entregado en tiempo')

    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status;

    -- Actualizar fecha de entrega real para la PO entregada
    UPDATE purchase_orders SET actual_delivery_date = '2026-02-04' WHERE id = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2';

    -- =====================================================
    -- 6. WORKFLOW DE APROBACIONES
    -- =====================================================
    -- Workflow para RQ en aprobación (nivel 1)
    INSERT INTO approval_workflows (id, requisition_id, current_level, status, started_at)
    VALUES ('w1w1w1w1-w1w1-w1w1-w1w1-w1w1w1w1w1w1', v_rq2_id, 1, 'pendiente', '2026-03-26 10:00:00')
    ON CONFLICT (id) DO NOTHING;

    -- Aprobación nivel 1 pendiente
    INSERT INTO approvals (id, workflow_id, level, approver_id, status)
    VALUES ('ap1ap1ap-1ap1-ap1a-p1ap-1ap1ap1ap1ap', 'w1w1w1w1-w1w1-w1w1-w1w1-w1w1w1w1w1w1', 1, v_requester_id, 'pendiente')
    ON CONFLICT (id) DO NOTHING;

    -- Workflow para RQ aprobada (completó todos los niveles)
    INSERT INTO approval_workflows (id, requisition_id, current_level, status, started_at, completed_at)
    VALUES ('w2w2w2w2-w2w2-w2w2-w2w2-w2w2w2w2w2w2', v_rq3_id, 4, 'aprobado', '2026-03-16 09:00:00', '2026-03-20 15:30:00')
    ON CONFLICT (id) DO NOTHING;

    -- Aprobaciones completadas
    INSERT INTO approvals (id, workflow_id, level, approver_id, status, approved_at, time_to_approve)
    VALUES
    ('ap2ap2ap-2ap2-ap2a-p2ap-2ap2ap2ap2ap', 'w2w2w2w2-w2w2-w2w2-w2w2-w2w2w2w2w2w2', 1, v_requester_id, 'aprobada', '2026-03-17 11:00:00', 1),
    ('ap3ap3ap-3ap3-ap3a-p3ap-3ap3ap3ap3ap', 'w2w2w2w2-w2w2-w2w2-w2w2-w2w2w2w2w2w2', 2, v_requester_id, 'aprobada', '2026-03-18 14:00:00', 1),
    ('ap4ap4ap-4ap4-ap4a-p4ap-4ap4ap4ap4ap', 'w2w2w2w2-w2w2-w2w2-w2w2-w2w2w2w2w2w2', 3, v_requester_id, 'aprobada', '2026-03-19 10:30:00', 1),
    ('ap5ap5ap-5ap5-ap5a-p5ap-5ap5ap5ap5ap', 'w2w2w2w2-w2w2-w2w2-w2w2-w2w2w2w2w2w2', 4, v_requester_id, 'aprobada', '2026-03-20 15:30:00', 1)
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'Seed de compras completado exitosamente';
    RAISE NOTICE 'Requester ID usado: %', v_requester_id;
    RAISE NOTICE 'Department ID usado: %', v_dept_id;

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error en seed: %', SQLERRM;
    RAISE;
END $$;

-- =====================================================
-- 7. HISTORIAL DE CAMBIOS (ejemplo)
-- =====================================================
INSERT INTO requisition_history (requisition_id, field_changed, old_value, new_value, changed_by, changed_at)
SELECT
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'status',
    'en_revision',
    'en_aprobacion',
    (SELECT id FROM profiles WHERE is_active = true LIMIT 1),
    '2026-03-26 09:30:00'
WHERE EXISTS (SELECT 1 FROM requisitions WHERE id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

-- =====================================================
-- VERIFICACION
-- =====================================================
SELECT 'Proveedores:' as tipo, COUNT(*) as total FROM suppliers WHERE is_active = true
UNION ALL
SELECT 'Requisiciones:', COUNT(*) FROM requisitions WHERE is_active = true
UNION ALL
SELECT 'Ordenes de Compra:', COUNT(*) FROM purchase_orders WHERE is_active = true
UNION ALL
SELECT 'Workflows:', COUNT(*) FROM approval_workflows WHERE is_active = true
UNION ALL
SELECT 'Tipos de Compra:', COUNT(*) FROM purchase_types WHERE is_active = true;
