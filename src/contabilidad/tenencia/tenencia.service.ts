import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { CreateTenenciaDto } from './dto/create-tenencia.dto';

export interface ShareholdingRecord {
  id: string;
  version: number;
  effective_date: string;
  event_description: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  shareholding_detail?: ShareholdingDetail[];
  profiles?: { id: string; full_name: string } | null;
}

export interface ShareholdingDetail {
  id: string;
  shareholding_record_id: string;
  accionista_nombre: string;
  rfc: string | null;
  tipo_accion: string | null;
  porcentaje: number;
  num_acciones: number | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

@Injectable()
export class TenenciaService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Obtiene la tenencia actual (versión más reciente)
   */
  async getCurrent(): Promise<ShareholdingRecord | null> {
    const { data, error } = await this.supabase.db
      .from('shareholding_records')
      .select('*, shareholding_detail(*), profiles:created_by(id, full_name)')
      .eq('is_active', true)
      .order('version', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows returned
    return data as ShareholdingRecord | null;
  }

  /**
   * Obtiene el historial de versiones de tenencia
   */
  async getHistorial(): Promise<ShareholdingRecord[]> {
    const { data, error } = await this.supabase.db
      .from('shareholding_records')
      .select('*, shareholding_detail(*), profiles:created_by(id, full_name)')
      .eq('is_active', true)
      .order('version', { ascending: false });

    if (error) throw error;
    return data as ShareholdingRecord[];
  }

  /**
   * Obtiene una versión específica de tenencia
   */
  async getVersion(id: string): Promise<ShareholdingRecord> {
    const { data, error } = await this.supabase.db
      .from('shareholding_records')
      .select('*, shareholding_detail(*), profiles:created_by(id, full_name)')
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) throw new NotFoundException('Versión de tenencia no encontrada');
    return data as ShareholdingRecord;
  }

  /**
   * Crea una nueva versión de tenencia
   */
  async create(dto: CreateTenenciaDto, userId: string): Promise<ShareholdingRecord> {
    // Validar que los porcentajes sumen 100%
    const totalPorcentaje = dto.accionistas.reduce((sum, a) => sum + a.porcentaje, 0);
    if (Math.abs(totalPorcentaje - 100) > 0.01) {
      throw new BadRequestException(
        `Los porcentajes deben sumar 100%. Actualmente suman ${totalPorcentaje.toFixed(2)}%`,
      );
    }

    // Obtener el siguiente número de versión
    const { data: lastVersion } = await this.supabase.db
      .from('shareholding_records')
      .select('version')
      .order('version', { ascending: false })
      .limit(1)
      .single();

    const nextVersion = (lastVersion?.version || 0) + 1;

    // Crear nueva versión
    const { data: record, error: recordError } = await this.supabase.db
      .from('shareholding_records')
      .insert({
        version: nextVersion,
        effective_date: dto.effective_date,
        event_description: dto.event_description || null,
        created_by: userId,
      } as any)
      .select('*')
      .single();

    if (recordError) throw recordError;

    // Crear detalles de accionistas
    const details = dto.accionistas.map((a) => ({
      shareholding_record_id: record.id,
      accionista_nombre: a.accionista_nombre,
      rfc: a.rfc || null,
      tipo_accion: a.tipo_accion || 'ordinaria',
      porcentaje: a.porcentaje,
      notes: a.notes || null,
    }));

    const { error: detailError } = await this.supabase.db
      .from('shareholding_detail')
      .insert(details as any);

    if (detailError) throw detailError;

    // Retornar la versión completa
    return this.getVersion(record.id);
  }

  /**
   * Elimina una versión de tenencia (soft delete)
   */
  async remove(id: string): Promise<{ message: string }> {
    await this.getVersion(id); // Validar que existe

    // Soft delete del registro (los detalles quedan vinculados)
    await this.supabase.db
      .from('shareholding_records')
      .update({ is_active: false } as any)
      .eq('id', id);

    return { message: 'Versión de tenencia eliminada correctamente' };
  }

  /**
   * Compara dos versiones de tenencia
   */
  async compareVersions(
    versionId1: string,
    versionId2: string,
  ): Promise<{
    version1: ShareholdingRecord;
    version2: ShareholdingRecord;
    changes: {
      added: string[];
      removed: string[];
      changed: { nombre: string; from: number; to: number }[];
    };
  }> {
    const [v1, v2] = await Promise.all([
      this.getVersion(versionId1),
      this.getVersion(versionId2),
    ]);

    const accionistas1 = new Map(v1.shareholding_detail?.map((d) => [d.accionista_nombre, d.porcentaje]) || []);
    const accionistas2 = new Map(v2.shareholding_detail?.map((d) => [d.accionista_nombre, d.porcentaje]) || []);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: { nombre: string; from: number; to: number }[] = [];

    // Encontrar agregados y cambiados
    accionistas2.forEach((porcentaje, nombre) => {
      if (!accionistas1.has(nombre)) {
        added.push(nombre);
      } else if (accionistas1.get(nombre) !== porcentaje) {
        changed.push({
          nombre,
          from: accionistas1.get(nombre)!,
          to: porcentaje,
        });
      }
    });

    // Encontrar eliminados
    accionistas1.forEach((_, nombre) => {
      if (!accionistas2.has(nombre)) {
        removed.push(nombre);
      }
    });

    return { version1: v1, version2: v2, changes: { added, removed, changed } };
  }
}
