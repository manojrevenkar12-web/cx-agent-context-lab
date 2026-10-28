// A rolling 64-bit hash (two independent 32-bit FNV-1a lanes) over token ids. Prefix identity is
// what both providers cache on, so the simulators key their entries by these hashes.

export class RollingHash {
  private a = 0x811c9dc5;
  private b = 0x01000193 ^ 0x9e3779b9;

  push(n: number): void {
    // feed the 4 bytes of the id into both lanes
    for (let s = 0; s < 32; s += 8) {
      const byte = (n >>> s) & 0xff;
      this.a = Math.imul(this.a ^ byte, 0x01000193) >>> 0;
      this.b = Math.imul(this.b ^ byte, 0x01000193 + 0x2c) >>> 0;
    }
  }

  pushAll(ns: readonly number[]): void {
    for (const n of ns) this.push(n);
  }

  digest(): string {
    return this.a.toString(16).padStart(8, "0") + this.b.toString(16).padStart(8, "0");
  }
}
