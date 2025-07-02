import type { ApplicationDataUnit } from '../../types';

import EventEmitter from 'node:events';

interface AbstractApplicationLayerEvents {
  framing: [frame: ApplicationDataUnit & { buffer: Buffer }, response: (data: Buffer) => Promise<void>];
}

export abstract class AbstractApplicationLayer extends EventEmitter<AbstractApplicationLayerEvents> {
  abstract startWaitingResponse(
    preCheck: ((frame: ApplicationDataUnit & { buffer: Buffer }) => boolean | number | undefined)[],
    callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void,
  ): void;
  abstract stopWaitingResponse(): void;
  abstract encode(data: ApplicationDataUnit): Buffer;
  abstract destroy(): void;
}
