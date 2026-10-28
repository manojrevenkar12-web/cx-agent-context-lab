import type { ToolDef } from "@cxlab/agent";

// Skyline's tool catalogue: the tools a real airline CX platform exposes to an agent. Around 20
// are needed for the lab's journeys; the rest are the long tail any large backend has (lounges,
// pets, invoices, partner and legacy variants). Size and confusable names are the point: they are
// what makes loading every definition expensive and error-prone.

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const REF = str("Six-character booking reference, for example QX7M2P.");

export const CORE: ToolDef[] = [
  {
    name: "verify_identity",
    description: "Verify the caller owns a booking. Required before reading or changing anything on that booking.",
    inputSchema: obj({ booking_ref: REF, last_name: str("Passenger last name as on the booking.") }, ["booking_ref", "last_name"]),
  },
  {
    name: "get_booking",
    description: "Get a booking: passenger, flight, fare, bags, seat and status.",
    inputSchema: obj({ booking_ref: REF }, ["booking_ref"]),
  },
  {
    name: "search_flights",
    description: "Search Skyline flights between two airports on a date. Returns departures with prices and seats left.",
    inputSchema: obj({ origin: str("IATA code, e.g. BER."), destination: str("IATA code, e.g. LHR."), date: str("YYYY-MM-DD.") }, [
      "origin",
      "destination",
      "date",
    ]),
  },
  {
    name: "quote_change",
    description: "Quote the price of moving a booking to another flight: change fee plus fare difference. Returns a quote_id valid for a limited time.",
    inputSchema: obj({ booking_ref: REF, flight_no: str("New flight number."), date: str("New date, YYYY-MM-DD.") }, ["booking_ref", "flight_no", "date"]),
  },
  {
    name: "change_flight",
    description: "Move a booking to the flight in a quote. Only after the customer accepted the quoted total.",
    inputSchema: obj({ booking_ref: REF, quote_id: str("Quote from quote_change.") }, ["booking_ref", "quote_id"]),
  },
  {
    name: "quote_cancellation",
    description: "Quote the refund for cancelling a booking under its fare rules.",
    inputSchema: obj({ booking_ref: REF }, ["booking_ref"]),
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking with a cancellation quote the customer accepted. Irreversible.",
    inputSchema: obj({ booking_ref: REF, quote_id: str("Quote from quote_cancellation.") }, ["booking_ref", "quote_id"]),
  },
  {
    name: "quote_baggage",
    description: "Quote the price of adding checked bags to a booking (23 kg each).",
    inputSchema: obj({ booking_ref: REF, pieces: int("Number of bags to add.") }, ["booking_ref", "pieces"]),
  },
  {
    name: "add_baggage",
    description: "Add checked bags with a baggage quote the customer accepted.",
    inputSchema: obj({ booking_ref: REF, quote_id: str("Quote from quote_baggage.") }, ["booking_ref", "quote_id"]),
  },
  {
    name: "get_seat_map",
    description: "Free seats on the booking's flight, each with its type (window, middle, aisle).",
    inputSchema: obj({ booking_ref: REF }, ["booking_ref"]),
  },
  {
    name: "assign_seat",
    description: "Assign a free seat to the passenger on a booking. Free of charge on all fares.",
    inputSchema: obj({ booking_ref: REF, seat: str("Seat, e.g. 14C.") }, ["booking_ref", "seat"]),
  },
  {
    name: "get_flight_status",
    description: "Live status of a Skyline flight on a date: on time or delayed, gate.",
    inputSchema: obj({ flight_no: str("Flight number, e.g. SK104."), date: str("YYYY-MM-DD.") }, ["flight_no", "date"]),
  },
  { name: "get_refund_status", description: "Status of refunds on a booking.", inputSchema: obj({ booking_ref: REF }, ["booking_ref"]) },
  {
    name: "update_contact",
    description: "Update the email address or phone number on a booking.",
    inputSchema: obj({ booking_ref: REF, email: str("New email address."), phone: str("New phone number.") }, ["booking_ref"]),
  },
  {
    name: "handoff_to_agent",
    description: "Pass the conversation to a human agent with a short reason and summary.",
    inputSchema: obj({ reason: str("Why a person is needed."), summary: str("What the customer wants and what was done.") }, ["reason", "summary"]),
  },
  {
    name: "send_confirmation",
    description: "Send the customer a confirmation of their booking by email or SMS.",
    inputSchema: obj({ booking_ref: REF, channel: { type: "string", enum: ["email", "sms"] } }, ["booking_ref", "channel"]),
  },
  {
    name: "get_fare_rules",
    description: "Fare rules for a fare family: change fee, refunds, included bags.",
    inputSchema: obj({ fare: { type: "string", enum: ["light", "classic", "flex"] } }, ["fare"]),
  },
];

const PARTNERS: Array<[string, string]> = [
  ["lh", "Lufthansa"],
  ["ib", "Iberia"],
  ["kl", "KLM"],
  ["os", "Austrian"],
];

