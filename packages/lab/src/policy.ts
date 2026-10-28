import { type Block, type ModelRequest, type Responder, type SimConfig, SUMMARIZER_PROMPT, text, textOf } from "@cxlab/agent";
import { h32, rng, SIBLINGS } from "@cxlab/skyline";
import { activeIntent, extractFacts, type Facts, type FlightOpt, type QuoteFact, summaryText } from "./facts";
import { money, numberWord, Q, spokenDate } from "./language";

/**
 * The simulated model. It behaves like a careful agent that follows Skyline's policies, with two
 * honest limits: it only knows what is in the request it gets (so context strategies matter), and
 * it sometimes picks a confusable sibling tool, more often the more tool definitions it can see
 * (an ASSUMPTION curve in config/sim.yaml, not a measurement). Everything else a real model can get
 * wrong is out of scope here and is what a live run (LAB_LIVE=1) is for.
 */

const SEARCH_QUERY: Record<string, string> = {
  verify_identity: "verify caller identity booking reference last name",
  get_booking: "get booking details",
  search_flights: "search flights between airports on a date",
  quote_change: "quote price of changing flight",
  change_flight: "change flight on booking with quote",
  quote_cancellation: "quote cancellation refund",
  cancel_booking: "cancel booking with cancellation quote",
  quote_baggage: "quote price adding checked bags",
  add_baggage: "add checked bags with baggage quote",
  get_seat_map: "seat map free seats",
  assign_seat: "assign seat to passenger",
  get_flight_status: "live flight status",
  get_refund_status: "status of refunds",
  update_contact: "update email phone contact",
  handoff_to_agent: "hand over conversation to human agent",
};

const NEXT_LABEL: Record<string, string> = {
  change_flight: "moving your flight",
  add_bag: "the bags you mentioned",
  seat: "your seat",
  cancel: "the cancellation",
  update_contact: "your contact details",
  refund_status: "your refund",
  flight_status: "your flight's status",
  claim: "your complaint",
  assistance: "the assistance you need",
};

const SIBLING_NAMES = new Set(Object.values(SIBLINGS).flat());

export function slotOf(departs: string): "morning" | "midday" | "evening" {
  const h = Number(departs.slice(0, 2));
  return h < 11 ? "morning" : h < 16 ? "midday" : "evening";
}

export function siblingProbability(sim: SimConfig, visibleDefs: number): number {
  const t = sim.tool_selection;
  const doublings = Math.max(0, Math.log2(visibleDefs / t.per_doubling_over));
  return Math.min(t.max, t.base + t.slope_per_doubling * doublings);
}

export class SkylinePolicy implements Responder {
  constructor(
    private readonly sim: SimConfig,
    private readonly year: number,
  ) {}

  respond(req: ModelRequest): Block[] {
    if (req.system[0]?.text === SUMMARIZER_PROMPT) {
      return [text(summaryText(req.messages.map(textOf).join("\n"), this.sim.summary.keeps, this.year))];
    }
    return new Turn(req, extractFacts(req.messages, this.year), this.sim).decide();
  }
}

class Turn {
  private readonly names: Set<string>;
  private readonly mode: "all" | "append" | "dispatch";
  private readonly seed: string;
  private n = 0;

  constructor(
    private readonly req: ModelRequest,
    private readonly f: Facts,
    private readonly sim: SimConfig,
  ) {
    this.names = new Set(req.tools.map((t) => t.name));
    this.mode = this.names.has("call_tool") ? "dispatch" : this.names.has("tool_search") ? "append" : "all";
    const last = req.messages.at(-1);
    this.seed = `${req.messages.length}:${last ? JSON.stringify(last.content).slice(0, 400) : ""}`;
  }

  private say(s: string): Block[] {
    return [text(s)];
  }

  private visible(name: string): boolean {
    return this.mode === "dispatch" ? this.f.defsInContext.has(name) : this.names.has(name);
  }

  private visibleCount(): number {
    return this.mode === "dispatch" ? 2 + this.f.defsInContext.size : this.req.tools.length;
  }

