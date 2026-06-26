/**
 * Reservoir sampler for latency streams.
 *
 * Vitter Algorithm R over a fixed Float64Array. Keeps an unbiased subset of
 * all observations so percentiles reflect the whole window, not just the end.
 */

export class Reservoir {
  readonly samples: Float64Array;
  readonly capacity: number;
  seen: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.samples = new Float64Array(capacity);
    this.seen = 0;
  }

  push(value: number): void {
    if (this.seen < this.capacity) {
      this.samples[this.seen] = value;
      this.seen++;
      return;
    }
    const j = Math.floor(Math.random() * (this.seen + 1));
    if (j < this.capacity) {
      this.samples[j] = value;
    }
    this.seen++;
  }

  toArray(): number[] {
    const valid = Math.min(this.seen, this.capacity);
    const out = new Array<number>(valid);
    for (let i = 0; i < valid; i++) {
      out[i] = this.samples[i];
    }
    return out;
  }

  get overflowed(): boolean {
    return this.seen > this.capacity;
  }
}
