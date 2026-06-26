/**
 * TCP Modbus Master with Access Control
 *
 * Connects to localhost:1502 and demonstrates a local AccessAuthorizer gate.
 * The server-side policy will also reject requests that violate its rules.
 *
 * Run: npx tsx tcp-access-control/master.ts
 * (Make sure tcp-access-control/slave.ts is running first.)
 */

import { ModbusMaster, TcpClientPhysicalLayer } from 'njs-modbus';

const physical = new TcpClientPhysicalLayer();

physical.on('connect', async (pipeline) => {
  const master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
  });

  master.setAccessAuthorizer({
    checkUnit: (unit) => unit === 1,
    checkAddress: (_unit, table, [start, end]) => table === 'holdingRegisters' && start >= 0 && end < 100,
  });

  try {
    const allowed = await master.readHoldingRegisters(1, 0, 10);
    console.log('Allowed read:', allowed.data);

    // This will be rejected locally by the master-side authorizer.
    await master.readHoldingRegisters(1, 200, 10);
  } catch (err) {
    console.error('Rejected:', (err as Error).message);
  } finally {
    master.destroy();
    physical.close();
  }
});

physical.open({ host: '127.0.0.1', port: 1502 }, (err) => {
  if (err) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }
});
