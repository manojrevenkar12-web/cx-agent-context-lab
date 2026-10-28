/**
 * Time for the agent and the lab. A virtual clock lets hundreds of overlapping conversations run in
 * seconds and in the same order every time: each task sleeps on the clock, and the clock jumps to the
 * earliest wake-up once every task is waiting. Cache TTLs and customer think times use it.
 */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface Timer {
  at: number;
  seq: number;
  wake: () => void;
}

const settle = () => new Promise<void>((r) => setImmediate(r));

export class VirtualClock implements Clock {
  private t: number;
  private seq = 0;
  private timers: Timer[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((wake) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, wake });
    });
  }

  /**
   * Run tasks to completion on virtual time. Tasks must only wait on this clock (no real I/O), so
   * that "every task is waiting" can be detected by letting the event loop settle.
   */
  async run<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
    let done = 0;
    let failed: unknown;
    const results: T[] = new Array(tasks.length);
    tasks.forEach((task, i) => {
      task()
        .then((r) => {
          results[i] = r;
        })
        .catch((e) => {
          failed ??= e;
        })
        .finally(() => {
          done++;
        });
    });
    await settle();
    while (done < tasks.length) {
      if (failed) throw failed;
      if (this.timers.length === 0) {
        await settle();
        if (this.timers.length === 0 && done < tasks.length) throw new Error("virtual clock: tasks waiting on something other than the clock");
        continue;
      }
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers.shift() as Timer;
      this.t = Math.max(this.t, next.at);
      next.wake();
      await settle();
    }
    if (failed) throw failed;
    return results;
  }
}
