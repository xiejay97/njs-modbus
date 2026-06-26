/**
 * Library adapter registry.
 *
 * New third-party libraries are added by implementing `LibraryAdapter` and
 * calling `register()` below. The core benchmark engine resolves adapters by
 * name and never imports a concrete library directly.
 *
 * Built-in adapters are registered with lazy factories so that missing
 * optional benchmark dependencies (jsmodbus, modbus-serial) do not crash the
 * registry at module load time. They are loaded only when `resolve()` is
 * called for that library.
 */

import type { LibraryAdapter } from './types';

export type AdapterFactory = () => LibraryAdapter | Promise<LibraryAdapter>;

const registry = new Map<string, AdapterFactory>();

/** Register an adapter factory under a canonical library name. */
export function register(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

/** Resolve an adapter by name. */
export async function resolve(name: string): Promise<LibraryAdapter> {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(`Unknown library adapter: ${name}. Available: ${list().join(', ') || 'none'}`);
  }
  return await factory();
}

/** List all registered adapter names. */
export function list(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// Built-in adapters — lazy factories so missing deps don't break the registry.
// ---------------------------------------------------------------------------

register('jsmodbus', () => import('./jsmodbus.js').then((m) => m.createJsmodbusAdapter()));
register('modbus-serial', () => import('./modbus-serial.js').then((m) => m.createModbusSerialAdapter()));
register('njs-modbus', () => import('./njs-modbus.js').then((m) => m.createNjsModbusAdapter()));
