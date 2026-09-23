# Changelog

## [5.0.1](https://github.com/xiejay97/njs-modbus/compare/v5.0.0...v5.0.1) (2026-09-23)

### Bug Fixes

* **master:** settle broadcasts only at write completion ([7616af8](https://github.com/xiejay97/njs-modbus/commit/7616af8d00d0a192b89701d38b08d27219c5f742))
* return this from chainable master/slave methods and align docs with code ([bd0039a](https://github.com/xiejay97/njs-modbus/commit/bd0039af8a3f416bd6717240f5f3a7187e90a558))

## [5.0.0](https://github.com/xiejay97/njs-modbus/compare/v4.1.0...v5.0.0) (2026-08-04)

### ⚠ BREAKING CHANGES

* **master:** the `timeout` option and per-method `timeout` parameter are
  removed. Use `responseTimeout` (deadline for the first response byte, default
  1000 ms) and `totalTimeout` (optional hard cap on the full cycle; when omitted
  a stalled response may hang indefinitely).

### Features

* **master:** split timeout into responseTimeout and totalTimeout ([375422f](https://github.com/xiejay97/njs-modbus/commit/375422f8503f74fa8ce9ee310b699ee64f3229b9))

## [4.1.0](https://github.com/xiejay97/njs-modbus/compare/v4.0.1...v4.1.0) (2026-07-08)

### Features

* **error-code:** add getErrorCodeByMessage and embed exception code in message ([c31f1d0](https://github.com/xiejay97/njs-modbus/commit/c31f1d02f4ed718937b2d3857943b338b00b1bd4))

## [4.0.1](https://github.com/xiejay97/njs-modbus/compare/v4.0.0...v4.0.1) (2026-06-29)

### Bug Fixes

* **master,slave:** tighten writeSingleCoil value type to 0 | 1 ([d8f9f54](https://github.com/xiejay97/njs-modbus/commit/d8f9f548af90623deeaf33d21b2c292608eeedbf))
* **udp:** pass null error to open callback when already open ([a419389](https://github.com/xiejay97/njs-modbus/commit/a419389b3312c03c7de81a30b9a4ca514143743b))

## 4.0.0 (2026-06-26)

### Features

* initial commit ([967ca30](https://github.com/xiejay97/njs-modbus/commit/967ca303fbbbee7bc5bce499aea11af92fbecad2))
