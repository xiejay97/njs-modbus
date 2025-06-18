export enum ErrorCode {
  ILLEGAL_FUNCTION = 0x01,
  ILLEGAL_DATA_ADDRESS = 0x02,
  ILLEGAL_DATA_VALUE = 0x03,
  SERVER_DEVICE_FAILURE = 0x04,
  ACKNOWLEDGE = 0x05,
  SERVER_DEVICE_BUSY = 0x06,
  MEMORY_PARITY_ERROR = 0x08,
  GATEWAY_PATH_UNAVAILABLE = 0x0a,
  GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND = 0x0b,
}

const PREFIX = 'MODBUS_ERROR_CODE_';
export function getErrorByCode(code: ErrorCode) {
  return new Error(PREFIX + code);
}
export function getCodeByError(err: Error): ErrorCode {
  if (err.message.startsWith(PREFIX)) {
    return Number(err.message.slice(PREFIX.length));
  }
  return ErrorCode.SERVER_DEVICE_FAILURE;
}
