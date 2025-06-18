import type { ApplicationDataUnit } from '../../types';

import EventEmitter from 'node:events';

interface AbstractApplicationLayerEvents {
  framing: [frame: ApplicationDataUnit & { buffer: Buffer }, response: (data: Buffer) => Promise<void>];
}

export abstract class AbstractApplicationLayer extends EventEmitter<AbstractApplicationLayerEvents> {
  abstract encode(data: ApplicationDataUnit): Buffer;
  abstract destroy(): void;
}
