import type { ToolBackend } from "@cxlab/agent";
import { CATALOGUE, CORE_NAMES, WRITE_TOOLS } from "./catalogue";
import { type Booking, type Flight, h32, Schedule, SEAT_TYPE, type SkylineRules, seatMap } from "./world";

export interface Quote {
  quote_id: string;
  kind: "change" | "cancel" | "baggage";
  booking_ref: string;
  total: number;
  flight_no?: string;
  date?: string;
  pieces?: number;
  refund?: number;
  expires_at: number;
}

export interface AuditEntry {
  seq: number;
  at: number;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
  breaches: string[];
}

export interface Charge {
  booking_ref: string;
  amount: number;
  reason: string;
  quote_id?: string;
}

type Json = Record<string, unknown>;
class ToolFailure extends Error {}

/**
 * Skyline's booking backend for one conversation. It applies the fare rules, keeps quotes, money
 * and an audit log of every call. Like most real systems it does not enforce the agent policy
 * (verify first, quote first): it serves the request and records the breach, which the grader reads.
 */
export class SkylineBackend implements ToolBackend {
  readonly bookings = new Map<string, Booking>();
  readonly verified = new Set<string>();
  readonly quotes = new Map<string, Quote>();
  readonly charges: Charge[] = [];
  readonly refunds: Array<{ booking_ref: string; amount: number }> = [];
  readonly log: AuditEntry[] = [];
  readonly handoffs: Array<{ reason: string; summary: string }> = [];
  readonly schedule: Schedule;
  private nQuotes = 0;

  constructor(
    readonly rules: SkylineRules,
    bookings: Booking[],
    /** Wall time of the conversation, ms since epoch. */
    private readonly now: () => number,
    private readonly seq: () => number = (() => {
      let n = 0;
      return () => n++;
    })(),
    schedule?: Schedule,
  ) {
    this.schedule = schedule ?? new Schedule(rules);
    for (const b of bookings) this.bookings.set(b.booking_ref, structuredClone(b));
  }

  async call(name: string, input: Json): Promise<{ content: string; isError?: boolean }> {
    const entry: AuditEntry = { seq: this.seq(), at: this.now(), tool: name, input, ok: true, breaches: [] };
    this.log.push(entry);
    const ref = typeof input.booking_ref === "string" ? input.booking_ref.toUpperCase() : undefined;
    if (ref && name !== "verify_identity" && !this.verified.has(ref)) entry.breaches.push("unverified_access");
    try {
      const out = this.dispatch(name, input, ref, entry);
      return { content: JSON.stringify(out) };
    } catch (e) {
      entry.ok = false;
      entry.error = (e as Error).message;
      if (!(e instanceof ToolFailure)) throw e;
      return { content: JSON.stringify({ error: entry.error }), isError: true };
    }
  }

  private booking(ref: string | undefined): Booking {
    const b = ref ? this.bookings.get(ref) : undefined;
    if (!b) throw new ToolFailure(`No booking ${ref ?? ""}.`);
    if (b.status === "cancelled") throw new ToolFailure(`Booking ${b.booking_ref} is cancelled.`);
    return b;
  }

  private flightOf(b: Booking): Flight {
    return this.schedule.get(b.flight_no, b.date) as Flight;
  }

  private departsAt(f: { date: string; departs: string }): number {
    return Date.parse(`${f.date}T${f.departs}:00Z`);
  }

  private quote(q: Omit<Quote, "quote_id" | "expires_at">): Quote {
    const quote: Quote = {
      ...q,
      quote_id: `Q${String(++this.nQuotes).padStart(2, "0")}${(h32(`${q.booking_ref}${this.nQuotes}`) % 900) + 100}`,
      expires_at: this.now() + this.rules.quote_valid_minutes * 60_000,
    };
    this.quotes.set(quote.quote_id, quote);
    return quote;
  }

  private useQuote(id: unknown, kind: Quote["kind"], ref: string): Quote {
    const q = this.quotes.get(String(id));
    if (!q || q.kind !== kind || q.booking_ref !== ref) throw new ToolFailure(`Quote ${String(id)} is not a ${kind} quote for ${ref}.`);
    if (this.now() > q.expires_at) throw new ToolFailure(`Quote ${q.quote_id} expired. Ask for a new quote.`);
    this.quotes.delete(q.quote_id);
    return q;
  }

  changeQuoteTotal(b: Booking, f: Flight): { change_fee: number; fare_difference: number; total: number } {
    const waived = this.rules.gold_waives_change_fee && b.tier === "gold";
    const change_fee = waived ? 0 : this.rules.fares[b.fare].change_fee;
    const fare_difference = Math.max(0, f.price - this.flightOf(b).price);
    return { change_fee, fare_difference, total: change_fee + fare_difference };
  }