  private call(name: string, input: Record<string, unknown>): Block {
    const id = `tu_${h32(`${this.seed}:${this.n++}:${name}`).toString(36)}`;
    return this.mode === "dispatch" ? { type: "tool_use", id, name: "call_tool", input: { name, arguments: input } } : { type: "tool_use", id, name, input };
  }

  /** Call a tool, finding it first if its definition is not in view, maybe picking a sibling. */
  private act(target: string, input: Record<string, unknown>, sibling?: Record<string, unknown>): Block[] {
    const lead = this.f.lastRole === "user" && !this.f.lastIsToolResults ? [text(Q.hold)] : [];
    if (this.mode !== "all" && !this.visible(target)) {
      const id = `tu_${h32(`${this.seed}:search:${target}`).toString(36)}`;
      return [...lead, { type: "tool_use", id, name: "tool_search", input: { query: SEARCH_QUERY[target] ?? target.replace(/_/g, " ") } }];
    }
    let chosen = target;
    const sibs = (SIBLINGS[target] ?? []).filter((s) => this.visible(s) && !this.f.failed.has(s));
    if (sibs.length) {
      const r = rng(`${this.seed}:${target}`);
      if (r() < siblingProbability(this.sim, this.visibleCount())) chosen = sibs[Math.floor(r() * sibs.length)] as string;
    }
    const args = chosen === "change_flight_legacy" && sibling ? sibling : input;
    return [...lead, this.call(chosen, args)];
  }

  private lastOutcomes() {
    const last = this.req.messages.length - 1;
    return this.f.outcomes.filter((o) => o.idx === last);
  }

  private handoff(reason: string): Block[] {
    const f = this.f;
    return this.act("handoff_to_agent", {
      reason,
      summary: `${f.verifiedRef ? `Verified caller on ${f.verifiedRef}` : "Caller not verified"}. Wants: ${f.intents.join(", ") || "unknown"}.`,
    });
  }

  private validQuote(kind: QuoteFact["kind"], match: (q: QuoteFact) => boolean): QuoteFact | undefined {
    const qs = this.f.quotes.filter((q) => q.kind === kind && !this.f.usedQuotes.has(q.id) && match(q));
    const q = qs.at(-1);
    if (!q) return undefined;
    const expired = this.f.outcomes.some((o) => !o.ok && o.idx > q.idx && /expired/.test(String(o.data.error)));
    return expired ? undefined : q;
  }

  /** A quote the customer has just accepted: act on it, whatever else has scrolled out of view. */
  private accepted(kind: QuoteFact["kind"]): QuoteFact | undefined {
    const f = this.f;
    if (f.told?.kind !== kind || f.answer !== "yes") return undefined;
    const told = f.told.idx;
    return this.validQuote(kind, (q) => q.idx < told);
  }

  /** After finishing one thing, a good agent carries on with what else the caller asked for. */
  private carryOn(done: string): string {
    const rest = this.f.intents.filter((i) => !this.f.completed.has(i) && !this.f.declined.has(i) && i !== done);
    return rest.length ? `Next, ${NEXT_LABEL[rest[0] as string] ?? "the other thing you asked about"}.` : Q.anything;
  }

