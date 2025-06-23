export function checkRange(value: number | number[], range?: [number, number] | [number, number][]): boolean {
  if (range) {
    if (typeof range[0] === 'number' && typeof range[1] === 'number') {
      if (range[0] < range[1]) {
        return (Array.isArray(value) ? value : [value]).every(
          (n) => n >= (range as [number, number])[0] && n <= (range as [number, number])[1],
        );
      }
    } else if (range.length > 0) {
      for (const r of range) {
        if ((r as [number, number])[0] < (r as [number, number])[1]) {
          if ((Array.isArray(value) ? value : [value]).every((n) => n >= (r as [number, number])[0] && n <= (r as [number, number])[1])) {
            return true;
          }
        }
      }
      return false;
    }
  }
  return true;
}
