import type { Message } from "@cxlab/agent";
import { CLOSE, HUMAN, INTENT_PATTERNS, NO, NUMBER_WORDS, parseDate, YES } from "./language";
import type { Intent } from "./scenario";

/**
 * What can be known from a set of messages and nothing else. The simulated model, the case-file
 * builder and the simulated summariser all read context through this, so a fact a context
 * strategy dropped is a fact the model does not have.
 */
export interface FlightOpt {
  flight_no: string;
  date: string;
  departs: string;
  price: number;
  seats_left: number;
}

export interface QuoteFact {
  kind: "change" | "cancel" | "baggage";
  id: string;
  total: number;
  refund?: number;
  flight_no?: string;
  date?: string;
  departs?: string;
  pieces?: number;
  idx: number;
}

export interface BookingFact {
  ref: string;
  origin: string;
  destination: string;
  flight_no: string;
  date: string;
  departs: string;
  fare: string;
  tier: string;
  bags: number;
  seat: string;
}

export type ToolOutcome = { idx: number; tool: string; ok: boolean; data: Record<string, unknown> };

export interface Facts {
  ref?: string;
  last?: string;
  verifiedRef?: string;
  booking?: BookingFact;
  intents: Intent[];
  completed: Set<Intent>;
  declined: Set<Intent>;
  change: { date?: string; prefer?: string };
  bag: { pieces?: number };
  seat: { prefer?: string };
  contact: { email?: string; phone?: string };
  status: { flight_no?: string; date?: string };
  searches: Map<string, FlightOpt[]>;
  quotes: QuoteFact[];
  usedQuotes: Set<string>;
  told?: { idx: number; kind: "change" | "cancel" | "baggage" | "contact" };
  answer?: "yes" | "no";
  seatMap?: Array<{ seat: string; type: string }>;
  failed: Map<string, string>; // tool -> last error
  outcomes: ToolOutcome[];
  wantsHuman: boolean;
  closed: boolean;
  handedOff: boolean;
  lastRole?: "user" | "assistant";
  lastIsToolResults: boolean;
  /** Tool definitions present in tool_search results in context (search-dispatch). */
  defsInContext: Set<string>;
  year: number;
}

const QUOTE_KINDS: Record<string, QuoteFact["kind"]> = { quote_change: "change", quote_cancellation: "cancel", quote_baggage: "baggage" };
const COMPLETES: Record<string, Intent> = {
  change_flight: "change_flight",
  change_flight_legacy: "change_flight",
  cancel_booking: "cancel",
  add_baggage: "add_bag",
  assign_seat: "seat",
  update_contact: "update_contact",
  get_flight_status: "flight_status",
  get_refund_status: "refund_status",
};

