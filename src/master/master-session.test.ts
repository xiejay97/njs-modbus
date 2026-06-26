/*
 * Copyright (c) 2026 xiejay97
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Change Date: 2029-06-24
 *
 * On the date above, in accordance with the Change Date, the Licensed Work
 * will be made available under the Apache License, Version 2.0.
 *
 * You may obtain a copy of the License at
 *     https://mariadb.com/bsl11/
 */

import { MasterSession } from './master-session';

interface Frame {
  transaction?: number;
  unit: number;
  fc: number;
  data: Buffer;
  buffer: Buffer;
}

describe('MasterSession', () => {
  it('should deliver a frame to a registered waiter', () => {
    const session = new MasterSession();
    const received: Frame[] = [];
    const frame: Frame = { transaction: 1, unit: 1, fc: 0x03, data: Buffer.from([0x02, 0x12, 0x34]), buffer: Buffer.alloc(0) };

    session.start(1, (err, f) => {
      if (!err && f) {
        received.push(f as Frame);
      }
    });
    session.handleFrame(frame);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(frame);
  });

  it('should use the FIFO key when no transaction is present', () => {
    const session = new MasterSession();
    let received: Frame | undefined;
    const frame: Frame = { unit: 1, fc: 0x03, data: Buffer.alloc(0), buffer: Buffer.alloc(0) };

    session.start('fifo', (err, f) => {
      if (!err) {
        received = f as Frame;
      }
    });
    session.handleFrame(frame);

    expect(received).toBe(frame);
  });

  it('should report whether a key is already waiting', () => {
    const session = new MasterSession();
    expect(session.has(7)).toBe(false);
    session.start(7, () => void 0);
    expect(session.has(7)).toBe(true);
  });

  it('should stop a waiter without firing its callback', () => {
    const session = new MasterSession();
    let fired = false;
    session.start(1, () => {
      fired = true;
    });
    session.stop(1);
    session.handleFrame({ unit: 1, fc: 0x03, data: Buffer.alloc(0), buffer: Buffer.alloc(0) });

    expect(fired).toBe(false);
  });

  it('should stop all waiters with an error', () => {
    const session = new MasterSession();
    const errors: Error[] = [];
    session.start(1, (err) => err && errors.push(err));
    session.start(2, (err) => err && errors.push(err));

    session.handleError(new Error('connection lost'));

    expect(errors).toHaveLength(2);
    expect(errors[0].message).toBe('connection lost');
  });
});
