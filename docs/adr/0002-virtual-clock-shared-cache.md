# 2. Overlapping conversations on a virtual clock, sharing one cache

**Decision.** A bet runs all conversations of one setup as tasks on a virtual clock. They arrive
every 40 s, and customers think between turns. All of them share one provider instance and so one
prompt cache.

**Why.** Caches are per organisation, not per conversation. A stable system prompt is cached once
and read by everyone. TTLs only mean something against real gaps between requests. A virtual clock
makes a day of traffic run in seconds, in the same order every time, so CI can compare reports byte
for byte.

**Cost.** Tasks may only wait on the clock. Real I/O, such as the MCP end-to-end test, uses a plain
clock instead.
