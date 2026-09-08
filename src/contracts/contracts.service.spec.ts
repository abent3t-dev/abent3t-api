import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { ContractsService } from './contracts.service';

/** Fase §15. Service probado con Prisma y Storage simulados — sin red/BD. */

/** Primer argumento de la primera llamada de un mock, tipado. */
function firstCallArg<T>(fn: jest.Mock): T {
  return (fn.mock.calls[0] as [T])[0];
}

const CONTRACT_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  contract_number: 'A3T001',
  tomo: 'Tomo 1',
  document_type: 'contrato',
  service_description: 'Mantenimiento de compresores',
  supplier_id: 's-1',
  start_date: new Date('2026-01-01'),
  end_date: new Date('2026-12-31'),
  total_amount: '250000.50', // Decimal del driver
  currency: 'MXN',
  buyer_profile_id: 'p-1',
  responsible_user_email: 'resp@abent3t.com',
  responsible_user_name: 'Resp',
  status: 'vigente',
  notes: null,
  is_active: true,
  created_by: 'p-9',
  created_at: new Date(),
  updated_at: new Date(),
  deleted_at: null,
  deleted_by: null,
  suppliers: { id: 's-1', legal_name: 'Proveedor SA', tax_id: 'PSA010101' },
  profiles_contracts_buyer_profile_idToprofiles: {
    id: 'p-1',
    full_name: 'Comprador',
    email: 'comprador@abent3t.com',
  },
};

function makeService() {
  const prisma = {
    contracts: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([CONTRACT_ROW]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    contract_documents: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    profiles: { findFirst: jest.fn().mockResolvedValue({ id: 'p-1' }) },
    suppliers: { findFirst: jest.fn().mockResolvedValue({ id: 's-1' }) },
    $transaction: jest.fn(),
  };
  const storage = {
    bucketContracts: 'contracts',
    upload: jest.fn().mockResolvedValue({ path: 'x' }),
    getSignedUrl: jest.fn().mockResolvedValue('https://minio/firmada'),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ContractsService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
  );
  return { service, prisma, storage };
}

const pdf = (overrides: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'contrato firmado.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.7'),
    ...overrides,
  }) as Express.Multer.File;

