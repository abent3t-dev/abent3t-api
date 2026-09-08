import { MaximoError } from '../maximo.errors';
import { MaximoSyncTarget } from './maximo-sync.types';

/** `MAXIMO_SYNC_ENABLED=false`: nada toca la red; el controller responde 503. */
export class MaximoSyncDisabledError extends MaximoError {
  constructor() {
    super(
      'Sincronización de Maximo deshabilitada (MAXIMO_SYNC_ENABLED=false). Ver checklist de activación en src/integrations/README.md',
    );
  }
}

/** Mutex por target: no dos corridas simultáneas del mismo target. */
export class MaximoSyncInProgressError extends MaximoError {
  readonly target: MaximoSyncTarget;

  constructor(target: MaximoSyncTarget) {
    super(`Ya hay una corrida de sync en curso para el target "${target}"`);
    this.target = target;
  }
}

/** T5: el seed de fixtures jamás corre en producción. */
export class MaximoSeedProductionError extends MaximoError {
  constructor(operation: string) {
    super(
      `"${operation}" es SOLO desarrollo (T5) y NODE_ENV=production — abortado sin tocar la base`,
    );
  }
}
