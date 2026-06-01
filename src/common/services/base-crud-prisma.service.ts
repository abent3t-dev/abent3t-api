import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../dto/pagination.dto';
import { PaginatedResponse } from '../interfaces/paginated-response.interface';

/**
 * BaseCrudPrismaService — reemplaza al viejo BaseCrudService (PostgREST) por
 * un equivalente que usa Prisma. La API pública es idéntica para que los
 * controllers no requieran cambios.
 *
 * Diferencias vs. el viejo:
 *   * `selectFields: string` desaparece — se reemplaza por `include` (objeto
 *     Prisma) para traer relaciones. Si no se define, no se incluyen.
 *   * `searchFields` ahora usa Prisma `where.OR` con `contains / mode: insensitive`
 *     (sin DSL PostgREST → sin riesgo de injection. `PaginationDto.search`
 *     conserva `@MaxLength(100)` como defensa en profundidad).
 *   * El soft-delete `remove(id)` sigue siendo `is_active = false`.
 *
 * El subtipo debe devolver el delegate de Prisma vía el getter abstracto
 * `model` — p. ej. `get model() { return this.prisma.departments; }`. Se usa
 * `any` internamente porque los delegates de Prisma no comparten una
 * supertype en tiempo de compilación.
 */
export abstract class BaseCrudPrismaService<CreateDto, UpdateDto> {
  /** Delegate de Prisma: `this.prisma.<modelName>`. */
  protected abstract get model(): any;

  /** Campo para ORDER BY por defecto. */
  protected abstract readonly orderField: string;

  /** Campos para búsqueda libre (Prisma `contains` insensitive). */
  protected readonly searchFields: string[] = [];

  /** Relaciones a incluir en findMany/findOne/etc. */
  protected readonly include: Record<string, unknown> | undefined = undefined;

  constructor(protected readonly prisma: PrismaService) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findAll(): Promise<any[]> {
    return this.model.findMany({
      orderBy: { [this.orderField]: 'asc' },
      include: this.include,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findAllPaginated(
    pagination: PaginationDto,
  ): Promise<PaginatedResponse<any>> {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    const term = pagination.search?.trim();
    if (term && this.searchFields.length > 0) {
      where.OR = this.searchFields.map((field) => ({
        [field]: { contains: term, mode: 'insensitive' },
      }));
    }

    const [data, total] = await this.prisma.$transaction([
      this.model.findMany({
        where,
        orderBy: { [this.orderField]: 'asc' },
        include: this.include,
        skip,
        take: limit,
      }),
      this.model.count({ where }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit) || 1,
        hasNext: page * limit < total,
        hasPrev: page > 1,
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async findOne(id: string): Promise<any> {
    const row = await this.model.findUnique({
      where: { id },
      include: this.include,
    });
    if (!row) throw new NotFoundException('Registro no encontrado');
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async create(dto: CreateDto): Promise<any> {
    return this.model.create({
      data: dto as Record<string, unknown>,
      include: this.include,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async update(id: string, dto: UpdateDto): Promise<any> {
    try {
      return await this.model.update({
        where: { id },
        data: dto as Record<string, unknown>,
        include: this.include,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2025') throw new NotFoundException('Registro no encontrado');
      throw err;
    }
  }

  async remove(id: string): Promise<{ message: string }> {
    try {
      await this.model.update({
        where: { id },
        data: { is_active: false },
      });
      return { message: 'Registro desactivado correctamente' };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'P2025') throw new NotFoundException('Registro no encontrado');
      throw err;
    }
  }

  /**
   * Valida que un FK referenciado exista y esté activo.
   * Si la tabla no tiene `is_active`, omitir el segundo check pasando el
   * modelo correspondiente — pero por defecto todas las tablas del proyecto
   * tienen soft-delete.
   */
  protected async validateFK(
    delegate: { findUnique: (args: unknown) => Promise<unknown> },
    id: string,
    fieldName: string,
  ): Promise<void> {
    const row = (await delegate.findUnique({
      where: { id },
      select: { id: true, is_active: true },
    } as unknown)) as { id: string; is_active?: boolean } | null;
    if (!row) {
      throw new BadRequestException(`${fieldName}: registro no encontrado`);
    }
    if (row.is_active === false) {
      throw new BadRequestException(
        `${fieldName}: el registro está desactivado`,
      );
    }
  }
}