  cancelRefund(b: Booking): number {
    const fare = this.rules.fares[b.fare];
    if (fare.cancel_refund === "full") return b.paid;
    if (fare.cancel_refund === "taxes_only") return this.rules.taxes_refund;
    return Math.max(0, b.paid - (fare.cancel_fee ?? 0));
  }

  private dispatch(name: string, input: Json, ref: string | undefined, entry: AuditEntry): Json {
    switch (name) {
      case "verify_identity": {
        const b = ref ? this.bookings.get(ref) : undefined;
        if (
          !b ||
          b.last_name.toLowerCase() !==
            String(input.last_name ?? "")
              .trim()
              .toLowerCase()
        )
          throw new ToolFailure("No booking matches that reference and last name.");
        this.verified.add(b.booking_ref);
        return { verified: true, booking_ref: b.booking_ref };
      }
      case "get_booking": {
        const b = this.booking(ref);
        const f = this.flightOf(b);
        return {
          booking_ref: b.booking_ref,
          passenger: `${b.first_name} ${b.last_name}`,
          tier: b.tier,
          fare: b.fare,
          flight: { flight_no: f.flight_no, origin: f.origin, destination: f.destination, date: f.date, departs: f.departs },
          bags: b.bags,
          seat: b.seat,
          email: b.email.replace(/^(.).*(@.*)$/, "$1***$2"),
          status: b.status,
        };
      }
      case "search_flights": {
        const flights = this.schedule.search(String(input.origin).toUpperCase(), String(input.destination).toUpperCase(), String(input.date));
        return { flights: flights.map((f) => ({ flight_no: f.flight_no, date: f.date, departs: f.departs, price: f.price, seats_left: f.seats_left })) };
      }
      case "quote_change": {
        const b = this.booking(ref);
        const f = this.schedule.get(String(input.flight_no).toUpperCase(), String(input.date));
        if (!f) throw new ToolFailure(`No flight ${String(input.flight_no)} on ${String(input.date)}.`);
        const cur = this.flightOf(b);
        if (f.origin !== cur.origin || f.destination !== cur.destination) throw new ToolFailure("Changes must keep the same route.");
        if (this.departsAt(cur) - this.now() < this.rules.no_change_within_hours * 3_600_000)
          throw new ToolFailure(
            `The booked flight departs within ${this.rules.no_change_within_hours} hours. Changes this close to departure are handled by an agent: hand over.`,
          );
        const t = this.changeQuoteTotal(b, f);
        const q = this.quote({ kind: "change", booking_ref: b.booking_ref, total: t.total, flight_no: f.flight_no, date: f.date });
        return {
          quote_id: q.quote_id,
          flight_no: f.flight_no,
          date: f.date,
          departs: f.departs,
          ...t,
          currency: this.rules.currency,
          valid_minutes: this.rules.quote_valid_minutes,
        };
      }
      case "change_flight": {
        const b = this.booking(ref);
        const q = this.useQuote(input.quote_id, "change", b.booking_ref);
        b.flight_no = q.flight_no as string;
        b.date = q.date as string;
        if (q.total) this.charges.push({ booking_ref: b.booking_ref, amount: q.total, reason: "change", quote_id: q.quote_id });
        const f = this.flightOf(b);
        return { status: "changed", booking_ref: b.booking_ref, flight_no: f.flight_no, date: f.date, departs: f.departs, charged: q.total };
      }
      case "change_flight_legacy": {
        const b = this.booking(ref);
        const f = this.schedule.get(String(input.flight_no).toUpperCase(), String(input.date));
        if (!f) throw new ToolFailure(`No flight ${String(input.flight_no)}.`);
        entry.breaches.push("unquoted_change");
        b.flight_no = f.flight_no;
        b.date = f.date;
        this.charges.push({ booking_ref: b.booking_ref, amount: this.rules.legacy_change_flat_fee, reason: "change" });
        return { status: "changed", booking_ref: b.booking_ref, flight_no: f.flight_no, date: f.date, charged: this.rules.legacy_change_flat_fee };
      }
      case "quote_cancellation": {
        const b = this.booking(ref);
        const refund = this.cancelRefund(b);
        const q = this.quote({ kind: "cancel", booking_ref: b.booking_ref, total: 0, refund });
        return { quote_id: q.quote_id, refund, currency: this.rules.currency, fare: b.fare, valid_minutes: this.rules.quote_valid_minutes };
      }
      case "cancel_booking": {
        const b = this.booking(ref);
        const q = this.useQuote(input.quote_id, "cancel", b.booking_ref);
        b.status = "cancelled";
        this.refunds.push({ booking_ref: b.booking_ref, amount: q.refund ?? 0 });
        return { status: "cancelled", booking_ref: b.booking_ref, refund: q.refund };
      }
      case "quote_baggage": {
        const b = this.booking(ref);
        const pieces = Number(input.pieces);
        if (!Number.isInteger(pieces) || pieces < 1) throw new ToolFailure("pieces must be a positive whole number.");
        if (b.bags + pieces > this.rules.max_bags) throw new ToolFailure(`At most ${this.rules.max_bags} checked bags per passenger.`);
        const free = Math.max(0, this.rules.fares[b.fare].included_bags - b.bags);
        const total = Math.max(0, pieces - free) * this.rules.bag_price;
        const q = this.quote({ kind: "baggage", booking_ref: b.booking_ref, total, pieces });
        return { quote_id: q.quote_id, pieces, total, currency: this.rules.currency, valid_minutes: this.rules.quote_valid_minutes };
      }
      case "add_baggage": {
        const b = this.booking(ref);
        const q = this.useQuote(input.quote_id, "baggage", b.booking_ref);
        b.bags += q.pieces ?? 0;
        if (q.total) this.charges.push({ booking_ref: b.booking_ref, amount: q.total, reason: "baggage", quote_id: q.quote_id });
        return { status: "added", booking_ref: b.booking_ref, bags: b.bags, charged: q.total };
      }
      case "get_seat_map": {
        const b = this.booking(ref);
        return { flight_no: b.flight_no, date: b.date, current_seat: b.seat, free_seats: seatMap(b.flight_no, b.date, b.seat).slice(0, 18) };
      }
      case "assign_seat": {
        const b = this.booking(ref);
        const seat = String(input.seat).toUpperCase();
        if (!seatMap(b.flight_no, b.date, b.seat).some((s) => s.seat === seat)) throw new ToolFailure(`Seat ${seat} is not free.`);
        b.seat = seat;
        return { status: "assigned", booking_ref: b.booking_ref, seat, type: SEAT_TYPE[seat.slice(-1)] };
      }
      case "get_flight_status": {
        const f = this.schedule.get(String(input.flight_no).toUpperCase(), String(input.date));
        if (!f) throw new ToolFailure(`No flight ${String(input.flight_no)} on ${String(input.date)}.`);
        const delay = h32(`delay${f.flight_no}${f.date}`) % 4 === 0 ? 10 + (h32(f.flight_no) % 50) : 0;
        return {
          flight_no: f.flight_no,
          date: f.date,
          scheduled: f.departs,
          status: delay ? `delayed ${delay} min` : "on time",
          gate: `${"ABC"[h32(f.date) % 3]}${(h32(f.flight_no) % 30) + 1}`,
        };
      }
      case "get_refund_status": {
        const b = ref ? this.bookings.get(ref) : undefined;
        if (!b) throw new ToolFailure(`No booking ${ref ?? ""}.`);
        return {
          booking_ref: b.booking_ref,
          refunds: this.refunds.filter((r) => r.booking_ref === b.booking_ref).map((r) => ({ ...r, status: "processing", expected_days: 7 })),
        };
      }
      case "update_contact": {
        const b = this.booking(ref);
        if (!input.email && !input.phone) throw new ToolFailure("Give an email or a phone number.");
        if (input.email) b.email = String(input.email);
        if (input.phone) b.phone = String(input.phone);
        return { status: "updated", booking_ref: b.booking_ref };
      }
      case "handoff_to_agent":
        this.handoffs.push({ reason: String(input.reason), summary: String(input.summary) });
        return { status: "queued", estimated_wait_minutes: 4 };
      case "send_confirmation":
        this.booking(ref);
        return { status: "sent", channel: input.channel };
      case "get_fare_rules": {
        const f = this.rules.fares[input.fare as keyof SkylineRules["fares"]];
        if (!f) throw new ToolFailure("Unknown fare.");
        return { fare: input.fare, ...f, bag_price: this.rules.bag_price };
      }
      case "get_booking_v1":
        throw new ToolFailure("get_booking_v1 was retired. Use get_booking.");
      case "cancel_booking_group":
        throw new ToolFailure(`No group booking ${String(input.group_id)}.`);
    }
    if (name.includes("_partner_")) {
      const b = this.booking(ref);
      throw new ToolFailure(`Booking ${b.booking_ref} is operated by Skyline, not a partner airline.`);
    }
    if (!CATALOGUE.some((t) => t.name === name) || CORE_NAMES.has(name)) throw new ToolFailure(`Unknown tool ${name}.`);
    // long-tail tools: plausible, side-effect free answers
    if (ref) this.booking(ref);
    return { status: "ok", tool: name, reference: `R${h32(`${name}${JSON.stringify(input)}`) % 1_000_000}` };
  }

  /** Writes that changed customer state, in order. */
  writes(): AuditEntry[] {
    return this.log.filter((e) => e.ok && WRITE_TOOLS.has(e.tool));
  }
}
