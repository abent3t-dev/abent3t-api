import { SapError } from '../sap.errors';
import { SapSyncTarget } from './sap-sync.types';

/** `SAP_SYNC_ENABLED=false`: nada toca la red; el controller responde 503. */
export class SapSyncDisabledError extends SapError {
  constructor() {
    super(
      'Sincronización de SAP deshabilitada (SAP_SYNC_ENABLED=false). Ver plan de activación en src/integrations/README.md',
    );
  }
}

/** Mutex por target: no dos corridas simultáneas del mismo target. */
export class SapSyncInProgressError extends SapError {
  readonly target: SapSyncTarget;

  constructor(target: SapSyncTarget) {
    super(`Ya hay una corrida de sync en curso para el target "${target}"`);
    this.target = target;
  }
}