describe('ContractsService', () => {
  it('findAll: alias supplier/buyer, Decimal→number y meta estándar; sin claves crudas de Prisma', async () => {
    const { service } = makeService();
    const result = await service.findAll({ page: 1, limit: 20 });
    const row = result.data[0];
    expect(row.total_amount).toBe(250000.5);
    expect(row.supplier?.legal_name).toBe('Proveedor SA');
    expect(row.buyer?.full_name).toBe('Comprador');
    expect('suppliers' in row).toBe(false);
    expect('profiles_contracts_buyer_profile_idToprofiles' in row).toBe(false);
    expect(result.meta).toEqual({
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    });
  });

  it('create: número duplicado → BadRequest; proveedor inexistente → NotFound; fin antes de inicio → BadRequest', async () => {
    const { service, prisma } = makeService();
    const dto = {
      contract_number: 'A3T001',
      document_type: 'contrato' as const,
      service_description: 'X',
      supplier_id: 's-1',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    };

    prisma.contracts.findFirst.mockResolvedValueOnce({ id: 'dup' });
    await expect(service.create(dto, 'u-1')).rejects.toThrow(
      BadRequestException,
    );

    prisma.suppliers.findFirst.mockResolvedValueOnce(null);
    await expect(service.create(dto, 'u-1')).rejects.toThrow(NotFoundException);

    prisma.contracts.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create(
        { ...dto, start_date: '2026-12-31', end_date: '2026-01-01' },
        'u-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('create feliz: persiste con created_by y responde con alias', async () => {
    const { service, prisma } = makeService();
    prisma.contracts.findFirst.mockResolvedValueOnce(null); // sin duplicado
    prisma.contracts.create.mockResolvedValueOnce(CONTRACT_ROW);

    const created = await service.create(
      {
        contract_number: 'A3T001',
        document_type: 'contrato',
        service_description: 'Mantenimiento de compresores',
        supplier_id: 's-1',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
      },
      'u-1',
    );
    expect(created.supplier?.id).toBe('s-1');
    const createArgs = firstCallArg<{ data: Record<string, unknown> }>(
      prisma.contracts.create,
    );
    expect(createArgs.data.created_by).toBe('u-1');
    expect(createArgs.data.start_date).toBeInstanceOf(Date);
  });

  describe('documentos', () => {
    it('rechaza no-PDF y tamaño > 20MB sin tocar storage', async () => {
      const { service, prisma, storage } = makeService();
      prisma.contracts.findFirst.mockResolvedValue({
        id: CONTRACT_ROW.id,
        contract_number: 'A3T001',
      });

      await expect(
        service.uploadDocument(
          CONTRACT_ROW.id,
          pdf({ mimetype: 'image/png' }),
          'u-1',
        ),
      ).rejects.toThrow('Solo se aceptan PDF');
      await expect(
        service.uploadDocument(
          CONTRACT_ROW.id,
          pdf({ size: 21 * 1024 * 1024 }),
          'u-1',
        ),
      ).rejects.toThrow('20MB');
      expect(storage.upload).not.toHaveBeenCalled();
    });

    it('sube v2, desmarca el vigente anterior y NUNCA devuelve storage_key', async () => {
      const { service, prisma, storage } = makeService();
      prisma.contracts.findFirst.mockResolvedValue({
        id: CONTRACT_ROW.id,
        contract_number: 'A3T001',
      });
      prisma.contract_documents.findFirst.mockResolvedValue({ version: 1 });
      const createdDoc = {
        id: 'd-2',
        contract_id: CONTRACT_ROW.id,
        file_name: 'contrato firmado.pdf',
        mime_type: 'application/pdf',
        file_size_bytes: BigInt(1024),
        version: 2,
        is_current: true,
        uploaded_by: 'u-1',
        uploaded_at: new Date(),
      };
      prisma.$transaction.mockResolvedValue([{ count: 1 }, createdDoc]);

      const doc = await service.uploadDocument(CONTRACT_ROW.id, pdf(), 'u-1');
      expect(storage.upload).toHaveBeenCalledTimes(1);
      const [bucket, key] = storage.upload.mock.calls[0] as [string, string];
      expect(bucket).toBe('contracts');
      expect(key.startsWith(`${CONTRACT_ROW.id}/v2_`)).toBe(true);
      expect(doc.version).toBe(2);
      expect(doc.file_size_bytes).toBe(1024); // BigInt normalizado
      expect('storage_key' in doc).toBe(false);
    });

    it('si el insert falla tras subir, borra el objeto de MinIO (rollback)', async () => {
      const { service, prisma, storage } = makeService();
      prisma.contracts.findFirst.mockResolvedValue({
        id: CONTRACT_ROW.id,
        contract_number: 'A3T001',
      });
      prisma.contract_documents.findFirst.mockResolvedValue(null);
      prisma.$transaction.mockRejectedValue(new Error('insert falló'));

      await expect(
        service.uploadDocument(CONTRACT_ROW.id, pdf(), 'u-1'),
      ).rejects.toThrow('insert falló');
      expect(storage.remove).toHaveBeenCalledTimes(1);
      const [bucket, key] = storage.remove.mock.calls[0] as [string, string];
      expect(bucket).toBe('contracts');
      expect(key.startsWith(`${CONTRACT_ROW.id}/v1_`)).toBe(true);
    });

    it('descarga: signed URL con TTL de 5 minutos, forma { url, fileName }', async () => {
      const { service, prisma, storage } = makeService();
      prisma.contract_documents.findFirst.mockResolvedValue({
        storage_key: 'ct/v1_x.pdf',
        file_name: 'x.pdf',
      });
      const result = await service.getDocumentDownloadUrl(
        CONTRACT_ROW.id,
        'd-1',
      );
      expect(result).toEqual({
        url: 'https://minio/firmada',
        fileName: 'x.pdf',
      });
      expect(storage.getSignedUrl).toHaveBeenCalledWith(
        'contracts',
        'ct/v1_x.pdf',
        300,
      );
    });

    it('eliminar documento = marcar no-vigente (el objeto en MinIO se conserva)', async () => {
      const { service, prisma, storage } = makeService();
      prisma.contract_documents.findFirst.mockResolvedValue({
        id: 'd-1',
        is_current: true,
      });
      await service.removeDocument(CONTRACT_ROW.id, 'd-1', 'u-1');
      expect(prisma.contract_documents.update).toHaveBeenCalledWith({
        where: { id: 'd-1' },
        data: { is_current: false },
      });
      expect(storage.remove).not.toHaveBeenCalled();
    });
  });

  it('remove: soft delete con deleted_by', async () => {
    const { service, prisma } = makeService();
    prisma.contracts.findFirst.mockResolvedValue({
      id: CONTRACT_ROW.id,
      contract_number: 'A3T001',
    });
    await service.remove(CONTRACT_ROW.id, 'u-1');
    const args = firstCallArg<{ data: Record<string, unknown> }>(
      prisma.contracts.update,
    );
    expect(args.data.is_active).toBe(false);
    expect(args.data.deleted_by).toBe('u-1');
    expect(args.data.deleted_at).toBeInstanceOf(Date);
  });
});
