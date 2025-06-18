export function checkRange(value: number, range?: [number, number]): boolean;
export function checkRange(values: number[], range?: [number, number]): boolean;
export function checkRange(value: any, range?: [number, number]): boolean {
  if (range && range[0] < range[1]) {
    return (Array.isArray(value) ? value : [value]).every((n) => n >= range[0] && n <= range[1]);
  }
  return true;
}
