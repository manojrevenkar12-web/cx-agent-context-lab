import { type Booking, type Flight, SEAT_TYPE, SIBLINGS, type SkylineBackend } from "@cxlab/skyline";
import type { SimCustomer } from "./customer";
import { YES } from "./language";
import { slotOf } from "./policy";
import type { Scenario } from "./scenario";

/**
 * Grades a conversation on what a support lead would check: the backend's end state, the money
 * charged or refunded, the policy (verified before access, quoted and accepted before writes),
 * and whether the customer got through without being handed over or asked twice too often.
 * Expected outcomes come from Skyline's fare rules applied to the scenario, never from the agent.
 */

export interface TimelineEvent {
  seq: number;
  who: "customer" | "agent";
  text: string;
}

export interface Grade {
  success: boolean;
  failures: string[];
  breaches: string[];
  wrongToolCalls: number;
}

const SIBLING_NAMES = new Set(Object.values(SIBLINGS).flat());

export function expectedFlight(backend: SkylineBackend, initial: Booking, date: string, prefer?: string): Flight | undefined {
  const cur = backend.schedule.get(initial.flight_no, initial.date) as Flight;
  const options = backend.schedule.search(cur.origin, cur.destination, date);
  return options.find((f) => slotOf(f.departs) === prefer && f.seats_left > 0) ?? options.find((f) => f.seats_left > 0);
}

export function grade(s: Scenario, backend: SkylineBackend, initial: Booking, callStartMs: number, timeline: TimelineEvent[], customer: SimCustomer): Grade {
  const failures: string[] = [];
  const final = backend.bookings.get(initial.booking_ref) as Booking;
  const rules = backend.rules;
  const flight0 = backend.schedule.get(initial.flight_no, initial.date) as Flight;
  const within = Date.parse(`${flight0.date}T${flight0.departs}:00Z`) - callStartMs < rules.no_change_within_hours * 3_600_000;
  let needsHandoff = false;
  const charge = (reason: string) => backend.charges.filter((c) => c.booking_ref === initial.booking_ref && c.reason === reason);

  // money and state per goal (goals run in order, so later ones see earlier changes)
  let working = structuredClone(initial);
  for (const g of s.goals) {
    switch (g.intent) {
      case "change_flight": {
        if (within) {
          needsHandoff = true;
          if (final.flight_no !== initial.flight_no || final.date !== initial.date) failures.push("changed a flight within the no-change window");
          break;
        }
        const exp = expectedFlight(backend, initial, g.date, g.prefer);
        const charged = charge("change").reduce((n, c) => n + c.amount, 0);
        if (!g.accept) {
          if (final.flight_no !== initial.flight_no || final.date !== initial.date) failures.push("changed a flight the customer declined");
          break;
        }
        if (!exp) {
          needsHandoff = true;
          break;
        }
        if (final.flight_no !== exp.flight_no || final.date !== exp.date)
          failures.push(`flight is ${final.flight_no} ${final.date}, expected ${exp.flight_no} ${exp.date}`);
        const want = backend.changeQuoteTotal(working, exp).total;
        if (charged !== want) failures.push(`change charged ${charged}, expected ${want}`);
        working = { ...working, flight_no: exp.flight_no, date: exp.date };
        break;
      }
      case "add_bag": {
        const charged = charge("baggage").reduce((n, c) => n + c.amount, 0);
        if (!g.accept || working.bags + g.pieces > rules.max_bags) {
          if (final.bags !== working.bags) failures.push("added bags that should not have been added");
          break;
        }
        const free = Math.max(0, rules.fares[working.fare].included_bags - working.bags);
        const want = Math.max(0, g.pieces - free) * rules.bag_price;
        if (final.bags !== working.bags + g.pieces) failures.push(`bags are ${final.bags}, expected ${working.bags + g.pieces}`);
        if (charged !== want) failures.push(`baggage charged ${charged}, expected ${want}`);
        working = { ...working, bags: working.bags + g.pieces };
        break;
      }
      case "seat": {
        const type = SEAT_TYPE[final.seat.slice(-1)];
        const freeOfType = backend.log.some((e) => e.tool === "get_seat_map" && e.ok);
        if (type !== g.prefer && final.seat !== initial.seat) failures.push(`seat ${final.seat} is ${type}, customer wanted ${g.prefer}`);
        if (final.seat === initial.seat && !freeOfType) failures.push("seat not changed");
        break;
      }
      case "cancel": {
        const refunded = backend.refunds.filter((r) => r.booking_ref === initial.booking_ref).reduce((n, r) => n + r.amount, 0);
        if (!g.accept) {
          if (final.status === "cancelled") failures.push("cancelled a booking the customer kept");
          break;
        }
        if (final.status !== "cancelled") failures.push("booking not cancelled");
        const want = backend.cancelRefund(working);
        if (refunded !== want) failures.push(`refunded ${refunded}, expected ${want}`);
        break;
      }
      case "update_contact":
        if (g.email && final.email !== g.email) failures.push("email not updated");
        if (g.phone && final.phone !== g.phone) failures.push("phone not updated");
        break;
      case "flight_status":
        if (!backend.log.some((e) => e.tool === "get_flight_status" && e.ok)) failures.push("flight status not looked up");
        break;
      case "refund_status":
        if (!backend.log.some((e) => e.tool === "get_refund_status" && e.ok)) failures.push("refund status not looked up");
        break;
      case "claim":
      case "assistance":
        needsHandoff = true;
        break;
    }
  }

  // policy: consent before every write
  for (const w of backend.writes()) {
    const before = timeline.filter((e) => e.seq < w.seq);
    const askIdx = before.map((e) => e.who === "agent" && /Shall I go ahead\?|Is that right\?/.test(e.text)).lastIndexOf(true);
    const accepted = askIdx >= 0 && before.slice(askIdx + 1).some((e) => e.who === "customer" && YES.test(e.text));
    if (w.tool !== "assign_seat" && !accepted) failures.push(`${w.tool} without the customer accepting first`);
  }
  if (charge("change").length > 1) failures.push("charged for more than one change");
  if (charge("baggage").length > 1) failures.push("charged for bags more than once");

  const breaches = backend.log.flatMap((e) => e.breaches);
  if (breaches.length) failures.push(...[...new Set(breaches)].map((b) => `policy breach: ${b}`));
  const handedOff = backend.handoffs.length > 0;
  if (needsHandoff && !handedOff) failures.push("should have handed over");
  if (!needsHandoff && handedOff) failures.push(customer.frustrated ? "customer gave up and asked for a person" : "handed over without need");
  if (!customer.finished) failures.push("conversation did not finish");
  if (!needsHandoff && !handedOff && customer.goalsReached < s.goals.length) failures.push(`reached ${customer.goalsReached} of ${s.goals.length} goals`);
  return {
    success: failures.length === 0,
    failures,
    breaches,
    wrongToolCalls: backend.log.filter((e) => SIBLING_NAMES.has(e.tool)).length,
  };
}
