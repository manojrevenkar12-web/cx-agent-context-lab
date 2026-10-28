# Writing a held-out scenario set

You are writing customer conversations that a contact-centre agent for **Skyline Air** (a fictional
airline) will be tested on. You have not seen the agent, and you should not look for it. Write what
real callers do. The set is run once; its first result is recorded and never rewritten.

## What a scenario is

One caller, one booking, one or more things the caller wants (goals), in the order they will raise
them. The lab plays the caller from your description: the caller answers what the agent asks,
accepts or declines prices as you say, and adds filler talk if you give `chatter`.

```yaml
- id: short-kebab-case-id            # unique in the file
  description: one line, for people  # optional
  tags: [long]                       # optional; use "long" for calls with 3+ goals or lots of chatter
  channel: voice                     # voice or chat
  call_at: "2026-11-12T16:30"        # optional; the local time the call starts (default 2026-11-10 08:00 and later)
  reveal: on_ask                     # on_ask (default): says the goal, gives details when asked
                                     # upfront: gives booking reference, name and every goal's details in the first message
  chatter: 0                         # number of filler sentences spread over the call (0-40)
  customer: { first_name: Lena, last_name: Hoffmann }
  booking:
    ref: QX7M2P                      # 6 characters, capital letters and digits, at least one of each
    fare: classic                    # light, classic or flex
    tier: basic                      # basic, silver or gold (loyalty tier)
    route: BER-LHR                   # one of the routes below, either direction
    date: "2026-11-14"               # the booked flight's date, 2026-11-09 to 2026-12-19
    slot: morning                    # morning (07:10), midday (12:35) or evening (18:50)
    bags: 0                          # checked bags already on the booking, 0-3
    seat: 21B                        # current seat, row 8-28, letters A-F
    paid: 189                        # what the customer paid, euros
  goals:
    - { intent: change_flight, date: "2026-11-16", prefer: evening, accept: true }
```

Goals (all fields shown; `accept` defaults to true):

| intent | fields | what the caller wants |
|---|---|---|
| `change_flight` | `date` (new date), `prefer` (morning, midday, evening; leave out if they don't mind), `accept` | move the booking to another day on the same route |
| `add_bag` | `pieces` (1-3), `accept` | add checked bags |
| `seat` | `prefer` (window or aisle) | change seat |
| `cancel` | `accept` | cancel the booking |
| `refund_status` | | ask where their refund is |
| `flight_status` | | ask whether their booked flight is on time |
| `update_contact` | `email` or `phone` | change the email or phone on the booking |
| `claim` | `text` (one or two sentences in the caller's words) | complain or claim compensation (delay, lost or damaged bag) |
| `assistance` | | ask for wheelchair assistance |

`accept: false` means the caller hears the price and says no.

## Skyline's world (facts you may rely on)

- Routes (both directions): BER-LHR, BER-CDG, BER-MAD, MUC-AMS, MUC-LIS, FRA-FCO, FRA-CPH, HAM-VIE,
  DUS-ZRH, BER-FCO, MUC-CDG, FRA-LHR. Three flights a day on each, at 07:10, 12:35 and 18:50.
- Today is 2026-11-10. Flights exist from 2026-11-08 to 2026-12-19. A new date must be in that range.
- Fares: Light (change fee €70, no refund except €38 taxes, no bag included), Classic (change fee
  €40, refund minus €60, one bag included), Flex (no change fee, full refund, one bag included).
  Gold members pay no change fee. Fare differences are added when the new flight costs more.
- Bags cost €35 each beyond what the fare includes; at most 3 checked bags per passenger.
- Seats are free to choose.
- Rules for the agent (Skyline's published policy): it must verify the caller (booking reference and
  last name) before reading or changing a booking; it must tell the caller the price and get a yes
  before changing, cancelling or adding bags; changes within 3 hours of departure, complaints and
  compensation claims, and wheelchair assistance go to a person.

## What makes a good set

- About 30 scenarios. Cover every intent at least twice, both channels, every fare and tier.
- Mix easy calls with hard ones: several goals in one call, details given up front and needed much
  later, long chatty calls (`chatter` 15-40 with `tags: [long]`), callers who decline, edge cases
  of the rules (a change inside the 3-hour window via `call_at`, bags beyond the limit, gold
  members, a flex cancellation, a new date where the fare difference is likely).
- Make callers plausible: names from many countries, realistic prices paid (€60-€400).
- Don't write what the agent should say. Don't try to guess how the agent works.
