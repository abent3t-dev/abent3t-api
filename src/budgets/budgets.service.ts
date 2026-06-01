import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseCrudPrismaService } from '../common/services/base-crud-prisma.service';
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
  created_at: Date | string;
  updated_at: Date | string;
  departments?: { id: string; name: string } | null;
  periods?: {
    id: string;
    label: string;
    year: number;
    semester: number | null;
  } | null;
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
export class BudgetsService extends BaseCrudPrismaService<
  CreateBudgetDto,
  UpdateBudgetDto
> {
  protected get model() {
    return this.prisma.budgets;
  }
  protected readonly orderField = 'created_at';
  protected readonly include = {
    departments: { select: { id: true, name: true } },
    periods: {
      select: { id: true, label: true, year: true, semester: true },
    },
  };

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calculateAvailable(budget: any) {
    return {
      ...budget,
      available_amount:
        Number(budget.assigned_amount) - Number(budget.consumed_amount),
    };
  }

  async findAll() {
    const data = await this.prisma.budgets.findMany({
      where: { is_active: true },
      include: this.include,
      orderBy: { created_at: 'desc' },
    });
    return data.map((b) => this.calculateAvailable(b));
  }

  async findOne(id: string) {
    const budget = await this.prisma.budgets.findFirst({
      where: { id, is_active: true },
      include: this.include,
    });
    if (!budget) throw new NotFoundException('Presupuesto no encontrado');
    return this.calculateAvailable(budget);
  }

  async findByDepartment(departmentId: string) {
    const data = await this.prisma.budgets.findMany({
      where: { department_id: departmentId, is_active: true },
      include: this.include,
      orderBy: { created_at: 'desc' },
    });
    return data.map((b) => this.calculateAvailable(b));
  }

  async findByPeriod(periodId: string) {
    const data = await this.prisma.budgets.findMany({
      where: { period_id: periodId, is_active: true },
      include: this.include,
      orderBy: { created_at: 'desc' },
    });
    return data.map((b) => this.calculateAvailable(b));
  }

  async create(dto: CreateBudgetDto) {
    await Promise.all([
      this.validateFK(
        this.prisma.departments,
        dto.department_id,
        'department_id',
      ),
      this.validateFK(this.prisma.periods, dto.period_id, 'period_id'),
    ]);

    const existing = await this.prisma.budgets.findFirst({
      where: {
        department_id: dto.department_id,
        period_id: dto.period_id,
        is_active: true,
      },
      include: this.include,
    });

    if (existing) {
      const deptName = existing.departments?.name || 'este departamento';
      const periodLabel = existing.periods?.label || 'este período';
      throw new BadRequestException(
        `Ya existe un presupuesto activo para ${deptName} en el período ${periodLabel}. ` +
          `No se pueden crear presupuestos duplicados para la misma combinación de departamento y período.`,
      );
    }

    const data = await this.prisma.budgets.create({
      data: { ...dto, consumed_amount: 0 },
      include: this.include,
    });
    return this.calculateAvailable(data);
  }

  async update(id: string, dto: UpdateBudgetDto) {
    try {
      const data = await this.prisma.budgets.update({
        where: { id },
        data: dto,
        include: this.include,
      });
      return this.calculateAvailable(data);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Presupuesto no encontrado');
      }
      throw err;
    }
  }

  // ==========================================================================
  // Excel template / import — la lógica con XLSX/ExcelJS no cambia; solo
  // las consultas a BD pasan a Prisma.
  // ==========================================================================

  async exportTemplate(includeData: boolean): Promise<Buffer> {
    const [departments, periods] = await Promise.all([
      this.prisma.departments.findMany({
        where: { is_active: true },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.periods.findMany({
        where: { is_active: true },
        select: { label: true },
        orderBy: { year: 'desc' },
      }),
    ]);

    const departmentNames = departments.map((d) => d.name);
    const periodLabels = periods.map((p) => p.label);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ABENT 3T';
    workbook.created = new Date();

    const presupuestosSheet = workbook.addWorksheet('Presupuestos', {
      views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
    });

    presupuestosSheet.columns = [
      { header: 'Departamento', key: 'departamento', width: 35 },
      { header: 'Período', key: 'periodo', width: 18 },
      { header: 'Monto Asignado', key: 'monto', width: 20 },
    ];

    presupuestosSheet.getRow(1).font = {
      bold: true,
      color: { argb: 'FFFFFFFF' },
      size: 12,
    };
    presupuestosSheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' },
    };
    presupuestosSheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };
    presupuestosSheet.getRow(1).height = 25;

    ['A1', 'B1', 'C1'].forEach((cell) => {
      presupuestosSheet.getCell(cell).border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });

    const numRows = includeData ? 0 : 20;
    if (includeData) {
      const budgets = await this.findAll();
      budgets.forEach((budget) => {
        presupuestosSheet.addRow({
          departamento: budget.departments?.name || '',
          periodo: budget.periods?.label || '',
          monto: Number(budget.assigned_amount),
        });
      });
    } else {
      for (let i = 0; i < numRows; i++) {
        presupuestosSheet.addRow({ departamento: '', periodo: '', monto: '' });
      }
    }

    const totalRows = Math.max(presupuestosSheet.rowCount, 21);

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

    for (let row = 2; row <= totalRows; row++) {
      const cell = presupuestosSheet.getCell(`C${row}`);
      cell.numFmt = '$#,##0.00';
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    }

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

    // ============ HOJA 2: INSTRUCCIONES (idéntico al original) =============
    const instructionsSheet = workbook.addWorksheet('Instrucciones');
    instructionsSheet.columns = [{ header: '', key: 'texto', width: 100 }];

    const instructions: Array<{
      texto: string;
      bold?: boolean;
      size?: number;
      color?: string;
      fill?: string;
    }> = [
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
        row.getCell(1).alignment = {
          horizontal: 'center',
          vertical: 'middle',
        };
        row.height = 30;
      }

      row.getCell(1).alignment = {
        ...row.getCell(1).alignment,
        wrapText: true,
      };
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async importBudgets(fileBuffer: Buffer): Promise<ImportResult> {
    const result: ImportResult = { success: 0, errors: [], total: 0 };

    try {
      const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawData = XLSX.utils.sheet_to_json<any>(worksheet, {
        defval: undefined,
        blankrows: false,
        raw: true,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = rawData.filter((row: any) => {
        const departmentName = (row['Departamento']?.toString() || '').trim();
        const periodLabel = (row['Período']?.toString() || '').trim();
        const amountRaw = row['Monto Asignado'];
        const assignedAmount = parseFloat(amountRaw);
        return (
          departmentName ||
          periodLabel ||
          (!isNaN(assignedAmount) &&
            amountRaw !== undefined &&
            amountRaw !== '')
        );
      });

      const [departments, periods] = await Promise.all([
        this.prisma.departments.findMany({
          where: { is_active: true },
          select: { id: true, name: true },
        }),
        this.prisma.periods.findMany({
          where: { is_active: true },
          select: { id: true, label: true },
        }),
      ]);

      for (let i = 0; i < data.length; i++) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row: any = data[i];
        const rowNumber = i + 2;

        const departmentName = (row['Departamento']?.toString() || '').trim();
        const periodLabel = (row['Período']?.toString() || '').trim();
        const amountRaw = row['Monto Asignado'];
        const assignedAmount = parseFloat(amountRaw);

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

        const department = departments.find(
          (d) =>
            d.name.toLowerCase().trim() === departmentName.toLowerCase(),
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

        const existing = await this.prisma.budgets.findFirst({
          where: {
            department_id: department.id,
            period_id: period.id,
            is_active: true,
          },
          select: { id: true },
        });

        if (existing) {
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error:
              'Ya existe un presupuesto activo para esta combinación de departamento y período',
          });
          continue;
        }

        try {
          await this.create({
            department_id: department.id,
            period_id: period.id,
            assigned_amount: assignedAmount,
          });
          result.success++;
        } catch (error: unknown) {
          const msg = (error as { message?: string })?.message;
          result.errors.push({
            row: rowNumber,
            department: departmentName,
            period: periodLabel,
            error: msg || 'Error al crear presupuesto',
          });
        }
      }

      result.total = result.success + result.errors.length;
      return result;
    } catch (error: unknown) {
      const msg = (error as { message?: string })?.message;
      throw new BadRequestException(
        `Error al procesar archivo: ${msg || 'Formato inválido'}`,
      );
    }
  }
}
