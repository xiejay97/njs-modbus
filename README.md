# njs-modbus

A pure JavaScript implementation of MODBUS for NodeJS.

<div>

<!-- prettier-ignore-start -->
[![npm download](http://img.shields.io/npm/dw/njs-modbus.svg?style=flat-square)](http://www.npm-stats.com/~packages/njs-modbus)
[![npm latest package](http://img.shields.io/npm/v/njs-modbus/latest.svg?style=flat-square)](https://www.npmjs.com/package/njs-modbus)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/njs-modbus?style=flat-square)](https://bundlephobia.com/package/njs-modbus)
<!-- prettier-ignore-end -->

</div>

## Introduction

`njs-modbus` is designed as a layered architecture, including the physical layer and the application layer:

- Physical layer implements Serial Port, TCP/IP and UDP/IP.
- Application layer implements RTU, ASCII and TCP.

`njs-modbus` provide both client and server.

## Features

- Full modbus standard protocol implementation
- Support for custom function codes
- Support broadcasting
- Very lightweight project
- Full typescript

### Supported function codes

| Code  |                               |
| ----- | ----------------------------- |
| 01    | Read Coils                    |
| 02    | Read Discrete Inputs          |
| 03    | Read Holding Registers        |
| 04    | Read Input Register           |
| 05    | Write Single Coil             |
| 06    | Write Single Register         |
| 15    | Write Multiple Coils          |
| 16    | Write Multiple Registers      |
| 17    | Report Server ID              |
| 22    | Mask Write Register           |
| 23    | Read/Write Multiple Registers |
| 43/14 | Read device Identification    |

### Supported protocols

- Modbus RTU
- Modbus ASCII
- Modbus TCP/IP
- Modbus UDP/IP
- Modbus RTU/ASCII Over TCP/IP
- Modbus RTU/ASCII Over UDP/IP

#### Installation

```bash
npm install njs-modbus
```

## Examples

### Modbus RTU Master

```typescript
import { SerialPhysicalLayer, RtuApplicationLayer, ModbusMaster } from 'njs-modbus';

const physicalLayer = new SerialPhysicalLayer({ path: 'COM1', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
const applicationLayer = new RtuApplicationLayer(physicalLayer);

const modbusMaster = new ModbusMaster(applicationLayer, physicalLayer);

modbusMaster
  .open()
  .then(() => {
    console.log('opened');
    modbusMaster.readHoldingRegisters(1, 0, 10).then((res) => {
      console.log(res);
    });
  })
  .catch((error) => {
    console.log(error);
  });
```

### Modbus RTU Slave

```typescript
import { SerialPhysicalLayer, RtuApplicationLayer, ModbusSlave } from 'njs-modbus';

const MB_SERVER = {
  discreteInputs: new Map<number, boolean>(),
  coils: new Map<number, boolean>(),
  inputRegisters: new Map<number, number>(),
  holdingRegisters: new Map<number, number>(),
};

const physicalLayer = new SerialPhysicalLayer({ path: 'COM1', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 });
const applicationLayer = new RtuApplicationLayer(physicalLayer);

const modbusSlave = new ModbusSlave(
  {
    readDiscreteInputs: (address, length) => {
      return Array.from({ length }).map((_, i) => {
        const discreteInput = MB_SERVER.discreteInputs.get(address + i);
        if (typeof discreteInput === 'undefined') {
          return false;
        }
        return discreteInput;
      });
    },

    readCoils: (address, length) => {
      return Array.from({ length }).map((_, i) => {
        const coil = MB_SERVER.coils.get(address + i);
        if (typeof coil === 'undefined') {
          return false;
        }
        return coil;
      });
    },
    writeSingleCoil: (address, value) => {
      MB_SERVER.coils.set(address, value);
    },

    readInputRegisters: (address, length) => {
      return Array.from({ length }).map((_, i) => {
        const inputRegister = MB_SERVER.inputRegisters.get(address + i);
        if (typeof inputRegister === 'undefined') {
          return 0;
        }
        return inputRegister;
      });
    },

    readHoldingRegisters: (address, length) => {
      return Array.from({ length }).map((_, i) => {
        const holdingRegister = MB_SERVER.holdingRegisters.get(address + i);
        if (typeof holdingRegister === 'undefined') {
          return 0;
        }
        return holdingRegister;
      });
    },
    writeSingleRegister: (address, value) => {
      MB_SERVER.holdingRegisters.set(address, value);
    },

    reportServerId: () => ({ additionalData: [1, 2, 3] }),

    readDeviceIdentification: () => ({
      0x00: 'Basic:VendorName',
      0x01: 'Basic:ProductCode',
      0x02: 'Basic:MajorMinorRevision',
      0x03: 'Regular:VendorUrl',
      0x04: 'Regular:ProductName',
      0x05: 'Regular:ModelName',
      0x06: 'Regular:UserApplicationName',
      0x80: 'Extended:Extended',
      0xff: 'Extended:Extended',
    }),
  },
  applicationLayer,
  physicalLayer,
);

modbusSlave
  .open()
  .then(() => {
    console.log('opened');
  })
  .catch((error) => {
    console.log(error);
  });
```

For more advanced examples, check out [examples](/examples) included in the repository. If you have created any utilities that meet a specific need, feel free to submit them so others can benefit.

## Contributing

Please read our [contributing guide](/CODE_OF_CONDUCT.md) first.

## License

[![gitHub license](https://img.shields.io/github/license/xiejay97/njs-modbus?style=flat-square)](/LICENSE)
