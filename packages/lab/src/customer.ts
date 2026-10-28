import { rng } from "@cxlab/skyline";
import { CHATTER, numberWord, spokenDate } from "./language";
import type { Goal, Scenario } from "./scenario";

/**
 * A simulated customer. It knows its goals and facts, reveals them when asked (or up front),
 * notices when it is asked for something it already said, and gives up and asks for a person
 * after too many repeats. It only sees what the agent says, like a real caller.
 */
export class SimCustomer {
  repeatAsks = 0;
  frustrated = false;
  handedOff = false;
  finished = false;
  turns = 0;
  private told = new Set<string>();
  private done = new Set<number>();
  private pendingConfirm: Goal["intent"] | undefined;
  private lastRaised: Goal | undefined;
  private closing = false;
  private chatterLeft: number;
  private r: () => number;

  constructor(
    private readonly s: Scenario,
    seed: number,
    private readonly flightNo: string,
    private readonly o: { maxRepeatAsks: number; chatterProbability: number },
  ) {
    this.r = rng(`${s.id}:${seed}`);
    this.chatterLeft = s.chatter;
  }

  get goalsReached(): number {
    return this.done.size;
  }

  /** The first goal, in the caller's own order, that is not done yet. */
  private current(): Goal | undefined {
    return this.s.goals.find((_, i) => !this.done.has(i));
  }

  /** Filler talk appended to an answer while the scenario's chatter lasts. */
  private filler(): string {
    if (this.chatterLeft <= 0 || this.r() >= this.o.chatterProbability) return "";
    // talkative callers say more per turn: the burst grows with the scenario's chatter
    const n = Math.min(this.chatterLeft, Math.max(1, Math.ceil(this.s.chatter / 8)));
    this.chatterLeft -= n;
    return Array.from({ length: n }, () => CHATTER[Math.floor(this.r() * CHATTER.length)] as string).join(" ");
  }

  private identity(): string {
    this.told.add("identity");
    return `My booking reference is ${this.s.booking.ref} and the last name is ${this.s.customer.last_name}.`;
  }

  private details(g: Goal): string {
    switch (g.intent) {
      case "change_flight":
        this.told.add("prefer");
        return g.prefer ? `${g.prefer === "midday" ? "Around midday" : `In the ${g.prefer}`}, if possible.` : "I don't mind the time.";
      case "add_bag":
        this.told.add("pieces");
        return `${numberWord(g.pieces)[0]?.toUpperCase()}${numberWord(g.pieces).slice(1)} bag${g.pieces === 1 ? "" : "s"}.`;
      case "seat":
        this.told.add("seat");
        return `${g.prefer === "aisle" ? "An aisle" : "A window"} seat, please.`;
      case "update_contact":
        this.told.add("contact");
        return `The new one is ${g.email ?? g.phone}.`;
      default:
        return "";
    }
  }

  /** How the customer raises a goal: the intent, and details when they reveal everything at once. */
  private statement(g: Goal, withDetails: boolean): string {
    this.told.add(`intent:${g.intent}`);
    const d = withDetails ? ` ${this.details(g)}` : "";
    switch (g.intent) {
      case "change_flight":
        this.told.add("date");
        return `I need to move my flight to a different day, to ${spokenDate(g.date)}.${d}`;
      case "add_bag":
        return `I'd like to add checked bags to my booking.${d}`;
      case "seat":
        return `I'd like to change my seat.${d}`;
      case "cancel":
        return "I need to cancel my booking.";
      case "refund_status":
        return "I'm calling about the status of my refund, it still hasn't arrived.";
      case "flight_status":
        return `Is my flight ${this.flightNo} on ${spokenDate(this.s.booking.date)} on time?`;
      case "update_contact":
        return `I need to update the email or phone number on my booking.${d}`;
      case "claim":
        return `I'd like to make a complaint. ${g.text}`;
      case "assistance":
        return "I'll need wheelchair assistance at the airport.";
    }
  }

  opening(): string {
    this.turns++;
    const first = this.current() as Goal;
    if (this.s.reveal === "upfront") {
      const rest = this.s.goals.slice(1).map((g) => `I also want to sort out something else: ${this.statement(g, true)}`);
      return `Hi. ${this.identity()} ${this.statement(first, true)} ${rest.join(" ")}`.trim();
    }
    return `Hi. ${this.statement(first, false)}`;
  }

  /** Raising the next open goal once the agent asks whether there is anything else. */
  private next(): string {
    const g = this.current();
    if (!g) {
      this.closing = true;
      return "No, that's everything. Thanks!";
    }
    // raising the same thing again because the agent did not pick it up is a repeat
    if (this.lastRaised === g) this.repeatAsks++;
    this.lastRaised = g;
    if (this.told.has(`intent:${g.intent}`)) {
      return `Yes, the other thing I mentioned earlier: ${LABEL[g.intent]}.`;
    }
    return `Yes, one more thing. ${this.statement(g, this.s.reveal === "upfront")}`;
  }

