/**
 * Transport-Layer Security Options
 *
 * Demonstrates the TCP/UDP server security and resource-limit options
 * (ConnectionSecurityOptions):
 * - whitelist (exact IP, CIDR, or predicate)
 * - maxConnections
 * - maxConnectionsPerIp
 * - idleTimeout
 *
 * The same options also apply to TlsServerPhysicalLayer; see tls-transport.ts
 * for a TLS example.
 *
 * Run: npx tsx transport-layer-security.ts
 */

import { createSocket as createUdpSocket } from 'node:dgram';
import { createConnection } from 'node:net';

import { TcpServerPhysicalLayer, UdpServerPhysicalLayer } from 'njs-modbus';

const TCP_PORT = 1502;
const UDP_PORT = 1503;

const tcpSecurity = {
  // Exact IPv4, IPv4 CIDR, IPv6, IPv6 CIDR, or a predicate receiving the
  // canonicalized remote address.
  whitelist: [
    '127.0.0.1',
    '192.168.1.0/24',
    '::1',
    // Reject anything that looks like a non-routable documentation prefix.
    (address: string) => !address.startsWith('192.0.2.'),
  ],
  // Allow at most 10 concurrent TCP connections in total.
  maxConnections: 10,
  // Allow at most 3 connections from a single remote IP.
  maxConnectionsPerIp: 3,
  // Close idle connections after 30 seconds of inactivity.
  idleTimeout: 30000,
};

const tcpPhysical = new TcpServerPhysicalLayer({}, tcpSecurity);

const udpSecurity = {
  // Only accept peers from localhost.
  whitelist: ['127.0.0.1'],
  // Allow at most 50 concurrent UDP peers in total.
  maxConnections: 50,
  // Allow at most 5 peers from a single remote IP.
  maxConnectionsPerIp: 5,
  // Destroy idle peers after 10 seconds of inactivity.
  idleTimeout: 10000,
};

const udpPhysical = new UdpServerPhysicalLayer({ type: 'udp4' }, udpSecurity);

function printConfig(): void {
  console.log('--- TCP security options ---');
  console.log('  whitelist:', tcpSecurity.whitelist.map((entry) => (typeof entry === 'function' ? '<predicate>' : entry)).join(', '));
  console.log('  maxConnections:', tcpSecurity.maxConnections);
  console.log('  maxConnectionsPerIp:', tcpSecurity.maxConnectionsPerIp);
  console.log('  idleTimeout:', tcpSecurity.idleTimeout, 'ms');
  console.log('--- UDP security options ---');
  console.log('  whitelist:', udpSecurity.whitelist.map((entry) => (typeof entry === 'function' ? '<predicate>' : entry)).join(', '));
  console.log('  maxConnections:', udpSecurity.maxConnections);
  console.log('  maxConnectionsPerIp:', udpSecurity.maxConnectionsPerIp);
  console.log('  idleTimeout:', udpSecurity.idleTimeout, 'ms');
  console.log();
}

tcpPhysical.on('open', () => {
  console.log('[TCP] server listening');
});

tcpPhysical.on('connect', (pipeline) => {
  console.log('[TCP] connection accepted');
  pipeline.once('close', () => {
    console.log('[TCP] connection closed');
  });
});

tcpPhysical.on('connectionRejected', (event) => {
  console.log('[TCP] connection rejected:', event.reason, event.address);
});

tcpPhysical.on('error', (err) => {
  console.error('[TCP] transport error:', err.message);
});

tcpPhysical.on('close', () => {
  console.log('[TCP] server closed');
});

udpPhysical.on('open', () => {
  console.log('[UDP] socket bound');
});

udpPhysical.on('connect', (pipeline) => {
  console.log('[UDP] peer accepted');
  pipeline.once('close', () => {
    console.log('[UDP] peer closed');
  });
});

udpPhysical.on('connectionRejected', (event) => {
  console.log('[UDP] peer rejected:', event.reason, event.address, event.port);
});

udpPhysical.on('error', (err) => {
  console.error('[UDP] transport error:', err.message);
});

udpPhysical.on('close', () => {
  console.log('[UDP] socket closed');
});

async function runTcpSelfTest(): Promise<void> {
  console.log('--- TCP self-test: maxConnectionsPerIp ---');

  const sockets: ReturnType<typeof createConnection>[] = [];

  // Open 3 connections from 127.0.0.1 sequentially so the server has processed
  // each one before the next SYN arrives.
  for (let i = 0; i < 3; i++) {
    const connected = new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: TCP_PORT }, () => {
        console.log(`[TCP self-test] connection ${i + 1} accepted`);
        resolve();
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        console.log(`[TCP self-test] connection ${i + 1} error:`, err.code ?? err.message);
        reject(err);
      });
      sockets.push(socket);
    });
    await connected;
  }

  // The 4th connection from the same IP should be rejected.
  const rejected = new Promise<string>((resolve) => {
    tcpPhysical.once('connectionRejected', (event) => resolve(event.reason));
  });

  const fourth = createConnection({ host: '127.0.0.1', port: TCP_PORT });
  fourth.on('error', (err: NodeJS.ErrnoException) => {
    // The server destroys the socket; the client typically sees ECONNRESET.
    console.log('[TCP self-test] connection 4 rejected (expected):', err.code ?? err.message);
  });
  sockets.push(fourth);

  const reason = await rejected;
  console.log('[TCP self-test] server rejected connection 4:', reason);

  // Clean up the 3 allowed connections.
  for (const s of sockets.slice(0, 3)) {
    s.end();
  }
  fourth.destroy();
}

function runUdpSelfTest(): void {
  console.log('--- UDP self-test: whitelist accept ---');

  const client = createUdpSocket('udp4');
  client.bind(() => {
    client.send(Buffer.from('hello'), UDP_PORT, '127.0.0.1', (err) => {
      if (err) {
        console.log('[UDP self-test] send error:', err.message);
      } else {
        console.log('[UDP self-test] datagram sent from 127.0.0.1');
      }
      client.close();
    });
  });
}

async function startServers(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      tcpPhysical.open({ port: TCP_PORT }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        console.log(`TCP server listening on port ${TCP_PORT}`);
        resolve();
      });
    }),
    new Promise<void>((resolve, reject) => {
      udpPhysical.open({ port: UDP_PORT }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        console.log(`UDP server listening on port ${UDP_PORT}`);
        resolve();
      });
    }),
  ]);

  printConfig();
  await runTcpSelfTest();
  runUdpSelfTest();
}

startServers().catch((err) => {
  console.error('Failed to start servers:', err.message);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  tcpPhysical.close((tcpErr) => {
    if (tcpErr) {
      console.error('[TCP] close error:', tcpErr.message);
    }
    udpPhysical.close((udpErr) => {
      if (udpErr) {
        console.error('[UDP] close error:', udpErr.message);
      }
      process.exit(0);
    });
  });
});
