import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { BaseCrudService } from '../common/services/base-crud.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import * as XLSX from 'xlsx';
import * as ExcelJS from 'exceljs';

interface BudgetRow {
  id: string;
  department_id: string;
  period_id: string;
  assigned_amount: number;
  consumed_amount: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  departments: { id: string; name: string } | null;
  periods: { id: string; label: string; year: number; semester: number } | null;
}

export interface ImportResult {
  success: number;
  errors: Array<{
    row: number;
    department: string;
    period: string;
    error: string;
  }>;
  total: number;
}

@Injectable()
export class BudgetsService extends BaseCrudService<CreateBudgetDto, UpdateBudgetDto> {
  protected readonly tableName = 'budgets';
  protected readonly selectFields = '*, departments(id, name), periods(id, label, year, semester)';
  protected readonly orderField = 'created_at';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  private calculateAvailable(budget: BudgetRow) {
    return {
      ...budget,
      available_amount: budget.assigned_amount - budget.consumed_amount,
    };
  }

  async findAll() {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findOne(id: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) throw new NotFoundException('Presupuesto no encontrado');
    return this.calculateAvailable(data as BudgetRow);
  }

  async findByDepartment(departmentId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('department_id', departmentId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async findByPeriod(periodId: string) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('period_id', periodId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return (data as BudgetRow[]).map(this.calculateAvailable);
  }

  async create(dto: CreateBudgetDto) {
    await Promise.all([
      this.validateFK('departments', dto.department_id, 'department_id'),
      this.validateFK('periods', dto.period_id, 'period_id'),
    ]);

    // Check uniqueness: one active budget per department+period
    const { data: existing } = await this.supabase.db
      .from('budgets')
      .select('id, departments(name), periods(label)')
      .eq('department_id', dto.department_id)
      .eq('period_id', dto.period_id)
      .eq('is_active', true)
      .limit(1)
      .maybeSingle();

    if (existing) {
      const deptName = (existing as any).departments?.name || 'este departamento';
      const periodLabel = (existing as any).periods?.label || 'este período';
      throw new BadRequestException(
        `Ya existe un presupuesto activo para ${deptName} en el período ${periodLabel}. No se pueden crear presupuestos duplicados para la misma combinación de departamento y período.`,
      );
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert({ ...dto, consumed_amount: 0 } as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return this.calculateAvailable(data as BudgetRow);
  }

  async update(id: string, dto: UpdateBudgetDto) {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(dto as any)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('Presupuesto no encontrado');
    return this.calculateAvailable(data as BudgetRow);
  }

  async exportTemplate(includeData: boolean): Promise<Buffer> {
    // Cargar catálogos para dropdowns
    const { data: departments } = await this.supabase.db
      .from('departments')
      .select('name')
      .eq('is_active', true)
      .order('name');

    const { data: periods } = await this.supabase.db
      .from('periods')
      .select('label')
      .eq('is_active', true)
      .order('year', { ascending: false });

    const departmentNames = departments?.map((d) => d.name) || [];
    const periodLabels = periods?.map((p) => p.label) || [];

    // Crear workbook con ExcelJS
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ABENT 3T';
    workbook.created = new Date();

    // ============ HOJA 1: PRESUPUESTOS ============
    const presupuestosSheet = workbook.addWorksheet('Presupuestos', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }], // Congelar primera fila
    });

    // Configurar columnas
    presupuestosSheet.columns = [
      { header: 'Departamento', key: 'departamento', width: 35 },
      { header: 'Período', key: 'periodo', width: 18 },
      { header: 'Monto Asignado', key: 'monto', width: 20 },
    ];

    // Estilos de encabezados
    presupuestosSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    presupuestosSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' }, // Azul
    };
    presupuestosSheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    presupuestosSheet.getRow(1).height = 25;

    // Aplicar bordes a encabezados
    ['A1', 'B1', 'C1'].forEach((cell) => {
      presupuestosSheet.getCell(cell).border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });

    // Agregar datos o filas vacías
    const numRows = includeData ? 0 : 20; // 20 filas vacías si no hay datos
    if (includeData) {
      const budgets = await this.findAll();
      budgets.forEach((budget) => {
        presupuestosSheet.addRow({
          departamento: budget.departments?.name || '',
          periodo: budget.periods?.label || '',
          monto: budget.assigned_amount,
        });
      });
    } else {
      for (let i = 0; i < numRows; i++) {
        presupuestosSheet.addRow({
          departamento: '',
          periodo: '',
          monto: '',
        });
      }
    }

    // ============ DATA VALIDATION (DROPDOWNS) ============
    const totalRows = Math.max(presupuestosSheet.rowCount, 21); // Mínimo 20 filas de datos

    // Dropdown para Departamento (Columna A, filas 2 en adelante)
    if (departmentNames.length > 0) {
      for (let row = 2; row <= totalRows; row++) {
        presupuestosSheet.getCell(`A${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${departmentNames.join(',')}"`],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Departamento inválido',
          error: 'Selecciona un departamento de la lista',
          showInputMessage: true,
          promptTitle: 'Departamento',
          prompt: 'Selecciona el departamento',
        };
      }
    }

