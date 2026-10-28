import { readYaml } from "@cxlab/agent";
import { z } from "zod";

const Fare = z.strictObject({
  change_fee: z.number(),
  cancel_refund: z.enum(["taxes_only", "minus_fee", "full"]),
  cancel_fee: z.number().optional(),
  included_bags: z.number().int(),
});

export const SkylineSchema = z.strictObject({
  currency: z.string(),
  today: z.string(),
  schedule_days: z.number().int(),
  routes: z.array(z.string().regex(/^[A-Z]{3}-[A-Z]{3}$/)),
  slots: z.record(z.enum(["morning", "midday", "evening"]), z.string().regex(/^\d\d:\d\d$/)),
  fares: z.strictObject({ light: Fare, classic: Fare, flex: Fare }),
  taxes_refund: z.number(),
  bag_price: z.number(),
  max_bags: z.number().int(),
  gold_waives_change_fee: z.boolean(),
  legacy_change_flat_fee: z.number(),
  no_change_within_hours: z.number(),
  quote_valid_minutes: z.number(),
});
export type SkylineRules = z.infer<typeof SkylineSchema>;
export type FareName = keyof SkylineRules["fares"];
export type Slot = "morning" | "midday" | "evening";
export const SLOTS: readonly Slot[] = ["morning", "midday", "evening"];

export const loadSkyline = (): SkylineRules => SkylineSchema.parse(readYaml("config/skyline.yaml"));

/** Deterministic integer hash of a string (FNV-1a). */
export function h32(s: string): number {
  let x = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return x;
}

/** Seeded PRNG (mulberry32): the same seed gives the same sequence on every machine. */
export function rng(seed: string): () => number {
  let a = h32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Flight {
  flight_no: string;
  origin: string;
  destination: string;
  date: string; // YYYY-MM-DD
  departs: string; // HH:MM local
  slot: Slot;
  price: number;
  seats_left: number;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The timetable: every route, both directions, three departures a day. */
export class Schedule {
  private byKey = new Map<string, Flight[]>();
  private byNo = new Map<string, Flight>();

  constructor(readonly rules: SkylineRules) {
    const legs = rules.routes.flatMap((r) => {
      const [a, b] = r.split("-") as [string, string];
      return [
        [a, b],
        [b, a],
      ] as Array<[string, string]>;
    });
    legs.forEach(([o, d], li) => {
      SLOTS.forEach((slot, si) => {
        const no = `SK${100 + li * 3 + si}`;
        for (let day = -2; day < rules.schedule_days; day++) {
          const date = addDays(rules.today, day);
          const base = 70 + (h32(`${o}${d}`) % 90);
          const f: Flight = {
            flight_no: no,
            origin: o,
            destination: d,
            date,
            departs: rules.slots[slot] as string,
            slot,
            price: base + (h32(`${no}${date}`) % 60) + (slot === "evening" ? 25 : slot === "morning" ? 10 : 0),
            seats_left: 2 + (h32(`seats${no}${date}`) % 40),
          };
          const k = `${o}-${d}-${date}`;
          this.byKey.set(k, [...(this.byKey.get(k) ?? []), f]);
          this.byNo.set(`${no}@${date}`, f);
        }
      });
    });
  }

  search(origin: string, destination: string, date: string): Flight[] {
    return this.byKey.get(`${origin}-${destination}-${date}`) ?? [];
  }

  get(flightNo: string, date: string): Flight | undefined {
    return this.byNo.get(`${flightNo}@${date}`);
  }
}

export interface Booking {
  booking_ref: string;
  first_name: string;
  last_name: string;
  fare: FareName;
  tier: "basic" | "silver" | "gold";
  flight_no: string;
  date: string;
  paid: number;
  bags: number;
  seat: string;
  email: string;
  phone: string;
  status: "confirmed" | "cancelled";
}

/** Seat letters by type on Skyline's A320 cabin (3-3). */
export const SEAT_TYPE: Record<string, "window" | "middle" | "aisle"> = { A: "window", B: "middle", C: "aisle", D: "aisle", E: "middle", F: "window" };

export function seatMap(flightNo: string, date: string, taken: string): Array<{ seat: string; type: string }> {
  const out: Array<{ seat: string; type: string }> = [];
  for (let row = 8; row <= 28; row++) {
    for (const l of "ABCDEF") {
      const seat = `${row}${l}`;
      if (seat === taken) continue;
      if (h32(`${flightNo}${date}${seat}`) % 5 === 0) out.push({ seat, type: SEAT_TYPE[l] as string });
    }
  }
  return out;
}
