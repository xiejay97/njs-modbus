export function lrc(data: Uint8Array) {
  return (~data.reduce((sum, n) => sum + n, 0) + 1) & 0xff;
}
