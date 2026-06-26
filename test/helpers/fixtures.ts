import { crcFixed } from '#src/utils/crc';
import { lrc } from '#src/utils/lrc';

export function pduReadCoils(address: number, length: number): Buffer {
  return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (length >>> 8) & 0xff, length & 0xff]);
}

export function pduReadHoldingRegisters(address: number, length: number): Buffer {
  return pduReadCoils(address, length);
}

export function pduWriteSingleCoil(address: number, value: 0 | 1): Buffer {
  const coilValue = value === 1 ? 0xff00 : 0x0000;
  return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (coilValue >>> 8) & 0xff, coilValue & 0xff]);
}

export function pduWriteSingleRegister(address: number, value: number): Buffer {
  return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function pduReadDeviceIdentification(readDeviceIDCode: number, objectId: number): Buffer {
  return Buffer.from([0x0e, readDeviceIDCode, objectId]);
}

/** Build an FC 8 / sub-function 0x0000 (Return Query Data) PDU. */
export function pduDiagnosticsReturnQueryData(data: number): Buffer {
  return Buffer.from([0x00, 0x00, (data >>> 8) & 0xff, data & 0xff]);
}

/** Build a complete RTU frame (unit + fc + pdu + CRC16). */
export function rtuFrame(unit: number, fc: number, pdu: Buffer): Buffer {
  const body = Buffer.allocUnsafe(2 + pdu.length);
  body[0] = unit;
  body[1] = fc;
  body.set(pdu, 2);
  const crc = crcFixed(body, 0, body.length);
  const frame = Buffer.allocUnsafe(body.length + 2);
  frame.set(body);
  frame[frame.length - 2] = crc & 0xff;
  frame[frame.length - 1] = (crc >>> 8) & 0xff;
  return frame;
}

/** Build a complete RTU exception frame. */
export function rtuExceptionFrame(unit: number, fc: number, exceptionCode: number): Buffer {
  return rtuFrame(unit, fc | 0x80, Buffer.from([exceptionCode]));
}

/** Build a complete Modbus TCP frame (MBAP header + unit + fc + pdu). */
export function tcpFrame(transactionId: number, unit: number, fc: number, pdu: Buffer): Buffer {
  const length = pdu.length + 2;
  const frame = Buffer.allocUnsafe(6 + length);
  frame[0] = (transactionId >>> 8) & 0xff;
  frame[1] = transactionId & 0xff;
  frame[2] = 0;
  frame[3] = 0;
  frame[4] = (length >>> 8) & 0xff;
  frame[5] = length & 0xff;
  frame[6] = unit;
  frame[7] = fc;
  frame.set(pdu, 8);
  return frame;
}

/** Build a complete Modbus TCP exception frame. */
export function tcpExceptionFrame(transactionId: number, unit: number, fc: number, exceptionCode: number): Buffer {
  return tcpFrame(transactionId, unit, fc | 0x80, Buffer.from([exceptionCode]));
}

const HEX = '0123456789ABCDEF';

function toHexByte(value: number): [number, number] {
  return [HEX.charCodeAt((value >>> 4) & 0x0f), HEX.charCodeAt(value & 0x0f)];
}

/** Build a complete ASCII frame (`:` + hex + LRC + CR LF). */
export function asciiFrame(unit: number, fc: number, pdu: Buffer): Buffer {
  const body = Buffer.allocUnsafe(2 + pdu.length);
  body[0] = unit;
  body[1] = fc;
  body.set(pdu, 2);
  const lrcValue = lrc(body, 0, body.length);

  const hexLen = (body.length + 1) * 2;
  const out = Buffer.allocUnsafe(1 + hexLen + 2);
  let off = 0;
  out[off++] = ':'.charCodeAt(0);
  for (let i = 0; i < body.length; i++) {
    const [hi, lo] = toHexByte(body[i]);
    out[off++] = hi;
    out[off++] = lo;
  }
  {
    const [hi, lo] = toHexByte(lrcValue);
    out[off++] = hi;
    out[off++] = lo;
  }
  out[off++] = '\r'.charCodeAt(0);
  out[off++] = '\n'.charCodeAt(0);
  return out;
}

/** Build an ASCII exception frame. */
export function asciiExceptionFrame(unit: number, fc: number, exceptionCode: number): Buffer {
  return asciiFrame(unit, fc | 0x80, Buffer.from([exceptionCode]));
}
