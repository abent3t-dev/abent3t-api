/**
 * Punto único de importación para los submódulos de integraciones
 * (Int-2 Maximo, Int-4 SAP). El dominio de Compras NO debe importar de aquí.
 */
export * from './errors/integration.errors';
export * from './logging/integration-logger';
export * from './http/integration-http.types';
export * from './http/integration-http.client';
export * from './http/integration-http-client.factory';
