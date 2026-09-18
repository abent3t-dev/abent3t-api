import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SuppliersService } from './suppliers.service';

/**
 * Guard de solo-lectura de los básicos sincronizados desde SAP: un
 * proveedor source='sap' no acepta ediciones manuales de nombre/RFC/email/
 * teléfono/contacto; el resto (campos de ABENT) sigue editable.
 */

function makeService(source: 'sap' | 'manual') {
  const prisma = {
    suppliers: {
      findFirst: jest.fn().mockResolvedValue({ source }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'sup-1', ...data }),
      ),
    },
  };
  const service = new SuppliersService(prisma as unknown as PrismaService);
  return { service, prisma };
}

describe('SuppliersService — update de proveedores sincronizados', () => {
  it('source=sap: tocar un básico sincronizado → 400 nombrando el campo', async () => {
    const { service, prisma } = makeService('sap');
    await expect(
      service.update('sup-1', { legal_name: 'Otro nombre', tax_id: 'XXX' }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.update('sup-1', { email: 'nuevo@correo.mx' }),
    ).rejects.toThrow(/email/);
    expect(prisma.suppliers.update).not.toHaveBeenCalled();
  });

  it('source=sap: los campos de ABENT siguen editables', async () => {
    const { service, prisma } = makeService('sap');
    await service.update('sup-1', {
      commercial_name: 'Alias comercial',
      address: 'Calle 1',
      contact_email: 'interno@abent3t.com',
    });
    expect(prisma.suppliers.update).toHaveBeenCalledTimes(1);
  });

  it('source=manual: sin restricciones', async () => {
    const { service, prisma } = makeService('manual');
    await service.update('sup-1', { legal_name: 'Nombre editado' });
    expect(prisma.suppliers.update).toHaveBeenCalledTimes(1);
  });
});
