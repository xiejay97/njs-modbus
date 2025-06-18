import EventEmitter from 'node:events';

interface AbstractPhysicalLayerEvents {
  data: [data: Buffer, response: (data: Buffer) => Promise<void>];
  error: [error: Error];
  close: [];
}

export abstract class AbstractPhysicalLayer extends EventEmitter<AbstractPhysicalLayerEvents> {
  abstract readonly TYPE: 'SERIAL' | 'NET';

  abstract readonly isOpen: boolean;
  abstract readonly destroyed: boolean;

  abstract open(...args: any[]): Promise<void>;
  abstract write(data: Buffer): Promise<void>;
  abstract close(): Promise<void>;
  abstract destroy(): Promise<void>;
}
