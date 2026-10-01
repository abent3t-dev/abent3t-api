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
  carpeta: null as string | null,
  document_label: null as string | null,
  user_area: null as string | null,
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

  describe('I6: carpeta + tipo, fechas opcionales y agrupado por carpeta', () => {
    const base = {
      document_type: undefined,
      service_description: 'Servicio de facturación',
      supplier_id: 's-1',
    };
    const createdData = (prisma: ReturnType<typeof makeService>['prisma']) =>
      firstCallArg<{ data: Record<string, unknown> }>(prisma.contracts.create)
        .data;

    it('el número sale de la carpeta y el tipo; el segundo contrato lleva -2', async () => {
      const { service, prisma } = makeService();
      prisma.contracts.findMany.mockResolvedValueOnce([
        { contract_number: 'A3T-0010' },
      ]);
      prisma.contracts.findFirst.mockResolvedValueOnce(null);
      prisma.contracts.create.mockResolvedValueOnce(CONTRACT_ROW);
      await service.create(
        { ...base, carpeta: 'a3t-10', doc_kind: 'contrato' },
        'u-1',
      );
      expect(createdData(prisma)).toMatchObject({
        contract_number: 'A3T-0010-2',
        carpeta: 'A3T-0010',
        document_label: 'Contrato',
        document_type: 'contrato',
      });
      expect(prisma.contracts.findMany).toHaveBeenCalledWith({
        where: { contract_number: { startsWith: 'A3T-0010' } },
        select: { contract_number: true },
      });
    });

    it('la enmienda sin número es la siguiente de la carpeta', async () => {
      const { service, prisma } = makeService();
      prisma.contracts.findMany
        .mockResolvedValueOnce([
          { document_label: 'Enmienda 1' },
          { document_label: 'Enmienda 2' },
        ])
        .mockResolvedValueOnce([]);
      prisma.contracts.findFirst.mockResolvedValueOnce(null);
      prisma.contracts.create.mockResolvedValueOnce(CONTRACT_ROW);
      await service.create(
        { ...base, carpeta: 'A3T-0022', doc_kind: 'enmienda' },
        'u-1',
      );
      expect(createdData(prisma)).toMatchObject({
        contract_number: 'A3T-0022-E3',
        document_label: 'Enmienda 3',
        document_type: 'addenda',
      });
    });

    it('sin fecha de fin: se guarda vacía con el estatus pedido o vigente; con fin vencido manda la fecha', async () => {
      const { service, prisma } = makeService();
      prisma.contracts.findMany.mockResolvedValue([]);
      prisma.contracts.findFirst.mockResolvedValue(null);
      prisma.contracts.create.mockResolvedValue(CONTRACT_ROW);
      await service.create(
        { ...base, carpeta: 'A3T-0167', doc_kind: 'carta_intencion' },
        'u-1',
      );
      expect(createdData(prisma)).toMatchObject({
        contract_number: 'A3T-0167-CI',
        start_date: null,
        end_date: null,
        status: 'vigente',
      });
      await service.create(
        {
          ...base,
          carpeta: 'A3T-0168',
          doc_kind: 'contrato',
          end_date: '2025-01-31',
          status: 'vigente',
        },
        'u-1',
      );
      const second = (
        prisma.contracts.create.mock.calls[1] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(second.status).toBe('vencido');
    });

    it('sin carpeta ni número, o con una carpeta mal escrita → 400', async () => {
      const { service } = makeService();
      await expect(service.create({ ...base }, 'u-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.create({ ...base, carpeta: 'Carpeta 3' }, 'u-1'),
      ).rejects.toThrow('A3T-0000');
    });

    it('group=carpeta: una fila por carpeta, el contrato primero y sus documentos en orden', async () => {
      const { service, prisma } = makeService();
      const doc = (
        id: string,
        number: string,
        carpeta: string | null,
        label: string | null,
        type: string,
      ) => ({
        ...CONTRACT_ROW,
        id,
        contract_number: number,
        carpeta,
        document_label: label,
        document_type: type,
      });
      prisma.contracts.findMany.mockResolvedValueOnce([
        doc('5', 'A3T-0022-E2', 'A3T-0022', 'Enmienda 2', 'addenda'),
        doc(
          '4',
          'A3T-0022-CI',
          'A3T-0022',
          'Carta de intención',
          'carta_compromiso',
        ),
        doc('3', 'A3T-0022', 'A3T-0022', 'Contrato', 'contrato'),
        doc('6', 'A3T-0022-E1', 'A3T-0022', 'Enmienda 1', 'addenda'),
        doc('2', 'A3T-0003', 'A3T-0003', 'Contrato', 'contrato'),
        doc('1', '7400016518', null, null, 'contrato'),
      ]);
      const { data, meta } = await service.findGroups({ page: 1, limit: 20 });
      expect(meta.total).toBe(3);
      expect(data.map((g) => [g.key, g.head.contract_number])).toEqual([
        ['A3T-0003', 'A3T-0003'],
        ['A3T-0022', 'A3T-0022'],
        ['#7400016518', '7400016518'],
      ]);
      expect(data[1].documents.map((d) => d.contract_number)).toEqual([
        'A3T-0022',
        'A3T-0022-CI',
        'A3T-0022-E1',
        'A3T-0022-E2',
      ]);
      expect(data[1].documents[1].doc_kind).toBe('carta_intencion');
    });
  });

  describe('J2: vencido histórico (sin avisos)', () => {
    const base = {
      service_description: 'Servicio',
      supplier_id: 's-1',
      carpeta: 'A3T-0150',
      doc_kind: 'contrato' as const,
    };
    const lastCreate = (prisma: ReturnType<typeof makeService>['prisma']) =>
      (
        prisma.contracts.create.mock.calls.at(-1) as [
          { data: Record<string, unknown> },
        ]
      )[0].data;

    it('el que se da de alta ya vencido es histórico por defecto; Compras lo puede desmarcar', async () => {
      const { service, prisma } = makeService();
      prisma.contracts.findMany.mockResolvedValue([]);
      prisma.contracts.findFirst.mockResolvedValue(null);
      prisma.contracts.create.mockResolvedValue(CONTRACT_ROW);
      await service.create({ ...base, end_date: '2025-06-30' }, 'u-1');
      expect(lastCreate(prisma)).toMatchObject({
        status: 'vencido',
        vencido_historico: true,
      });
      await service.create(
        { ...base, end_date: '2025-06-30', vencido_historico: false },
        'u-1',
      );
      expect(lastCreate(prisma).vencido_historico).toBe(false);
      await service.create({ ...base, end_date: '2099-01-31' }, 'u-1');
      expect(lastCreate(prisma)).toMatchObject({
        status: 'vigente',
        vencido_historico: false,
      });
    });

    it('al renovar (nueva fecha de fin) deja de ser histórico; vencido se puede desmarcar', async () => {
      const { service, prisma } = makeService();
      const historic = {
        ...CONTRACT_ROW,
        status: 'vencido',
        vencido_historico: true,
        start_date: new Date('2024-07-01'),
        end_date: new Date('2025-06-30'),
      };
      prisma.contracts.findFirst.mockResolvedValue(historic);
      prisma.contracts.update.mockResolvedValue(CONTRACT_ROW);
      await service.update(CONTRACT_ROW.id, { end_date: '2099-12-31' }, 'u-1');
      const renewed = (
        prisma.contracts.update.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(renewed).toMatchObject({
        status: 'vigente',
        vencido_historico: false,
      });

      await service.update(
        CONTRACT_ROW.id,
        { vencido_historico: false },
        'u-1',
      );
      const unmarked = (
        prisma.contracts.update.mock.calls[1] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(unmarked.vencido_historico).toBe(false);
    });
  });
});
