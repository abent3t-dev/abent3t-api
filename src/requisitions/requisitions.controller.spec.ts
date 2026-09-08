import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ValidationPipe,
  INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RequisitionsController } from './requisitions.controller';
import { RequisitionsService } from './requisitions.service';
import { RolesGuard } from '../common/guards/roles.guard';

/**
 * Fase 0 — T3: POST /requisitions/import endurecido.
 * Guard de prueba que reemplaza al JwtAuthGuard: toma los roles del header
 * `x-test-roles` para poder ejercitar el RolesGuard REAL en cada request.
 */
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const roles = (req.headers['x-test-roles'] as string | undefined)
      ?.split(',')
      .filter(Boolean);
    req.user = { id: 'usuario-de-prueba', roles: roles ?? [] };
    return true;
  }
}

describe('RequisitionsController — POST /requisitions/import (T3)', () => {
  let app: INestApplication;
  const serviceMock = {
    importFromExternal: jest.fn().mockResolvedValue({ imported: 0, failed: 0 }),
  };

  const validItem = {
    description: 'Compra de refacciones',
    requester_id: '3f0e8f9a-1111-4222-8333-444455556666',
    created_date: '2026-08-11',
    source: 'maximo',
    external_id: 'RQ-EXT-1',
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RequisitionsController],
      providers: [
        { provide: RequisitionsService, useValue: serviceMock },
        // Sin REQUISITIONS_IMPORT_MAX_BATCH definido → aplica el default 500
        { provide: ConfigService, useValue: { get: () => undefined } },
        // Mismo orden que en app.module: autenticación → autorización
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    // Espejo de main.ts
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    serviceMock.importFromExternal.mockClear();
  });

  const post = (roles: string) =>
    request(app.getHttpServer())
      .post('/requisitions/import')
      .set('x-test-roles', roles);

  it('un elemento inválido en el lote → 400 y NADA se inserta', async () => {
    const invalidItem = { description: 'Sin requester ni fecha' };
    await post('lider_procura')
      .send({ source: 'maximo', requisitions: [validItem, invalidItem] })
      .expect(400);
    expect(serviceMock.importFromExternal).not.toHaveBeenCalled();
  });

  it('un elemento con tipo erróneo → 400 y NADA se inserta', async () => {
    const badType = { ...validItem, estimated_amount: 'mucho-dinero' };
    await post('lider_procura')
      .send({ source: 'maximo', requisitions: [badType] })
      .expect(400);
    expect(serviceMock.importFromExternal).not.toHaveBeenCalled();
  });

  it('lote de 501 → 400 con mensaje de tope', async () => {
    const batch = Array.from({ length: 501 }, (_, i) => ({
      ...validItem,
      external_id: `RQ-EXT-${i}`,
    }));
    const res = await post('lider_procura')
      .send({ source: 'maximo', requisitions: batch })
      .expect(400);
    expect(res.body.message).toContain('500');
    expect(serviceMock.importFromExternal).not.toHaveBeenCalled();
  });

  it('usuario sin rol administrativo (comprador) → 403', async () => {
    await post('comprador')
      .send({ source: 'maximo', requisitions: [validItem] })
      .expect(403);
    expect(serviceMock.importFromExternal).not.toHaveBeenCalled();
  });

  it('lote válido con lider_procura → funciona y llega al service', async () => {
    await post('lider_procura')
      .send({ source: 'maximo', requisitions: [validItem, { ...validItem, external_id: 'RQ-EXT-2' }] })
      .expect(201);
    expect(serviceMock.importFromExternal).toHaveBeenCalledTimes(1);
    const [items, source, userId] = serviceMock.importFromExternal.mock.calls[0];
    expect(items).toHaveLength(2);
    expect(source).toBe('maximo');
    expect(userId).toBe('usuario-de-prueba');
  });

  it('super_admin también puede (bypass del RolesGuard)', async () => {
    await post('super_admin')
      .send({ source: 'maximo', requisitions: [validItem] })
      .expect(201);
    expect(serviceMock.importFromExternal).toHaveBeenCalledTimes(1);
  });

  it('propiedades desconocidas se eliminan por whitelist', async () => {
    await post('lider_procura')
      .send({
        source: 'maximo',
        requisitions: [{ ...validItem, campo_intruso: 'x' }],
      })
      .expect(201);
    const [items] = serviceMock.importFromExternal.mock.calls[0];
    expect(items[0]).not.toHaveProperty('campo_intruso');
    expect(items[0].description).toBe(validItem.description);
  });
});
