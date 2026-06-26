/**
 * TLS Transport Layer Security
 *
 * Demonstrates the built-in TLS transport plugin with mTLS and
 * TlsConnectionSecurityOptions:
 * - whitelist (exact IP or CIDR)
 * - maxConnections
 * - idleTimeout
 *
 * Self-signed certificates are imported from ./tls-certs.ts for convenience.
 * In production, load real certificates from a secure store and rotate them
 * regularly.
 *
 * Run: npx tsx tls-transport.ts
 */

import type { AbstractPipelineLayer } from 'njs-modbus';

import { ModbusMaster, ModbusSlave, TlsClientPhysicalLayer, TlsServerPhysicalLayer } from 'njs-modbus';

import { CA_CERT, CLIENT_CERT, CLIENT_KEY, SERVER_CERT, SERVER_KEY } from './tls-certs';

const PORT = 1802;

const serverPhysical = new TlsServerPhysicalLayer(
  {
    cert: SERVER_CERT,
    key: SERVER_KEY,
    ca: CA_CERT,
    requestCert: true,
    rejectUnauthorized: true,
  },
  {
    whitelist: ['127.0.0.1'],
    maxConnections: 2,
    idleTimeout: 30000,
  },
);

serverPhysical.on('open', () => {
  console.log('[TLS] server listening on port', PORT);
});

serverPhysical.on('connect', (pipeline: AbstractPipelineLayer) => {
  console.log('[TLS] connection accepted');

  const slave = new ModbusSlave({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
  });

  slave.addUnit(1, {
    readHoldingRegisters: (_address, length, callback) => {
      const values = Array.from({ length }, (_, i) => (0x1000 + i) & 0xffff);
      callback(null, values);
    },
  });

  pipeline.once('close', () => {
    slave.destroy();
    console.log('[TLS] connection closed');
  });
});

serverPhysical.on('connectionRejected', (event) => {
  console.log('[TLS] connection rejected:', event.reason, event.address);
});

serverPhysical.on('error', (err) => {
  console.error('[TLS] server error:', err.message);
});

async function runClient(): Promise<void> {
  const clientPhysical = new TlsClientPhysicalLayer({
    cert: CLIENT_CERT,
    key: CLIENT_KEY,
    ca: CA_CERT,
    rejectUnauthorized: true,
  });

  const masterPromise = new Promise<ModbusMaster<'TCP'>>((resolve) => {
    clientPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
      const master = new ModbusMaster({
        pipelineAdapter: pipeline,
        protocol: { type: 'TCP' },
        timeout: 1000,
      });
      resolve(master);
    });
  });

  await new Promise<void>((resolve, reject) => {
    clientPhysical.open({ host: '127.0.0.1', port: PORT }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  const master = await masterPromise;

  try {
    const response = await master.readHoldingRegisters(1, 0, 5);
    console.log('[TLS] read holding registers:', response.data);
  } finally {
    master.destroy();
    await new Promise<void>((resolve) => clientPhysical.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    serverPhysical.open({ port: PORT, host: '127.0.0.1' }, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });

  await runClient();

  serverPhysical.close((err) => {
    if (err) {
      console.error('[TLS] close error:', err.message);
      process.exit(1);
    }
    console.log('[TLS] server closed');
  });
}

main().catch((err) => {
  console.error('[TLS] failed:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  serverPhysical.close(() => process.exit(0));
});
