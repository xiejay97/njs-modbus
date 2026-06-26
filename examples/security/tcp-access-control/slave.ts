/**
 * TCP Modbus Slave with Access Control
 *
 * Listens on TCP port 1502 and enforces:
 * - Only unit 1 is accepted.
 * - Only holding registers 0..99 can be read.
 *
 * Run: npx tsx tcp-access-control/slave.ts
 */

import { ModbusSlave, TcpServerPhysicalLayer } from 'njs-modbus';

const physical = new TcpServerPhysicalLayer();

physical.on('connect', (pipeline) => {
  const slave = new ModbusSlave({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
  });

  slave.setAccessAuthorizer({
    checkUnit: (unit) => unit === 1,
    checkAddress: (_unit, table, [start, end]) => table === 'holdingRegisters' && start >= 0 && end < 100,
  });

  slave.on('accessAudit', (event) => {
    console.log('[accessAudit]', event.type, `unit=${event.unit}`, `fc=${event.fc}`);
  });

  slave.on('protocolException', (event) => {
    console.log('[protocolException]', event.type, event.message);
  });

  slave.addUnit(1, {
    readHoldingRegisters: (address, length, callback) => {
      const values = Array.from({ length }, (_, i) => (address + i) & 0xffff);
      callback(null, values);
    },
  });
});

physical.open({ port: 1502 }, (err) => {
  if (err) {
    console.error('Failed to listen:', err.message);
    process.exit(1);
  }
  console.log('Slave listening on port 1502');
});

process.on('SIGINT', () => {
  physical.close(() => process.exit(0));
});