  decide(): Block[] {
    const f = this.f;
    // 1. say what the last tool calls returned
    if (f.lastIsToolResults) {
      for (const o of this.lastOutcomes()) {
        if (o.tool === "handoff_to_agent" && o.ok) return this.say(Q.handoff);
        if (!o.ok && /hand over|handled by an agent/i.test(String(o.data.error))) return this.handoff("Change too close to departure");
        if (!o.ok && o.tool === "verify_identity") return this.say(Q.identityRetry);
        if (!o.ok && o.tool === "quote_baggage" && /At most/.test(String(o.data.error)))
          return this.say(`${String(o.data.error)} So I can't add those. ${Q.anything}`);
        if (!o.ok && (SIBLING_NAMES.has(o.tool) || /expired/.test(String(o.data.error)))) continue; // plan again below
        if (!o.ok) return this.handoff(`Tool error: ${String(o.data.error)}`);
        const d = o.data;
        switch (o.tool) {
          case "change_flight":
          case "change_flight_legacy":
            return this.say(
              `Done. You're now on ${d.flight_no} on ${spokenDate(String(d.date))}${d.departs ? ` at ${d.departs}` : ""}${Number(d.charged) ? `, and ${money(Number(d.charged))} goes to the card on the booking` : ""}. ${this.carryOn("change_flight")}`,
            );
          case "add_baggage":
            return this.say(
              `Done. You now have ${numberWord(Number(d.bags))} checked bag${Number(d.bags) === 1 ? "" : "s"} on the booking. ${this.carryOn("add_bag")}`,
            );
          case "assign_seat":
            return this.say(`Done. Your seat is now ${d.seat}, ${d.type === "aisle" ? "an aisle" : `a ${d.type}`} seat. ${this.carryOn("seat")}`);
          case "cancel_booking":
            return this.say(`Your booking is cancelled. ${money(Number(d.refund))} will be refunded to the card within seven days. ${this.carryOn("cancel")}`);
          case "update_contact":
            return this.say(`Done, your contact details are updated. ${this.carryOn("update_contact")}`);
          case "get_flight_status":
            return this.say(
              `${d.flight_no} on ${spokenDate(String(d.date))} is ${d.status}, scheduled at ${d.scheduled} from gate ${d.gate}. ${this.carryOn("flight_status")}`,
            );
          case "get_refund_status": {
            const rs = d.refunds as Array<{ amount: number; expected_days: number }>;
            return this.say(
              rs.length
                ? `Your refund of ${money(rs[0]?.amount ?? 0)} is being processed and should arrive within ${rs[0]?.expected_days} days. ${this.carryOn("refund_status")}`
                : `I can't see any refunds on this booking yet. ${this.carryOn("refund_status")}`,
            );
          }
          case "quote_change": {
            const parts = [
              Number(d.change_fee) ? `the ${money(Number(d.change_fee))} change fee` : "",
              Number(d.fare_difference) ? `${money(Number(d.fare_difference))} fare difference` : "",
            ].filter(Boolean);
            return this.say(
              `I can move you to ${d.flight_no} on ${spokenDate(String(d.date))} at ${d.departs}. The total is ${money(Number(d.total))}${parts.length ? `: ${parts.join(" plus ")}` : ""}. ${Q.proceed}`,
            );
          }
          case "quote_baggage":
            return this.say(
              `Adding ${numberWord(Number(d.pieces))} bag${Number(d.pieces) === 1 ? "" : "s"} costs ${money(Number(d.total))} in total. ${Q.proceed}`,
            );
          case "quote_cancellation":
            return this.say(`If you cancel, ${money(Number(d.refund))} will be refunded under your ${d.fare} fare. ${Q.proceed}`);
        }
      }
    }
    // 2. the customer's answer to a question just asked
    if (!f.lastIsToolResults && f.answer === "no" && f.told && f.told.idx === this.req.messages.length - 2) return this.say(`${Q.declined} ${Q.anything}`);
    if (f.wantsHuman) return this.handoff("Customer asked for a person");
    const intent = activeIntent(f);
    if (!intent) return this.say(f.closed ? Q.closing : f.completed.size || f.declined.size ? Q.anything : Q.open);
    if (intent === "claim") return this.handoff("Compensation or baggage claim");
    if (intent === "assistance") return this.handoff("Special assistance request");
    if (intent === "flight_status" && f.status.flight_no && f.status.date)
      return this.act("get_flight_status", { flight_no: f.status.flight_no, date: f.status.date });
    // 3. identity before anything on a booking
    if (!f.ref || !f.last) return this.say(Q.identity);
    if (f.verifiedRef !== f.ref) return this.act("verify_identity", { booking_ref: f.ref, last_name: f.last });
    const b = f.booking?.ref === f.ref ? f.booking : undefined;
    if (!b) return this.act("get_booking", { booking_ref: f.ref }, undefined);
    const ref = b.ref;
    switch (intent) {
      case "flight_status":
        return this.act("get_flight_status", { flight_no: b.flight_no, date: b.date });
      case "refund_status":
        return this.act("get_refund_status", { booking_ref: ref });
      case "change_flight": {
        const ok = this.accepted("change");
        if (ok) return this.act("change_flight", { booking_ref: ref, quote_id: ok.id }, { booking_ref: ref, flight_no: ok.flight_no, date: ok.date });
        const date = f.change.date;
        if (!date) return this.say(Q.date);
        if (!f.change.prefer) return this.say(Q.prefer);
        const flights = f.searches.get(date);
        if (!flights) return this.act("search_flights", { origin: b.origin, destination: b.destination, date });
        const pick: FlightOpt | undefined =
          flights.find((x) => slotOf(x.departs) === f.change.prefer && x.seats_left > 0) ?? flights.find((x) => x.seats_left > 0);
        if (!pick) return this.handoff("No seats on the requested date");
        const q = this.validQuote("change", (x) => x.flight_no === pick.flight_no && x.date === date);
        if (!q) return this.act("quote_change", { booking_ref: ref, flight_no: pick.flight_no, date });
        if (f.told?.kind === "change" && f.told.idx > q.idx && f.answer === "yes")
          return this.act("change_flight", { booking_ref: ref, quote_id: q.id }, { booking_ref: ref, flight_no: pick.flight_no, date });
        return this.say(`I can move you to ${pick.flight_no} on ${spokenDate(date)} at ${pick.departs}. The total is ${money(q.total)}. ${Q.proceed}`);
      }
      case "add_bag": {
        const ok = this.accepted("baggage");
        if (ok) return this.act("add_baggage", { booking_ref: ref, quote_id: ok.id });
        const pieces = f.bag.pieces;
        if (!pieces) return this.say(Q.pieces);
        const q = this.validQuote("baggage", (x) => x.pieces === pieces);
        if (!q) return this.act("quote_baggage", { booking_ref: ref, pieces });
        if (f.told?.kind === "baggage" && f.told.idx > q.idx && f.answer === "yes") return this.act("add_baggage", { booking_ref: ref, quote_id: q.id });
        return this.say(`Adding ${numberWord(pieces)} bag${pieces === 1 ? "" : "s"} costs ${money(q.total)} in total. ${Q.proceed}`);
      }
      case "cancel": {
        const ok = this.accepted("cancel");
        if (ok) return this.act("cancel_booking", { booking_ref: ref, quote_id: ok.id });
        const q = this.validQuote("cancel", () => true);
        if (!q) return this.act("quote_cancellation", { booking_ref: ref });
        if (f.told?.kind === "cancel" && f.told.idx > q.idx && f.answer === "yes") return this.act("cancel_booking", { booking_ref: ref, quote_id: q.id });
        return this.say(`If you cancel, ${money(q.refund ?? 0)} will be refunded. ${Q.proceed}`);
      }
      case "seat": {
        if (!f.seat.prefer) return this.say(Q.seat);
        if (!f.seatMap) return this.act("get_seat_map", { booking_ref: ref });
        const seat = f.seatMap.find((s) => s.type === f.seat.prefer);
        if (!seat) return this.say(`There are no free ${f.seat.prefer} seats on this flight, so I've kept your seat ${b.seat}. ${Q.anything}`);
        return this.act("assign_seat", { booking_ref: ref, seat: seat.seat });
      }
      case "update_contact": {
        const { email, phone } = f.contact;
        if (!email && !phone) return this.say(Q.contact);
        if (f.told?.kind === "contact" && f.answer === "yes")
          return this.act("update_contact", { booking_ref: ref, ...(email ? { email } : {}), ...(phone ? { phone } : {}) });
        return this.say(`I'll update your ${email ? `email to ${email}` : `phone number to ${phone}`}. ${Q.right}`);
      }
      default:
        return this.say(Q.open);
    }
  }
}
