import { Duplex } from 'node:stream';

export interface MockSerialPortOptions {
  path: string;
  baudRate: number;
  autoOpen?: boolean;
  [key: string]: unknown;
}

export class MockSerialPort extends Duplex {
  public static nextOpenError: Error | null = null;

  public path: string;
  public baudRate: number;
  public isOpen = false;

  private _openErr: Error | null = null;

  constructor(options: MockSerialPortOptions) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    if (MockSerialPort.nextOpenError) {
      this._openErr = MockSerialPort.nextOpenError;
      MockSerialPort.nextOpenError = null;
    }
  }

  open(callback?: (err: Error | null) => void): void {
    process.nextTick(() => {
      if (this._openErr) {
        const err = this._openErr;
        this._openErr = null;
        callback?.(err);
        return;
      }
      this.isOpen = true;
      callback?.(null);
      this.emit('open');
    });
  }

  close(callback?: (err: Error | null) => void): void {
    process.nextTick(() => {
      this.isOpen = false;
      callback?.(null);
      this.emit('close');
    });
  }

  /** Public write API used by SerialPhysicalConnection. */
  override write(chunk: Buffer, callback?: (error: Error | null | undefined) => void): boolean;
  override write(chunk: Buffer, encoding: BufferEncoding, callback?: (error: Error | null | undefined) => void): boolean;
  override write(
    chunk: Buffer,
    encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
    maybeCb?: (error: Error | null | undefined) => void,
  ): boolean {
    if (!this.isOpen) {
      const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
      process.nextTick(() => cb?.(new Error('Port is not open')));
      return false;
    }
    this.emit('write', chunk);
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    process.nextTick(() => cb?.(null));
    return true;
  }

  drain(callback?: (error: Error | null | undefined) => void): void {
    process.nextTick(() => callback?.(null));
  }

  override _read(): void {
    // Duplex requirement: no-op because data is pushed via simulateIncomingData.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null | undefined) => void): void {
    this.write(chunk, callback);
  }

  /** Simulate bytes arriving from the wire. */
  simulateIncomingData(buffer: Buffer): void {
    if (this.isOpen) {
      this.push(buffer);
    }
  }

  /** Simulate bytes arriving in chopped chunks. */
  simulateChopIncomingData(buffer: Buffer, chunkSize = 2): void {
    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= buffer.length || !this.isOpen) {
        clearInterval(interval);
        return;
      }
      const end = Math.min(offset + chunkSize, buffer.length);
      this.push(buffer.subarray(offset, end));
      offset += chunkSize;
    }, 1);
  }
}
