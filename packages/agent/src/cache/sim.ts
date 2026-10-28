import type { AnthropicPricing, OpenAIPricing } from "../config";
import type { RenderedBlock } from "../render";
import { placeBreakpoints } from "./breakpoints";
import { RollingHash } from "./hash";

/** How one request's input tokens split between cache reads, cache writes and plain input. */
export interface CacheSplit {
  read: number;
  write: number;
  uncached: number;
  /** Block index (Anthropic) or token count (OpenAI) the read reached; -1 / 0 for a miss. */
  hitAt: number;
  breakpoints: number[];
}

export interface CacheSim {
  apply(blocks: readonly RenderedBlock[], cacheOn: boolean, nowMs: number): CacheSplit;
  readonly entries: number;
}

class Entries {
  private m = new Map<string, number>();
  constructor(private readonly ttlMs: number) {}
  valid(key: string, now: number): boolean {
    const t = this.m.get(key);
    return t !== undefined && now - t <= this.ttlMs;
  }
  touch(key: string, now: number): void {
    this.m.set(key, now);
    if (this.m.size > 200_000) this.prune(now);
  }
  prune(now: number): void {
    for (const [k, t] of this.m) if (now - t > this.ttlMs) this.m.delete(k);
  }
  get size(): number {
    return this.m.size;
  }
}

/**
 * Anthropic prompt caching as documented: entries are written at explicit breakpoints only; a
 * request reads the longest cached prefix that ends at a block boundary at most `lookback_blocks`
 * blocks before one of its breakpoints; prefixes below the model's minimum are not cached; a hit
 * refreshes the entry's TTL. Tokens from the read point to the last breakpoint are billed as writes,
 * tokens after it as plain input. The cache is shared by every conversation of the organisation.
 */
export class AnthropicCacheSim implements CacheSim {
  private e: Entries;
  constructor(private readonly cfg: AnthropicPricing["cache"]) {
    this.e = new Entries(cfg.ttl_seconds * 1000);
  }

  get entries(): number {
    return this.e.size;
  }

  apply(blocks: readonly RenderedBlock[], cacheOn: boolean, now: number): CacheSplit {
    const total = blocks.reduce((n, b) => n + b.tokens.length, 0);
    if (!cacheOn) return { read: 0, write: 0, uncached: total, hitAt: -1, breakpoints: [] };
    const bps = placeBreakpoints(blocks, this.cfg.max_breakpoints);
    const h = new RollingHash();
    const hashes: string[] = [];
    const cum: number[] = [];
    let n = 0;
    for (const b of blocks) {
      h.push(b.kind === "tool" ? 1 : b.kind === "system" ? 2 : 3);
      h.pushAll(b.tokens);
      n += b.tokens.length;
      hashes.push(h.digest());
      cum.push(n);
    }
    let hit = -1;
    for (const bp of bps) {
      for (let j = bp; j >= Math.max(0, bp - this.cfg.lookback_blocks + 1); j--) {
        if (this.e.valid(hashes[j] as string, now)) {
          hit = Math.max(hit, j);
          break;
        }
      }
    }
    const read = hit >= 0 ? (cum[hit] as number) : 0;
    if (hit >= 0) this.e.touch(hashes[hit] as string, now);
    let lastWrite = -1;
    for (const bp of bps) {
      if (bp <= hit || (cum[bp] as number) < this.cfg.min_tokens) continue;
      this.e.touch(hashes[bp] as string, now);
      lastWrite = bp;
    }
    const write = lastWrite >= 0 ? (cum[lastWrite] as number) - read : 0;
    return { read, write, uncached: total - read - write, hitAt: hit, breakpoints: bps };
  }
}

/**
 * OpenAI automatic prompt caching: any prompt of `min_tokens`+ is cached in `increment_tokens`
 * steps; a request reads the longest cached token prefix. There is no write surcharge, so writes are
 * reported as plain input. Routing overflow (very high request rates on one prefix spilling to
 * machines without the entry) is not modelled; the README lists it under limits.
 */
export class OpenAICacheSim implements CacheSim {
  private e: Entries;
  constructor(private readonly cfg: OpenAIPricing["cache"]) {
    this.e = new Entries(cfg.ttl_seconds * 1000);
  }

  get entries(): number {
    return this.e.size;
  }

  apply(blocks: readonly RenderedBlock[], cacheOn: boolean, now: number): CacheSplit {
    const total = blocks.reduce((n, b) => n + b.tokens.length, 0);
    if (!cacheOn || total < this.cfg.min_tokens) return { read: 0, write: 0, uncached: total, hitAt: 0, breakpoints: [] };
    const h = new RollingHash();
    const boundaries: Array<[number, string]> = [];
    let n = 0;
    let next = this.cfg.min_tokens;
    for (const b of blocks) {
      for (const t of b.tokens) {
        h.push(t);
        n++;
        if (n === next) {
          boundaries.push([n, h.digest()]);
          next += this.cfg.increment_tokens;
        }
      }
    }
    let read = 0;
    for (let i = boundaries.length - 1; i >= 0; i--) {
      const [len, key] = boundaries[i] as [number, string];
      if (this.e.valid(key, now)) {
        read = len;
        break;
      }
    }
    for (const [, key] of boundaries) this.e.touch(key, now);
    return { read, write: 0, uncached: total - read, hitAt: read, breakpoints: [] };
  }
}
