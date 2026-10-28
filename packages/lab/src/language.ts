// The words the simulated customer and the simulated model share. A live run replaces both
// with real speech and a real model; the lab's limits section says so.

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function spokenDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

/** "14 November" or "November 14" or an ISO date in free text; year is taken from `year`. */
export function parseDate(text: string, year: number): string | undefined {
  const iso = text.match(/\b(20\d\d-\d\d-\d\d)\b/);
  if (iso) return iso[1];
  const re = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})\\b|\\b(${MONTHS.join("|")})\\s+(\\d{1,2})\\b`, "i");
  const m = text.match(re);
  if (!m) return undefined;
  const day = Number(m[1] ?? m[4]);
  const month = MONTHS.findIndex((x) => x.toLowerCase() === String(m[2] ?? m[3]).toLowerCase()) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, a: 1, single: 1 };
export const numberWord = (n: number) => ["zero", "one", "two", "three"][n] ?? String(n);

export const money = (n: number) => `€${Number.isInteger(n) ? n : n.toFixed(2)}`;

export const Q = {
  identity: "Could you tell me your booking reference and the passenger's last name?",
  identityRetry: "I couldn't find a booking with those details. Could you check the booking reference and last name for me?",
  date: "Which date would you like to fly instead?",
  prefer: "Would you prefer a morning, midday or evening departure?",
  pieces: "How many bags would you like to add?",
  seat: "Would you like a window or an aisle seat?",
  contact: "What's the new email address or phone number?",
  open: "How can I help you today?",
  proceed: "Shall I go ahead?",
  right: "Is that right?",
  anything: "Is there anything else I can help with?",
  hold: "One moment while I check that.",
  closing: "Thank you for calling Skyline Air. Have a good trip.",
  handoff: "I'm passing you to a colleague who can help with this. Please stay on the line.",
  declined: "No problem, I've left it as it is.",
};

export const INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/\b(change|move|rebook|switch)\b[^.?!]{0,40}\bflight\b|\bdifferent (day|date)\b|\bmove my booking\b/i, "change_flight"],
  [/\bcancel\b/i, "cancel"],
  [/\b(add|check(ed)?|bring|extra)\b[^.?!]{0,30}\b(bag|bags|suitcase|luggage)\b|\bbaggage\b/i, "add_bag"],
  [/\b(seat|aisle|window)\b/i, "seat"],
  [/\brefund\b[^.?!]{0,30}\b(status|where|arrived|yet|still)\b|\bwhere is my refund\b|\bstatus of my refund\b/i, "refund_status"],
  [/\b(on time|delayed|flight status|status of (my|the) flight|which gate)\b/i, "flight_status"],
  [/\b(update|change|new)\b[^.?!]{0,30}\b(email|e-mail|phone|number)\b/i, "update_contact"],
  [/\b(compensation|complain|complaint|lost (my )?(bag|luggage|suitcase)|damaged)\b/i, "claim"],
  [/\b(wheelchair|assistance|help getting to the gate)\b/i, "assistance"],
];

export const HUMAN = /\b(speak|talk) to (a |an |some)?(human|person|someone|agent|colleague)\b|\breal person\b/i;
export const YES = /^\s*(yes|yeah|yep|sure|ok|okay|please do|go ahead|that's (right|fine|correct)|sounds good|correct)\b/i;
export const NO = /^\s*(no|nope|don't|leave it|not now)\b/i;
export const CLOSE = /\b(that's (all|everything)|nothing else|no,? (thanks|thank you)\b)/i;

export const CHATTER = [
  "Sorry, I'm at the station and it's really loud here, they keep making announcements about platform changes and I can barely hear myself think.",
  "Bear with me, I'm juggling my bag and a coffee and my phone keeps buzzing with messages from work about a meeting I'm going to miss anyway.",
  "My sister was supposed to book this for me but she got the dates mixed up, which is very typical of her, she once sent me to the wrong city for a wedding.",
  "I've been on hold with another company for ages, so it's nice to finally get through, honestly the music they play is driving me mad.",
  "The weather here has been awful all week, rain every single day, so I'm really hoping it's better when I land, otherwise I packed all the wrong clothes.",
  "Sorry, my kids are shouting in the background, they're excited about the trip and keep asking whether there will be snacks on the plane.",
  "I tried doing this in the app first but it kept logging me out every time I got to the last screen, so I gave up and called instead.",
  "Just so you know, I might lose signal for a second, I'm about to go through a tunnel, but I'll stay on the line if that's alright.",
  "I'm travelling for my cousin's birthday, it's a big one this year, and the whole family is flying in from different places so the timing matters a lot.",
  "Last time I flew the queue at security took forever, I nearly missed the flight, so I'm trying to be a bit more organised this time around.",
  "I'm writing all of this down on the back of an envelope because I can never find anything in my email when I actually need it.",
  "Sorry if I sound distracted, I'm cooking at the same time and the pasta is about to boil over, give me just a moment to turn the heat down.",
  "My colleague recommended Skyline, she flies with you every month for work and says the crew are always lovely and the seats are comfier than on other airlines.",
  "I'm not great with these things, my partner usually handles the bookings, but they're away this week so it's all on me for once.",
  "The train I'm on just stopped in the middle of nowhere, there's an announcement about a signal problem, so I've got time to sort this out at least.",
  "Honestly I've been putting this call off for days, I kept thinking the plans would change again, but now it's finally settled.",
];