  private repeat(key: string): void {
    if (this.told.has(key)) this.repeatAsks++;
  }

  private open(intent: Goal["intent"]): Goal | undefined {
    return this.s.goals.find((g, i) => g.intent === intent && !this.done.has(i));
  }

  private finish(intent: Goal["intent"]): void {
    const i = this.s.goals.findIndex((g, k) => g.intent === intent && !this.done.has(k));
    if (i >= 0) this.done.add(i);
  }

  /** The customer's reply, or null when the conversation is over. */
  reply(agent: string): string | null {
    if (this.closing || /pass(ing)? you to a colleague/i.test(agent)) {
      this.handedOff = /colleague/i.test(agent);
      this.finished = true;
      return null;
    }
    if (/Thank you for calling/i.test(agent)) {
      this.finished = true;
      return null;
    }
    this.turns++;
    // what the agent says it finished
    for (const [re, intent] of DONE) if (re.test(agent)) this.finish(intent);
    if (/left it as it is/i.test(agent) && this.pendingConfirm) this.finish(this.pendingConfirm);
    // sometimes a caller talks about something else before answering: a turn of its own
    if (this.chatterLeft > 0 && !/Shall I go ahead\?|Is that right\?|anything else/i.test(agent) && this.r() < this.o.chatterProbability / 2) {
      this.chatterLeft--;
      return `Sorry, one second. ${CHATTER[Math.floor(this.r() * CHATTER.length)]}`;
    }
    const parts: string[] = [];
    if (/booking reference|last name/i.test(agent)) {
      this.repeat("identity");
      parts.push(this.identity());
    }
    const change = this.open("change_flight");
    if (change?.intent === "change_flight" && /which date/i.test(agent)) {
      this.repeat("date");
      this.told.add("date");
      parts.push(`On ${spokenDate(change.date)}.`);
    }
    if (change && /morning, midday or evening/i.test(agent)) {
      this.repeat("prefer");
      parts.push(this.details(change));
    }
    const asks: Array<[RegExp, Goal["intent"], string]> = [
      [/how many bags/i, "add_bag", "pieces"],
      [/window or an aisle/i, "seat", "seat"],
      [/new email address or phone/i, "update_contact", "contact"],
    ];
    for (const [re, intent, key] of asks) {
      const g = this.open(intent);
      if (g && re.test(agent)) {
        this.repeat(key);
        parts.push(this.details(g));
      }
    }
    const g = this.current();
    if (/How can I help/i.test(agent) && g) {
      this.repeat(`intent:${g.intent}`);
      parts.push(this.statement(g, this.s.reveal === "upfront"));
    }
    if (this.repeatAsks > this.o.maxRepeatAsks && !this.frustrated) {
      this.frustrated = true;
      return "I've already told you that. Can I speak to a person, please?";
    }
    if (/Shall I go ahead\?|Is that right\?/.test(agent)) {
      const intent: Goal["intent"] = /move you to/.test(agent)
        ? "change_flight"
        : /cancel/.test(agent)
          ? "cancel"
          : /\bbags?\b/.test(agent)
            ? "add_bag"
            : "update_contact";
      const target = this.open(intent);
      this.pendingConfirm = intent;
      const accept = target ? ("accept" in target ? target.accept : true) : false;
      parts.push(accept ? "Yes, please go ahead." : target ? "No, leave it as it is, thanks." : "No, I didn't ask for that.");
    } else if (/anything else/i.test(agent)) {
      parts.push(this.next());
    }
    if (!parts.length && /\?\s*$/.test(agent) && g) {
      // a question that has nothing to do with what the caller wants: they say what they want again
      this.repeat(`intent:${g.intent}`);
      parts.push(`Sorry, that's not what I asked about. ${this.statement(g, false)}`);
    }
    if (!parts.length) parts.push("Okay.");
    // filler talk goes after the answer, so a yes or no still opens the reply
    return `${parts.join(" ")} ${this.filler()}`.trim();
  }
}

const LABEL: Record<Goal["intent"], string> = {
  change_flight: "the change of flight",
  add_bag: "the extra bags",
  seat: "my seat",
  cancel: "I want to cancel the booking",
  refund_status: "where is my refund",
  flight_status: "my flight status",
  update_contact: "the update to my email or phone",
  claim: "my complaint",
  assistance: "the assistance",
};

/** How the customer recognises that the agent finished something. */
const DONE: Array<[RegExp, Goal["intent"]]> = [
  [/You're now on/i, "change_flight"],
  [/checked bags? on the booking|So I can't add those/i, "add_bag"],
  [/Your seat is now|no free (window|aisle) seats/i, "seat"],
  [/booking is cancelled/i, "cancel"],
  [/contact details are updated/i, "update_contact"],
  [/is (on time|delayed)/i, "flight_status"],
  [/refund of|any refunds/i, "refund_status"],
];