/** Tools a model can mistake for the one it needs. */
export const SIBLING_TOOLS: ToolDef[] = [
  {
    name: "change_flight_legacy",
    description: "Change the flight on a booking (legacy endpoint kept for older integrations).",
    inputSchema: obj({ booking_ref: REF, flight_no: str("New flight number."), date: str("New date, YYYY-MM-DD.") }, ["booking_ref", "flight_no", "date"]),
  },
  ...PARTNERS.map(([code, name]) => ({
    name: `change_flight_partner_${code}`,
    description: `Change the flight on a booking operated by partner airline ${name}.`,
    inputSchema: obj({ booking_ref: REF, quote_id: str("Quote id.") }, ["booking_ref", "quote_id"]),
  })),
  { name: "get_booking_v1", description: "Get booking details (v1).", inputSchema: obj({ booking_ref: REF }, ["booking_ref"]) },
  ...PARTNERS.slice(0, 2).map(([code, name]) => ({
    name: `add_baggage_partner_${code}`,
    description: `Add checked bags on a booking operated by partner airline ${name}.`,
    inputSchema: obj({ booking_ref: REF, quote_id: str("Quote id.") }, ["booking_ref", "quote_id"]),
  })),
  {
    name: "cancel_booking_group",
    description: "Cancel a group booking with a cancellation quote.",
    inputSchema: obj({ group_id: str("Group booking id."), quote_id: str("Quote id.") }, ["group_id", "quote_id"]),
  },
  {
    name: "assign_seat_partner_kl",
    description: "Assign a seat on a booking operated by partner airline KLM.",
    inputSchema: obj({ booking_ref: REF, seat: str("Seat.") }, ["booking_ref", "seat"]),
  },
];

export const SIBLINGS: Record<string, string[]> = {
  change_flight: ["change_flight_legacy", ...PARTNERS.map(([c]) => `change_flight_partner_${c}`)],
  get_booking: ["get_booking_v1"],
  add_baggage: ["add_baggage_partner_lh", "add_baggage_partner_ib"],
  cancel_booking: ["cancel_booking_group"],
  assign_seat: ["assign_seat_partner_kl"],
};

// The long tail: [domain noun, description phrase, extra parameter]
const TAIL: Array<[string, string, string]> = [
  ["lounge_access", "lounge access at the departure airport", "lounge"],
  ["special_meal", "a special meal (vegetarian, vegan, kosher, halal, gluten-free)", "meal_code"],
  ["pet_in_cabin", "a pet in the cabin (up to 8 kg with carrier)", "pet_type"],
  ["sports_equipment", "sports equipment such as skis, bikes or golf bags", "equipment"],
  ["travel_insurance", "travel insurance for the trip", "plan"],
  ["hotel", "a partner hotel at the destination", "hotel_id"],
  ["car_rental", "a rental car at the destination", "car_class"],
  ["priority_boarding", "priority boarding", "segment"],
  ["extra_legroom", "an extra legroom seat upgrade", "seat"],
  ["wifi_pass", "an in-flight wifi pass", "pass_type"],
  ["carbon_offset", "a carbon offset contribution for the flight", "amount"],
  ["fast_track", "fast-track security at the departure airport", "airport"],
  ["upgrade_bid", "a bid for an upgrade to business class", "bid_amount"],
  ["gift_card", "a Skyline gift card", "card_number"],
  ["voucher", "a travel voucher", "voucher_code"],
  ["airport_transfer", "an airport transfer", "pickup_time"],
  ["group_booking", "a group booking of ten or more passengers", "group_id"],
  ["corporate_profile", "a corporate travel profile", "company_id"],
  ["unaccompanied_baggage", "unaccompanied baggage shipping", "pieces"],
  ["oversize_baggage", "oversize baggage", "dimensions"],
  ["lost_baggage_report", "a lost baggage report", "file_reference"],
  ["damaged_baggage_report", "a damaged baggage report", "file_reference"],
  ["invoice", "an invoice for the booking", "invoice_id"],
  ["receipt", "a receipt for an add-on purchase", "receipt_id"],
  ["travel_documents", "advance passenger information (passport details)", "document_type"],
  ["visa_check", "a visa requirements check", "nationality"],
  ["check_in", "online check-in", "passenger"],
  ["boarding_pass", "a boarding pass", "format"],
  ["loyalty_points", "loyalty points on the passenger's account", "member_id"],
  ["status_match", "a loyalty status match from another airline", "other_programme"],
  ["points_transfer", "a loyalty points transfer to another member", "member_id"],
  ["newsletter", "the newsletter subscription", "email"],
  ["marketing_consent", "marketing consent preferences", "channel"],
  ["name_correction", "a minor name correction (up to three letters)", "corrected_name"],
];
const VERBS: Array<[string, string]> = [
  ["get", "Get the details of"],
  ["book", "Book"],
  ["cancel", "Cancel"],
  ["update", "Update"],
];

export const LONG_TAIL: ToolDef[] = TAIL.flatMap(([noun, phrase, param]) =>
  VERBS.filter(([v]) => !(v === "book" && /report|invoice|receipt|newsletter|consent|correction|documents|check$/.test(noun))).map(([verb, lead]) => ({
    name: `${verb}_${noun}`,
    description: `${lead} ${phrase}.`,
    inputSchema: obj({ booking_ref: REF, [param]: str(`${param.replace(/_/g, " ")}.`) }, ["booking_ref"]),
  })),
);

export const CATALOGUE: ToolDef[] = [...CORE, ...SIBLING_TOOLS, ...LONG_TAIL];
export const CORE_NAMES = new Set(CORE.map((t) => t.name));
export const WRITE_TOOLS = new Set(["change_flight", "change_flight_legacy", "cancel_booking", "add_baggage", "assign_seat", "update_contact"]);
