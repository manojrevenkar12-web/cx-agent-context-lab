import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "@cxlab/agent";
import type { Booking } from "@cxlab/skyline";
import { parse } from "yaml";
import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const GoalSchema = z.discriminatedUnion("intent", [
  z.strictObject({
    intent: z.literal("change_flight"),
    date: isoDate,
    prefer: z.enum(["morning", "midday", "evening"]).optional(),
    accept: z.boolean().default(true),
  }),
  z.strictObject({ intent: z.literal("add_bag"), pieces: z.number().int().min(1).max(3), accept: z.boolean().default(true) }),
  z.strictObject({ intent: z.literal("seat"), prefer: z.enum(["window", "aisle"]) }),
  z.strictObject({ intent: z.literal("cancel"), accept: z.boolean().default(true) }),
  z.strictObject({ intent: z.literal("refund_status") }),
  z.strictObject({ intent: z.literal("flight_status") }),
  z.strictObject({ intent: z.literal("update_contact"), email: z.string().email().optional(), phone: z.string().optional() }),
  z.strictObject({ intent: z.literal("claim"), text: z.string() }),
  z.strictObject({ intent: z.literal("assistance") }),
]);
export type Goal = z.infer<typeof GoalSchema>;
export type Intent = Goal["intent"];

export const ScenarioSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  channel: z.enum(["voice", "chat"]),
  call_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .optional(),
  customer: z.strictObject({ first_name: z.string(), last_name: z.string() }),
  booking: z.strictObject({
    ref: z.string().regex(/^[A-Z0-9]{6}$/),
    fare: z.enum(["light", "classic", "flex"]),
    tier: z.enum(["basic", "silver", "gold"]),
    route: z.string().regex(/^[A-Z]{3}-[A-Z]{3}$/),
    date: isoDate,
    slot: z.enum(["morning", "midday", "evening"]),
    bags: z.number().int().min(0).max(3).default(0),
    seat: z
      .string()
      .regex(/^\d{1,2}[A-F]$/)
      .default("21B"),
    paid: z.number().positive(),
  }),
  reveal: z.enum(["upfront", "on_ask"]).default("on_ask"),
  chatter: z.number().int().min(0).default(0),
  goals: z.array(GoalSchema).min(1),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export function loadScenarios(dir: string): Scenario[] {
  const abs = join(ROOT, dir);
  return readdirSync(abs)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .flatMap((f) => {
      const doc = parse(readFileSync(join(abs, f), "utf8")) as unknown;
      const list = Array.isArray(doc) ? doc : [doc];
      return list.map((s, i) => {
        const r = ScenarioSchema.safeParse(s);
        if (!r.success) throw new Error(`${dir}/${f}[${i}]: ${r.error.message}`);
        return r.data;
      });
    });
}

/** The scenario's booking as the backend stores it; the flight comes from the timetable. */
export function bookingOf(s: Scenario, flightNo: string): Booking {
  return {
    booking_ref: s.booking.ref,
    first_name: s.customer.first_name,
    last_name: s.customer.last_name,
    fare: s.booking.fare,
    tier: s.booking.tier,
    flight_no: flightNo,
    date: s.booking.date,
    paid: s.booking.paid,
    bags: s.booking.bags,
    seat: s.booking.seat,
    email: `${s.customer.first_name}.${s.customer.last_name}@example.com`.toLowerCase(),
    phone: "+49 30 5550 1234",
    status: "confirmed",
  };
}