function parseJson(s: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function addIntent(f: Facts, i: Intent): void {
  if (!f.intents.includes(i)) f.intents.push(i);
}

/** Facts stated in customer words (or in a summary or case file written in the same words). */
export function readCustomerText(f: Facts, t: string, idx: number): void {
  const ref = t.match(/\b(?:booking reference|reference|ref)\b(?:\s+(?:is|was|:))?\s+([A-Z0-9]{6})\b/i);
  if (ref?.[1] && /[0-9]/.test(ref[1]) && /[A-Z]/i.test(ref[1])) f.ref = ref[1].toUpperCase();
  const last = t.match(/\b(?:last name|surname|family name)\b(?:\s+(?:is|:))?\s+([A-Z][a-zA-Z'-]+)/);
  if (last?.[1]) f.last = last[1];
  const found: Array<[number, Intent]> = [];
  for (const [re, intent] of INTENT_PATTERNS) {
    const m = re.exec(t);
    if (m) found.push([m.index, intent as Intent]);
  }
  for (const [, intent] of found.sort((a, b) => a[0] - b[0])) addIntent(f, intent);
  const date = parseDate(t, f.year);
  const flightNo = t.match(/\b(SK\d{3})\b/)?.[1];
  if (flightNo) {
    f.status.flight_no = flightNo;
    if (date) f.status.date = date;
  } else if (date && f.intents.includes("change_flight") && !f.completed.has("change_flight")) f.change.date = date;
  const pref = t.match(/\b(morning|midday|lunchtime|afternoon|evening)\b/i)?.[1]?.toLowerCase();
  if (pref) f.change.prefer = pref === "lunchtime" || pref === "afternoon" ? "midday" : pref;
  else if (/\b(don't mind|any time|whatever is earliest|whatever's earliest)\b/i.test(t)) f.change.prefer = "any";
  const pieces = t.match(/\b(one|two|three|a|single|[1-3])\s+(?:more\s+|extra\s+|checked\s+)?(?:bag|bags|suitcase|suitcases)\b/i)?.[1]?.toLowerCase();
  if (pieces) f.bag.pieces = NUMBER_WORDS[pieces] ?? Number(pieces);
  const seat = t.match(/\b(window|aisle)\b/i)?.[1]?.toLowerCase();
  if (seat) f.seat.prefer = seat;
  const email = t.match(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/)?.[0];
  if (email) f.contact.email = email;
  const phone = t.match(/\+\d[\d ]{7,}\d/)?.[0];
  if (phone) f.contact.phone = phone;
  if (HUMAN.test(t)) f.wantsHuman = true;
  if (CLOSE.test(t)) f.closed = true;
  if (f.told && idx > f.told.idx) {
    if (YES.test(t)) f.answer = "yes";
    else if (NO.test(t)) f.answer = "no";
  }
}

/** A case file or summary preamble: key: value lines and plain sentences. */
function readPreamble(f: Facts, t: string, idx: number): void {
  const about = t.match(/They called about: ([^.]+)\./);
  if (about?.[1]) for (const i of about[1].split(/,\s*/)) addIntent(f, i.trim() as Intent);
  const done = t.match(/Done so far: ([^.]+)\./);
  if (done?.[1]) for (const i of done[1].split(/,\s*/)) f.completed.add(i.trim() as Intent);
  t = t.replace(/They called about: [^.]+\.|Done so far: [^.]+\./g, "");
  for (const line of t.split("\n")) {
    const kv = line.match(/^([a-z_.]+):\s*(.+)$/);
    if (!kv) {
      readCustomerText(f, line, idx);
      continue;
    }
    const [, k, v] = kv as unknown as [string, string, string];
    if (k === "booking_ref") f.ref = v.trim();
    else if (k === "last_name") f.last = v.trim();
    else if (k === "verified") f.verifiedRef = v.trim();
    else if (k === "intents") for (const i of v.split(/,\s*/)) addIntent(f, i.trim() as Intent);
    else if (k === "completed") for (const i of v.split(/,\s*/)) f.completed.add(i.trim() as Intent);
    else if (k === "declined") for (const i of v.split(/,\s*/)) f.declined.add(i.trim() as Intent);
    else if (k === "booking") {
      const b = parseJson(v);
      if (b) f.booking = b as unknown as BookingFact;
    }
  }
}

export function extractFacts(messages: readonly Message[], year: number): Facts {
  const f: Facts = {
    intents: [],
    completed: new Set(),
    declined: new Set(),
    change: {},
    bag: {},
    seat: {},
    contact: {},
    status: {},
    searches: new Map(),
    quotes: [],
    usedQuotes: new Set(),
    failed: new Map(),
    outcomes: [],
    wantsHuman: false,
    closed: false,
    handedOff: false,
    lastIsToolResults: false,
    defsInContext: new Set(),
    year,
  };
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  messages.forEach((m, idx) => {
    f.lastRole = m.role;
    f.lastIsToolResults = m.role === "user" && m.content.some((b) => b.type === "tool_result");
    for (const b of m.content) {
      if (b.type === "text") {
        if (m.role === "assistant") {
          if (/Shall I go ahead\?|Is that right\?/.test(b.text)) {
            const kind = /move you to/.test(b.text) ? "change" : /cancel/.test(b.text) ? "cancel" : /\bbags?\b/.test(b.text) ? "baggage" : "contact";
            f.told = { idx, kind };
            f.answer = undefined;
          }
          if (/passing you to a colleague/.test(b.text)) f.handedOff = true;
        } else if (/^<case_file>|^<summary>/.test(b.text)) readPreamble(f, b.text.replace(/<\/?(case_file|summary)>/g, ""), idx);
        else if (!/^<context>/.test(b.text)) readCustomerText(f, b.text, idx);
      } else if (b.type === "tool_use") {
        const inner =
          b.name === "call_tool"
            ? { name: String(b.input.name), input: (b.input.arguments as Record<string, unknown>) ?? {} }
            : { name: b.name, input: b.input };
        uses.set(b.id, inner);
      } else if (b.type === "tool_result") {
        const use = uses.get(b.toolUseId);
        const tool = use?.name ?? "unknown";
        const data = parseJson(b.content) ?? { text: b.content };
        const ok = !b.isError;
        f.outcomes.push({ idx, tool, ok, data });
        if (!ok) {
          f.failed.set(tool, String(data.error ?? b.content));
          if (tool === "quote_baggage" && /At most/.test(String(data.error))) f.declined.add("add_bag");
          continue;
        }
        if (tool === "tool_search" && Array.isArray(data.tools)) for (const t of data.tools as Array<{ name: string }>) f.defsInContext.add(t.name);
        if (tool === "verify_identity" && data.verified) f.verifiedRef = String(data.booking_ref);
        if (tool === "get_booking" && data.flight) {
          const fl = data.flight as Record<string, unknown>;
          f.booking = {
            ref: String(data.booking_ref),
            origin: String(fl.origin),
            destination: String(fl.destination),
            flight_no: String(fl.flight_no),
            date: String(fl.date),
            departs: String(fl.departs),
            fare: String(data.fare),
            tier: String(data.tier),
            bags: Number(data.bags),
            seat: String(data.seat),
          };
        }
        if (tool === "search_flights" && Array.isArray(data.flights)) {
          const fl = data.flights as FlightOpt[];
          const date = fl[0]?.date ?? String(use?.input.date ?? "");
          f.searches.set(date, fl);
        }
        const qk = QUOTE_KINDS[tool];
        if (qk && data.quote_id) {
          f.quotes.push({
            kind: qk,
            id: String(data.quote_id),
            total: Number(data.total ?? 0),
            ...(data.refund !== undefined ? { refund: Number(data.refund) } : {}),
            ...(data.flight_no ? { flight_no: String(data.flight_no), date: String(data.date), departs: String(data.departs) } : {}),
            ...(data.pieces ? { pieces: Number(data.pieces) } : {}),
            idx,
          });
        }
        if (tool === "get_seat_map" && Array.isArray(data.free_seats)) f.seatMap = data.free_seats as Array<{ seat: string; type: string }>;
        if (tool === "handoff_to_agent") f.handedOff = true;
        const done = COMPLETES[tool];
        if (done) {
          f.completed.add(done);
          if (typeof use?.input.quote_id === "string") f.usedQuotes.add(use.input.quote_id);
          if (done === "change_flight" && f.booking && data.flight_no) {
            f.booking = { ...f.booking, flight_no: String(data.flight_no), date: String(data.date), departs: String(data.departs ?? f.booking.departs) };
          }
          if (done === "add_bag" && f.booking) f.booking = { ...f.booking, bags: Number(data.bags) };
          if (done === "seat" && f.booking) f.booking = { ...f.booking, seat: String(data.seat) };
        }
      }
    }
  });
  if (f.answer === "no" && f.told) {
    const intent: Intent =
      f.told.kind === "change" ? "change_flight" : f.told.kind === "cancel" ? "cancel" : f.told.kind === "baggage" ? "add_bag" : "update_contact";
    if (!f.completed.has(intent)) f.declined.add(intent);
  }
  return f;
}

export const ACTIVE_ORDER: Intent[] = ["claim", "assistance", "change_flight", "cancel", "add_bag", "seat", "update_contact", "refund_status", "flight_status"];

/** The first intent the customer raised that is neither done nor declined. */
export function activeIntent(f: Facts): Intent | undefined {
  return f.intents.find((i) => !f.completed.has(i) && !f.declined.has(i));
}

/**
 * The case file: what a CX platform's case record holds (schema v1). Code writes it from the
 * transcript; it is exact for what it holds, and it does not hold the customer's preferences.
 */
export function caseFileText(messages: readonly Message[], year: number): string {
  const f = extractFacts(messages, year);
  const lines: string[] = [];
  if (f.ref) lines.push(`booking_ref: ${f.ref}`);
  if (f.last) lines.push(`last_name: ${f.last}`);
  if (f.verifiedRef) lines.push(`verified: ${f.verifiedRef}`);
  if (f.booking) lines.push(`booking: ${JSON.stringify(f.booking)}`);
  if (f.intents.length) lines.push(`intents: ${f.intents.join(", ")}`);
  if (f.completed.size) lines.push(`completed: ${[...f.completed].join(", ")}`);
  if (f.declined.size) lines.push(`declined: ${[...f.declined].join(", ")}`);
  return lines.join("\n");
}

/** The simulated summariser: prose that keeps only the fact kinds in config/sim.yaml. */
export function summaryText(transcript: string, keeps: readonly string[], year: number): string {
  // only what the customer said; tool results only for what was completed
  const lines = transcript.split("\n");
  const said = lines
    .filter((l) => l.startsWith("Customer:"))
    .map((l) => l.slice("Customer:".length))
    .join("\n");
  const f = extractFacts([{ role: "user", content: [{ type: "text", text: said }] }], year);
  const results = lines.filter((l) => l.startsWith("Tool result:")).join("\n");
  const map: Record<string, Intent> = { changed: "change_flight", added: "add_bag", assigned: "seat", cancelled: "cancel", updated: "update_contact" };
  for (const m of results.matchAll(/"status":"(changed|added|assigned|cancelled|updated)"/g)) f.completed.add(map[m[1] as string] as Intent);
  if (/"scheduled":/.test(results)) f.completed.add("flight_status");
  if (/"refunds":/.test(results)) f.completed.add("refund_status");
  for (const i of f.completed) if (!f.intents.includes(i)) f.intents.push(i);
  const s: string[] = [];
  if (keeps.includes("last_name") && f.last) s.push(`The caller gave the last name ${f.last}.`);
  if (keeps.includes("booking_ref") && f.ref) s.push(`The booking reference is ${f.ref}.`);
  if (keeps.includes("intent") && f.intents.length) s.push(`They called about: ${f.intents.join(", ")}.`);
  if (keeps.includes("completed") && f.completed.size) s.push(`Done so far: ${[...f.completed].join(", ")}.`);
  return s.join(" ");
}
