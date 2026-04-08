-- =====================================================
-- Migration: Purchase Module - Phase 1 MVP
-- Módulo de Compras/Adquisiciones
-- =====================================================
-- Tablas incluidas:
-- 1. purchase_types (Catálogo de tipos de gestión)
-- 2. holidays (Días festivos para cálculo de días hábiles)
-- 3. suppliers (Proveedores)
-- 4. requisitions (Solicitudes de compra - RQ)
-- 5. requisition_history (Historial de cambios de RQ)
-- 6. approval_workflows (Workflow de aprobaciones)
-- 7. approvals (Aprobaciones individuales por nivel)
-- 8. purchase_orders (Órdenes de compra - PEO)
-- =====================================================

-- =====================================================
-- SECTION 1: ENUM TYPES
-- =====================================================

-- Enum para estados de requisición
DO $$ BEGIN
    CREATE TYPE requisition_status AS ENUM (
        'en_revision',      -- Comprador revisando
        'en_aprobacion',    -- En flujo de aprobación
        'aprobada',         -- Aprobada, lista para OC
        'en_progreso',      -- OC emitida, en proceso
        'cerrada',          -- Completada
        'cancelada'         -- Cancelada
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum para estado del workflow de aprobación
DO $$ BEGIN
    CREATE TYPE approval_workflow_status AS ENUM (
        'pendiente',        -- En proceso de aprobación
        'aprobada',         -- Todos los niveles aprobaron
        'rechazada'         -- Algún nivel rechazó
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum para estado de aprobación individual
DO $$ BEGIN
    CREATE TYPE approval_status AS ENUM (
        'pendiente',        -- Esperando decisión
        'aprobada',         -- Aprobada por el nivel
        'rechazada'         -- Rechazada por el nivel
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum para tipo de gasto
DO $$ BEGIN
    CREATE TYPE expense_type AS ENUM (
        'CAPEX',            -- Inversión de capital
        'OPEX'              -- Gasto operativo
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Enum para estado de orden de compra
DO $$ BEGIN
    CREATE TYPE po_status AS ENUM (
        'emitida',              -- OC emitida al proveedor
        'en_transito',          -- Mercancía en camino
        'entregada_parcial',    -- Entrega parcial recibida
        'entregada_completa',   -- Entrega completa
        'cancelada'             -- OC cancelada
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- =====================================================
-- SECTION 2: CATALOG TABLES
-- =====================================================

-- -----------------------------------------------------
-- Table: purchase_types
-- Catálogo de tipos de gestión de compra
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identificación
    name VARCHAR(100) NOT NULL,
    key VARCHAR(50) NOT NULL,

    -- Configuración
    requires_contract BOOLEAN DEFAULT false,
    description TEXT,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT purchase_types_name_key UNIQUE (name),
    CONSTRAINT purchase_types_key_key UNIQUE (key)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_purchase_types_active
    ON purchase_types(is_active) WHERE is_active = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_purchase_types_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_purchase_types_timestamp ON purchase_types;
CREATE TRIGGER trigger_update_purchase_types_timestamp
    BEFORE UPDATE ON purchase_types
    FOR EACH ROW
    EXECUTE FUNCTION update_purchase_types_timestamp();

-- Comentarios
COMMENT ON TABLE purchase_types IS 'Catálogo de tipos de gestión de compra (Adjudicación Directa, Licitación, etc.)';
COMMENT ON COLUMN purchase_types.requires_contract IS 'Indica si este tipo de compra requiere contrato formal';

-- -----------------------------------------------------
-- Table: holidays
-- Días festivos para cálculo de días hábiles
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS holidays (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Datos del festivo
    holiday_date DATE NOT NULL,
    description VARCHAR(255) NOT NULL,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT holidays_date_key UNIQUE (holiday_date)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_holidays_date
    ON holidays(holiday_date) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_holidays_year
    ON holidays(EXTRACT(YEAR FROM holiday_date)) WHERE is_active = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_holidays_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_holidays_timestamp ON holidays;
CREATE TRIGGER trigger_update_holidays_timestamp
    BEFORE UPDATE ON holidays
    FOR EACH ROW
    EXECUTE FUNCTION update_holidays_timestamp();

-- Comentarios
COMMENT ON TABLE holidays IS 'Días festivos oficiales para cálculo de días hábiles en requisiciones';

-- =====================================================
-- SECTION 3: SUPPLIERS TABLE
-- =====================================================

-- -----------------------------------------------------
-- Table: suppliers
-- Proveedores
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Información legal
    legal_name VARCHAR(255) NOT NULL,
    commercial_name VARCHAR(255),
    tax_id VARCHAR(20) NOT NULL,               -- RFC en México

    -- Contacto general
    email VARCHAR(255),
    phone VARCHAR(50),
    address TEXT,

    -- Contacto específico
    contact_name VARCHAR(255),
    contact_email VARCHAR(255),
    contact_phone VARCHAR(50),

    -- Evaluación
    performance_score NUMERIC(5,2) DEFAULT 0,   -- 0-100

    -- Bloqueo
    is_blocked BOOLEAN DEFAULT false,
    blocked_reason TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE,
    blocked_by UUID REFERENCES profiles(id),

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT suppliers_tax_id_key UNIQUE (tax_id),
    CONSTRAINT suppliers_performance_score_check CHECK (performance_score >= 0 AND performance_score <= 100)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_suppliers_active
    ON suppliers(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_suppliers_tax_id
    ON suppliers(tax_id);

CREATE INDEX IF NOT EXISTS idx_suppliers_legal_name
    ON suppliers(legal_name);

CREATE INDEX IF NOT EXISTS idx_suppliers_blocked
    ON suppliers(is_blocked) WHERE is_blocked = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_suppliers_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_suppliers_timestamp ON suppliers;
CREATE TRIGGER trigger_update_suppliers_timestamp
    BEFORE UPDATE ON suppliers
    FOR EACH ROW
    EXECUTE FUNCTION update_suppliers_timestamp();

-- Comentarios
COMMENT ON TABLE suppliers IS 'Catálogo de proveedores con información fiscal y de contacto';
COMMENT ON COLUMN suppliers.tax_id IS 'RFC del proveedor (México)';
COMMENT ON COLUMN suppliers.performance_score IS 'Calificación de desempeño del proveedor (0-100)';

-- =====================================================
-- SECTION 4: REQUISITIONS TABLE
-- =====================================================

-- -----------------------------------------------------
-- Table: requisitions
-- Solicitudes de compra (RQ)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identificación
    rq_number VARCHAR(50) NOT NULL,

    -- Descripción
    description TEXT NOT NULL,
    justification TEXT,

    -- Relaciones
    requester_id UUID NOT NULL REFERENCES profiles(id),
    department_id UUID REFERENCES departments(id),
    buyer_id UUID REFERENCES profiles(id),

    -- Estado y tipo
    status requisition_status DEFAULT 'en_revision',
    expense_type expense_type DEFAULT 'OPEX',

    -- Origen de la requisición
    source VARCHAR(20) DEFAULT 'manual',        -- manual, maximo, sap
    external_id VARCHAR(100),                   -- ID del sistema externo

    -- Montos
    estimated_amount NUMERIC(15,2) DEFAULT 0,

    -- Fechas
    created_date DATE NOT NULL DEFAULT CURRENT_DATE,
    required_date DATE,
    closed_date DATE,

    -- Métricas
    business_days_elapsed INTEGER DEFAULT 0,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT requisitions_rq_number_key UNIQUE (rq_number),
    CONSTRAINT requisitions_source_check CHECK (source IN ('manual', 'maximo', 'sap'))
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_requisitions_active
    ON requisitions(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_status
    ON requisitions(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_requester
    ON requisitions(requester_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_buyer
    ON requisitions(buyer_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_department
    ON requisitions(department_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_rq_number
    ON requisitions(rq_number);

CREATE INDEX IF NOT EXISTS idx_requisitions_created_date
    ON requisitions(created_date) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_requisitions_source
    ON requisitions(source) WHERE is_active = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_requisitions_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_requisitions_timestamp ON requisitions;
CREATE TRIGGER trigger_update_requisitions_timestamp
    BEFORE UPDATE ON requisitions
    FOR EACH ROW
    EXECUTE FUNCTION update_requisitions_timestamp();

-- Comentarios
COMMENT ON TABLE requisitions IS 'Solicitudes de compra (Requisiciones) del sistema de adquisiciones';
COMMENT ON COLUMN requisitions.rq_number IS 'Número único de requisición (ej: RQ-2026-0001)';
COMMENT ON COLUMN requisitions.source IS 'Origen de la requisición: manual (portal), maximo (ERP), sap (SAP)';
COMMENT ON COLUMN requisitions.external_id IS 'ID de referencia en sistema externo (Máximo/SAP)';
COMMENT ON COLUMN requisitions.business_days_elapsed IS 'Días hábiles transcurridos desde creación';

-- =====================================================
-- SECTION 5: REQUISITION HISTORY TABLE
-- =====================================================

-- -----------------------------------------------------
-- Table: requisition_history
-- Historial de cambios en requisiciones
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS requisition_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relación con requisición
    requisition_id UUID NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,

    -- Cambio realizado
    field_changed VARCHAR(100) NOT NULL,
    old_value TEXT,
    new_value TEXT,

    -- Quien hizo el cambio
    changed_by UUID NOT NULL REFERENCES profiles(id),
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_requisition_history_requisition
    ON requisition_history(requisition_id);

CREATE INDEX IF NOT EXISTS idx_requisition_history_changed_by
    ON requisition_history(changed_by);

CREATE INDEX IF NOT EXISTS idx_requisition_history_changed_at
    ON requisition_history(changed_at);

-- Comentarios
COMMENT ON TABLE requisition_history IS 'Bitácora de cambios en requisiciones para auditoría';

-- =====================================================
-- SECTION 6: APPROVAL WORKFLOW TABLES
-- =====================================================

-- -----------------------------------------------------
-- Table: approval_workflows
-- Workflow de aprobaciones por requisición
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS approval_workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relación con requisición (1:1)
    requisition_id UUID NOT NULL REFERENCES requisitions(id) ON DELETE CASCADE,

    -- Estado del workflow
    current_level INTEGER DEFAULT 1,
    status approval_workflow_status DEFAULT 'pendiente',

    -- Timestamps del workflow
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT approval_workflows_requisition_key UNIQUE (requisition_id)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_approval_workflows_active
    ON approval_workflows(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_approval_workflows_status
    ON approval_workflows(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_approval_workflows_current_level
    ON approval_workflows(current_level) WHERE is_active = true AND status = 'pendiente';

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_approval_workflows_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_approval_workflows_timestamp ON approval_workflows;
CREATE TRIGGER trigger_update_approval_workflows_timestamp
    BEFORE UPDATE ON approval_workflows
    FOR EACH ROW
    EXECUTE FUNCTION update_approval_workflows_timestamp();

-- Comentarios
COMMENT ON TABLE approval_workflows IS 'Control del flujo de aprobación de requisiciones';
COMMENT ON COLUMN approval_workflows.current_level IS 'Nivel actual de aprobación (1-4)';

-- -----------------------------------------------------
-- Table: approvals
-- Aprobaciones individuales por nivel
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Relación con workflow
    workflow_id UUID NOT NULL REFERENCES approval_workflows(id) ON DELETE CASCADE,

    -- Nivel y aprobador
    level INTEGER NOT NULL,
    approver_id UUID NOT NULL REFERENCES profiles(id),

    -- Estado de la aprobación
    status approval_status DEFAULT 'pendiente',
    comments TEXT,

    -- Timestamps de decisión
    approved_at TIMESTAMP WITH TIME ZONE,
    rejected_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,

    -- Métricas
    time_to_approve INTEGER,                    -- Días hábiles para aprobar
    notified_at TIMESTAMP WITH TIME ZONE,

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT approvals_level_check CHECK (level >= 1 AND level <= 4),
    CONSTRAINT approvals_workflow_level_key UNIQUE (workflow_id, level)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_approvals_active
    ON approvals(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_approvals_workflow
    ON approvals(workflow_id);

CREATE INDEX IF NOT EXISTS idx_approvals_approver
    ON approvals(approver_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_approvals_status
    ON approvals(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON approvals(approver_id, status) WHERE is_active = true AND status = 'pendiente';

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_approvals_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_approvals_timestamp ON approvals;
CREATE TRIGGER trigger_update_approvals_timestamp
    BEFORE UPDATE ON approvals
    FOR EACH ROW
    EXECUTE FUNCTION update_approvals_timestamp();

-- Comentarios
COMMENT ON TABLE approvals IS 'Aprobaciones individuales por nivel en el workflow';
COMMENT ON COLUMN approvals.level IS 'Nivel de aprobación (1=Jefe Directo, 2=Director, 3=VP, 4=CEO)';
COMMENT ON COLUMN approvals.time_to_approve IS 'Días hábiles que tomó aprobar/rechazar';

-- =====================================================
-- SECTION 7: PURCHASE ORDERS TABLE
-- =====================================================

-- -----------------------------------------------------
-- Table: purchase_orders
-- Órdenes de compra (PEO)
-- -----------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Identificación
    po_number VARCHAR(50) NOT NULL,

    -- Relaciones
    requisition_id UUID NOT NULL REFERENCES requisitions(id),
    supplier_id UUID NOT NULL REFERENCES suppliers(id),
    purchase_type_id UUID NOT NULL REFERENCES purchase_types(id),
    buyer_id UUID NOT NULL REFERENCES profiles(id),

    -- Datos de la OC
    amount NUMERIC(15,2) NOT NULL,
    expense_type expense_type DEFAULT 'OPEX',
    description TEXT,
    notes TEXT,

    -- Fechas de entrega
    expected_delivery_date DATE,
    actual_delivery_date DATE,

    -- Estado
    status po_status DEFAULT 'emitida',

    -- Soft delete
    is_active BOOLEAN DEFAULT true,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT purchase_orders_po_number_key UNIQUE (po_number)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_purchase_orders_active
    ON purchase_orders(is_active) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
    ON purchase_orders(status) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_requisition
    ON purchase_orders(requisition_id);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier
    ON purchase_orders(supplier_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_buyer
    ON purchase_orders(buyer_id) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_po_number
    ON purchase_orders(po_number);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_expense_type
    ON purchase_orders(expense_type) WHERE is_active = true;

-- Trigger para updated_at
CREATE OR REPLACE FUNCTION update_purchase_orders_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_purchase_orders_timestamp ON purchase_orders;
CREATE TRIGGER trigger_update_purchase_orders_timestamp
    BEFORE UPDATE ON purchase_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_purchase_orders_timestamp();

-- Comentarios
COMMENT ON TABLE purchase_orders IS 'Órdenes de compra emitidas a proveedores';
COMMENT ON COLUMN purchase_orders.po_number IS 'Número único de orden de compra (ej: PO-2026-0001)';

-- =====================================================
-- SECTION 8: ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Habilitar RLS en todas las tablas
ALTER TABLE purchase_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisition_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------
-- Políticas para purchase_types (solo lectura para todos)
-- -----------------------------------------------------
CREATE POLICY "Anyone can view active purchase_types" ON purchase_types
    FOR SELECT
    USING (is_active = true);

CREATE POLICY "Admin can manage purchase_types" ON purchase_types
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para holidays (solo lectura para todos)
-- -----------------------------------------------------
CREATE POLICY "Anyone can view active holidays" ON holidays
    FOR SELECT
    USING (is_active = true);

CREATE POLICY "Admin can manage holidays" ON holidays
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para suppliers
-- -----------------------------------------------------
CREATE POLICY "Authenticated users can view active suppliers" ON suppliers
    FOR SELECT
    USING (is_active = true);

CREATE POLICY "Admin can manage suppliers" ON suppliers
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para requisitions
-- -----------------------------------------------------
CREATE POLICY "Users can view own requisitions" ON requisitions
    FOR SELECT
    USING (
        requester_id = auth.uid()
        OR buyer_id = auth.uid()
    );

CREATE POLICY "Admin can view all requisitions" ON requisitions
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

CREATE POLICY "Authenticated users can create requisitions" ON requisitions
    FOR INSERT
    WITH CHECK (requester_id = auth.uid());

CREATE POLICY "Admin can manage all requisitions" ON requisitions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para requisition_history
-- -----------------------------------------------------
CREATE POLICY "Users can view history of own requisitions" ON requisition_history
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM requisitions r
            WHERE r.id = requisition_history.requisition_id
            AND (r.requester_id = auth.uid() OR r.buyer_id = auth.uid())
        )
    );

CREATE POLICY "Admin can view all requisition history" ON requisition_history
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para approval_workflows
-- -----------------------------------------------------
CREATE POLICY "Users can view workflows of own requisitions" ON approval_workflows
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM requisitions r
            WHERE r.id = approval_workflows.requisition_id
            AND (r.requester_id = auth.uid() OR r.buyer_id = auth.uid())
        )
    );

CREATE POLICY "Admin can manage all workflows" ON approval_workflows
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para approvals
-- -----------------------------------------------------
CREATE POLICY "Approvers can view and manage their approvals" ON approvals
    FOR ALL
    USING (approver_id = auth.uid());

CREATE POLICY "Admin can manage all approvals" ON approvals
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- -----------------------------------------------------
-- Políticas para purchase_orders
-- -----------------------------------------------------
CREATE POLICY "Buyers can view their purchase orders" ON purchase_orders
    FOR SELECT
    USING (buyer_id = auth.uid());

CREATE POLICY "Admin can manage all purchase orders" ON purchase_orders
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('super_admin', 'admin_rh')
        )
    );

-- =====================================================
-- SECTION 9: INITIAL DATA - CATALOGS
-- =====================================================

-- -----------------------------------------------------
-- Datos iniciales: purchase_types
-- -----------------------------------------------------
INSERT INTO purchase_types (name, key, requires_contract, description) VALUES
    ('Adjudicación Directa', 'adjudicacion_directa', false, 'Compra directa a un proveedor único por monto o urgencia'),
    ('Invitación a 3', 'invitacion_3', false, 'Comparación de al menos 3 proveedores'),
    ('Licitación Pública', 'licitacion_publica', true, 'Proceso abierto de licitación con requisitos formales'),
    ('Licitación Privada', 'licitacion_privada', true, 'Licitación con invitación a proveedores seleccionados'),
    ('Contrato Marco', 'contrato_marco', true, 'Compra bajo contrato marco existente'),
    ('Compra Recurrente', 'compra_recurrente', false, 'Compras programadas de artículos de uso frecuente'),
    ('Urgencia', 'urgencia', false, 'Compra de emergencia con proceso simplificado')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------
-- Datos iniciales: holidays (México 2026)
-- -----------------------------------------------------
INSERT INTO holidays (holiday_date, description) VALUES
    -- 2026
    ('2026-01-01', 'Año Nuevo'),
    ('2026-02-02', 'Día de la Constitución (observado)'),
    ('2026-03-16', 'Natalicio de Benito Juárez (observado)'),
    ('2026-04-02', 'Jueves Santo'),
    ('2026-04-03', 'Viernes Santo'),
    ('2026-05-01', 'Día del Trabajo'),
    ('2026-09-16', 'Día de la Independencia'),
    ('2026-11-16', 'Revolución Mexicana (observado)'),
    ('2026-12-25', 'Navidad'),
    -- 2027
    ('2027-01-01', 'Año Nuevo'),
    ('2027-02-01', 'Día de la Constitución (observado)'),
    ('2027-03-15', 'Natalicio de Benito Juárez (observado)'),
    ('2027-03-25', 'Jueves Santo'),
    ('2027-03-26', 'Viernes Santo'),
    ('2027-05-01', 'Día del Trabajo'),
    ('2027-09-16', 'Día de la Independencia'),
    ('2027-11-15', 'Revolución Mexicana (observado)'),
    ('2027-12-25', 'Navidad')
ON CONFLICT (holiday_date) DO NOTHING;

-- =====================================================
-- SECTION 10: HELPER FUNCTIONS
-- =====================================================

-- -----------------------------------------------------
-- Función: Calcular días hábiles entre dos fechas
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_business_days(
    start_date DATE,
    end_date DATE
) RETURNS INTEGER AS $$
DECLARE
    total_days INTEGER := 0;
    current_date_iter DATE := start_date;
BEGIN
    WHILE current_date_iter <= end_date LOOP
        -- Excluir fines de semana (0=domingo, 6=sábado)
        IF EXTRACT(DOW FROM current_date_iter) NOT IN (0, 6) THEN
            -- Excluir días festivos
            IF NOT EXISTS (
                SELECT 1 FROM holidays
                WHERE holiday_date = current_date_iter
                AND is_active = true
            ) THEN
                total_days := total_days + 1;
            END IF;
        END IF;
        current_date_iter := current_date_iter + 1;
    END LOOP;

    RETURN total_days;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION calculate_business_days IS 'Calcula días hábiles entre dos fechas excluyendo fines de semana y festivos';

-- -----------------------------------------------------
-- Función: Generar número de requisición
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION generate_rq_number() RETURNS VARCHAR AS $$
DECLARE
    current_year VARCHAR(4);
    next_seq INTEGER;
    new_rq_number VARCHAR(50);
BEGIN
    current_year := TO_CHAR(CURRENT_DATE, 'YYYY');

    -- Obtener el siguiente número secuencial del año
    SELECT COALESCE(MAX(
        CAST(SPLIT_PART(rq_number, '-', 3) AS INTEGER)
    ), 0) + 1
    INTO next_seq
    FROM requisitions
    WHERE rq_number LIKE 'RQ-' || current_year || '-%';

    new_rq_number := 'RQ-' || current_year || '-' || LPAD(next_seq::TEXT, 5, '0');

    RETURN new_rq_number;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_rq_number IS 'Genera número secuencial de requisición (RQ-YYYY-NNNNN)';

-- -----------------------------------------------------
-- Función: Generar número de orden de compra
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION generate_po_number() RETURNS VARCHAR AS $$
DECLARE
    current_year VARCHAR(4);
    next_seq INTEGER;
    new_po_number VARCHAR(50);
BEGIN
    current_year := TO_CHAR(CURRENT_DATE, 'YYYY');

    -- Obtener el siguiente número secuencial del año
    SELECT COALESCE(MAX(
        CAST(SPLIT_PART(po_number, '-', 3) AS INTEGER)
    ), 0) + 1
    INTO next_seq
    FROM purchase_orders
    WHERE po_number LIKE 'PO-' || current_year || '-%';

    new_po_number := 'PO-' || current_year || '-' || LPAD(next_seq::TEXT, 5, '0');

    RETURN new_po_number;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION generate_po_number IS 'Genera número secuencial de orden de compra (PO-YYYY-NNNNN)';

-- =====================================================
-- SECTION 11: AUTOMATIC TRIGGERS
-- =====================================================

-- -----------------------------------------------------
-- Trigger: Auto-generar rq_number si no se proporciona
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_rq_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.rq_number IS NULL OR NEW.rq_number = '' THEN
        NEW.rq_number := generate_rq_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_generate_rq_number ON requisitions;
CREATE TRIGGER trigger_auto_generate_rq_number
    BEFORE INSERT ON requisitions
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_rq_number();

-- -----------------------------------------------------
-- Trigger: Auto-generar po_number si no se proporciona
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_po_number()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.po_number IS NULL OR NEW.po_number = '' THEN
        NEW.po_number := generate_po_number();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_auto_generate_po_number ON purchase_orders;
CREATE TRIGGER trigger_auto_generate_po_number
    BEFORE INSERT ON purchase_orders
    FOR EACH ROW
    EXECUTE FUNCTION auto_generate_po_number();

-- -----------------------------------------------------
-- Trigger: Registrar cambios en requisition_history
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION log_requisition_changes()
RETURNS TRIGGER AS $$
DECLARE
    changed_by_id UUID;
BEGIN
    -- Intentar obtener el usuario actual de auth.uid()
    changed_by_id := auth.uid();

    -- Si no hay usuario (operación de sistema), usar el buyer_id o requester_id
    IF changed_by_id IS NULL THEN
        changed_by_id := COALESCE(NEW.buyer_id, NEW.requester_id);
    END IF;

    -- Registrar cambio de status
    IF OLD.status IS DISTINCT FROM NEW.status THEN
        INSERT INTO requisition_history (requisition_id, field_changed, old_value, new_value, changed_by)
        VALUES (NEW.id, 'status', OLD.status::TEXT, NEW.status::TEXT, changed_by_id);
    END IF;

    -- Registrar cambio de buyer
    IF OLD.buyer_id IS DISTINCT FROM NEW.buyer_id THEN
        INSERT INTO requisition_history (requisition_id, field_changed, old_value, new_value, changed_by)
        VALUES (NEW.id, 'buyer_id', OLD.buyer_id::TEXT, NEW.buyer_id::TEXT, changed_by_id);
    END IF;

    -- Registrar cambio de monto estimado
    IF OLD.estimated_amount IS DISTINCT FROM NEW.estimated_amount THEN
        INSERT INTO requisition_history (requisition_id, field_changed, old_value, new_value, changed_by)
        VALUES (NEW.id, 'estimated_amount', OLD.estimated_amount::TEXT, NEW.estimated_amount::TEXT, changed_by_id);
    END IF;

    -- Registrar cambio de fecha requerida
    IF OLD.required_date IS DISTINCT FROM NEW.required_date THEN
        INSERT INTO requisition_history (requisition_id, field_changed, old_value, new_value, changed_by)
        VALUES (NEW.id, 'required_date', OLD.required_date::TEXT, NEW.required_date::TEXT, changed_by_id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_log_requisition_changes ON requisitions;
CREATE TRIGGER trigger_log_requisition_changes
    AFTER UPDATE ON requisitions
    FOR EACH ROW
    EXECUTE FUNCTION log_requisition_changes();

-- =====================================================
-- END OF MIGRATION
-- =====================================================

-- Verificación final
DO $$
BEGIN
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'Migration 011_purchase_module.sql completed successfully';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'Tables created:';
    RAISE NOTICE '  - purchase_types';
    RAISE NOTICE '  - holidays';
    RAISE NOTICE '  - suppliers';
    RAISE NOTICE '  - requisitions';
    RAISE NOTICE '  - requisition_history';
    RAISE NOTICE '  - approval_workflows';
    RAISE NOTICE '  - approvals';
    RAISE NOTICE '  - purchase_orders';
    RAISE NOTICE '';
    RAISE NOTICE 'Enums created:';
    RAISE NOTICE '  - requisition_status';
    RAISE NOTICE '  - approval_workflow_status';
    RAISE NOTICE '  - approval_status';
    RAISE NOTICE '  - expense_type';
    RAISE NOTICE '  - po_status';
    RAISE NOTICE '';
    RAISE NOTICE 'Functions created:';
    RAISE NOTICE '  - calculate_business_days(start_date, end_date)';
    RAISE NOTICE '  - generate_rq_number()';
    RAISE NOTICE '  - generate_po_number()';
    RAISE NOTICE '=====================================================';
END $$;