    // Dropdown para Período (Columna B, filas 2 en adelante)
    if (periodLabels.length > 0) {
      for (let row = 2; row <= totalRows; row++) {
        presupuestosSheet.getCell(`B${row}`).dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [`"${periodLabels.join(',')}"`],
          showErrorMessage: true,
          errorStyle: 'error',
          errorTitle: 'Período inválido',
          error: 'Selecciona un período de la lista',
          showInputMessage: true,
          promptTitle: 'Período',
          prompt: 'Selecciona el período',
        };
      }
    }

    // Formato numérico para Monto Asignado
    for (let row = 2; row <= totalRows; row++) {
      const cell = presupuestosSheet.getCell(`C${row}`);
      cell.numFmt = '$#,##0.00';
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    }

    // Aplicar bordes a todas las celdas de datos
    for (let row = 2; row <= totalRows; row++) {
      ['A', 'B', 'C'].forEach((col) => {
        const cell = presupuestosSheet.getCell(`${col}${row}`);
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          left: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
          right: { style: 'thin', color: { argb: 'FFE5E7EB' } },
        };
        cell.alignment = { vertical: 'middle' };
      });
    }

    // ============ HOJA 2: INSTRUCCIONES ============
    const instructionsSheet = workbook.addWorksheet('Instrucciones');
    instructionsSheet.columns = [{ header: '', key: 'texto', width: 100 }];

    const instructions = [
      { texto: '📋 INSTRUCCIONES PARA IMPORTAR PRESUPUESTOS', bold: true, size: 14, color: '1F2937', fill: 'DBEAFE' },
      { texto: '' },
      { texto: '✨ Cómo usar esta plantilla:', bold: true, size: 12, color: '374151' },
      { texto: '' },
      { texto: '1️⃣ Ve a la hoja "Presupuestos"' },
      { texto: '2️⃣ Haz clic en las celdas para ver los DROPDOWNS (selectores)' },
      { texto: '3️⃣ Selecciona el departamento y período usando los menús desplegables' },
      { texto: '4️⃣ Ingresa el monto asignado (solo números)' },
      { texto: '5️⃣ Guarda el archivo y súbelo en el sistema' },
      { texto: '' },
      { texto: '📁 DEPARTAMENTO', bold: true, color: '3B82F6' },
      { texto: '   ✓ Usa el DROPDOWN (selector) en la columna A' },
      { texto: '   ✓ Los valores son los departamentos activos del sistema' },
      { texto: '   ✓ No escribas manualmente, selecciona de la lista' },
      { texto: '' },
      { texto: '📅 PERÍODO', bold: true, color: '8B5CF6' },
      { texto: '   ✓ Usa el DROPDOWN (selector) en la columna B' },
      { texto: '   ✓ Los valores son los períodos activos del sistema' },
      { texto: '   ✓ No escribas manualmente, selecciona de la lista' },
      { texto: '' },
      { texto: '💰 MONTO ASIGNADO', bold: true, color: '10B981' },
      { texto: '   ✓ Ingresa solo números (sin símbolos $ ni comas)' },
      { texto: '   ✓ Puedes usar decimales con punto: 45000 o 150000.50' },
      { texto: '   ✓ El formato se aplicará automáticamente' },
      { texto: '' },
      { texto: '⚠️ VALIDACIONES AUTOMÁTICAS:', bold: true, color: 'EF4444' },
      { texto: '   • Los dropdowns solo permiten valores válidos' },
      { texto: '   • No podrás escribir departamentos o períodos que no existan' },
      { texto: '   • Si intentas escribir manualmente, aparecerá un error' },
      { texto: '   • El sistema validará duplicados al importar' },
      { texto: '' },
      { texto: '💡 CONSEJOS:', bold: true, color: 'F59E0B' },
      { texto: '   ✅ USA LOS DROPDOWNS - no escribas manualmente' },
      { texto: '   ✅ Puedes importar hasta 100 presupuestos a la vez' },
      { texto: '   ✅ Si hay errores, el sistema te indicará qué filas tienen problemas' },
      { texto: '   ✅ Puedes copiar y pegar filas para duplicar datos' },
      { texto: '' },
      { texto: `🚀 Departamentos disponibles: ${departmentNames.length}`, color: '059669' },
      { texto: `🚀 Períodos disponibles: ${periodLabels.length}`, color: '059669' },
      { texto: '' },
      { texto: '¡Cuando termines, guarda el archivo y súbelo en el sistema!', bold: true, size: 11, color: '1F2937' },
    ];

    instructions.forEach((instruction, index) => {
      const row = instructionsSheet.getRow(index + 1);
      row.getCell(1).value = instruction.texto;

      if (instruction.bold) {
        row.getCell(1).font = {
          bold: true,
          size: instruction.size || 11,
          color: { argb: `FF${instruction.color || '000000'}` },
        };
      } else if (instruction.color) {
        row.getCell(1).font = { color: { argb: `FF${instruction.color}` } };
      }

      if (instruction.fill) {
        row.getCell(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: `FF${instruction.fill}` },
        };
        row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
        row.height = 30;
      }

      row.getCell(1).alignment = { ...row.getCell(1).alignment, wrapText: true };
    });

    // Generar buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async importBudgets(fileBuffer: Buffer): Promise<ImportResult> {
    const result: ImportResult = {
      success: 0,
      errors: [],
      total: 0,
    };

    try {
      // Leer archivo Excel
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // Leer datos del Excel
      const rawData = XLSX.utils.sheet_to_json(worksheet, {
        defval: undefined,  // Valor por defecto para celdas vacías
        blankrows: false,   // NO incluir filas completamente vacías
        raw: true,          // Obtener valores en bruto (números como números, no strings)
      });

      // Filtrar filas verdaderamente vacías (ignora celdas con solo espacios o valores vacíos)
      // Esto es necesario porque ExcelJS crea celdas con strings vacíos y formato,
      // que XLSX lee como filas no vacías
      const data = rawData.filter((row: any) => {
        const departmentName = (row['Departamento']?.toString() || '').trim();
        const periodLabel = (row['Período']?.toString() || '').trim();
        const amountRaw = row['Monto Asignado'];
        const assignedAmount = parseFloat(amountRaw);

        // Fila válida si tiene al menos uno de los campos con datos reales
        return departmentName || periodLabel || (!isNaN(assignedAmount) && amountRaw !== undefined && amountRaw !== '');
      });

      // Cargar departamentos y períodos para validación
      const { data: departments } = await this.supabase.db
        .from('departments')
        .select('id, name')
        .eq('is_active', true);

      const { data: periods } = await this.supabase.db
        .from('periods')
        .select('id, label')
        .eq('is_active', true);

      if (!departments || !periods) {
        throw new BadRequestException('Error al cargar catálogos');
      }

      // Procesar cada fila (las filas vacías ya fueron filtradas)
      for (let i = 0; i < data.length; i++) {
        const row: any = data[i];
        const rowNumber = i + 2; // +2 porque Excel empieza en 1 y tiene header

        // Extraer y limpiar valores
        const departmentName = (row['Departamento']?.toString() || '').trim();
        const periodLabel = (row['Período']?.toString() || '').trim();
        const amountRaw = row['Monto Asignado'];
        const assignedAmount = parseFloat(amountRaw);

        // Validar que los datos requeridos estén completos
        if (!departmentName || !periodLabel) {
          result.errors.push({
            row: rowNumber,
            department: departmentName || 'N/A',
            period: periodLabel || 'N/A',
            error: 'Departamento y Período son requeridos',
          });
          continue;
        }

        if (isNaN(assignedAmount) || assignedAmount <= 0) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: 'El monto debe ser un número positivo',
          });
          continue;
        }

        // Buscar departamento (case-insensitive)
        const department = departments.find(
          (d) => d.name.toLowerCase().trim() === departmentName.toLowerCase(),
        );

        if (!department) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: 'El departamento no existe',
          });
          continue;
        }

        // Buscar período (exact match)
        const period = periods.find((p) => p.label === periodLabel);

        if (!period) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: 'El período no existe',
          });
          continue;
        }

        // Verificar duplicados
        const { data: existing } = await this.supabase.db
          .from('budgets')
          .select('id')
          .eq('department_id', department.id)
          .eq('period_id', period.id)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (existing) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: 'Ya existe un presupuesto activo para esta combinación de departamento y período',
          });
          continue;
        }

        // Crear presupuesto
        try {
          await this.create({
            department_id: department.id,
            period_id: period.id,
            assigned_amount: assignedAmount,
          });
          result.success++;
        } catch (error) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: error.message || 'Error al crear presupuesto',
          });
        }
      }

      // Calcular total de filas procesadas (excluyendo filas vacías)
      result.total = result.success + result.errors.length;

      return result;
    } catch (error) {
      throw new BadRequestException(
        `Error al procesar archivo: ${error.message || 'Formato inválido'}`,
      );
    }
  }
}
