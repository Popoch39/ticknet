# 11: Send budget

**What to build:** A game developer gives each Connection a Send budget, a fixed number of bytes it may emit per Tick, so that one busy Tick cannot flood a player's link. When the budget is spent, Reliable Messages wait for the next Tick, and Unreliable or Sequenced Messages are refused at send time so the developer can decide what to skip. There is no adaptive congestion control. See the spec, user stories 34 to 36, and "Core modules" (Send budget).

**Blocked by:** 10

**Status:** resolved

- [x] The Send budget is configurable on the Server per Connection and on the Client, with a sensible default
- [x] In no Tick does a Connection put more bytes on the network than its Send budget, counting resends and acknowledgements
- [x] Reliable Messages that do not fit the remaining budget are sent in later Ticks, still exactly once and in order
- [x] Sending an Unreliable or Sequenced Message when the budget for the current Tick is spent tells the caller it was refused, without throwing
- [x] The budget is restored at each Tick; an unused budget does not accumulate
- [x] Keepalive and acknowledgement traffic still gets through when the game fills the budget every Tick, so a saturated Connection does not time out
- [x] A budget too small to ever carry a full Datagram is rejected when the Server or Client is created
- [x] Tests go through the public API on the simulated network

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `datagram.ts`: new `PackedSize`, which counts the bytes a run of Messages takes once `packMessages` has packed it, Datagram headers included (`with(message)` previews, `add(message)` commits, `bytes`). `entrySize` takes any `{ delivery, body }`. Packing two runs one after the other never takes more than the two counted apart (next-fit packing; argument in the class comment), which is what lets the Outbox and the Reliable stream be counted separately against one budget.
- `link.ts`: `DEFAULT_SEND_BUDGET` (4 × 1200 = 4800 bytes; exported by core, server and client) and `assertSendBudget` (RangeError unless an integer ≥ `MAX_DATAGRAM_SIZE`). `Link` takes the budget as a third constructor argument. `send` now returns a boolean: an Unreliable or Sequenced Message is admitted only if the queued ones (`#queued`, a `PackedSize` reset at each flush) plus `ReliableSender.waiting` still fit; a Reliable one always returns true. `flush` hands `ReliableSender.take` the allowance `budget − #queued.bytes`, then packs Reliable entries first and the Outbox after, as before. The empty acknowledgement/keepalive Datagram is still sent only when nothing else leaves, so it is 20 bytes inside the budget.
- `reliable-stream.ts`: `ReliableSender.take(now, resendDelay, allowance)` takes due entries in send order while their packed size fits; past the first one left out, every later due entry is left too (so the order on the wire stays the send order). `waiting` is the packed size of the entries already due and not yet taken: those pushed since the last `take` plus those it left out.
- Engines: `ServerEngineConfig.sendBudget?` and `ClientEngineConfig.sendBudget?` (default `DEFAULT_SEND_BUDGET`, validated in the constructors). `ServerEngine.send` and `ClientEngine.send` return the boolean; `ServerEngine.broadcast` returns the refused `ConnectionId[]`.

server and client:

- `ServerOptions.sendBudget` (bytes per Connection per Tick) and `ClientOptions.sendBudget` (bytes per send step).
- `Connection.send` and `Client.send` return `boolean`: false when an Unreliable or Sequenced Message was refused by the budget. `Server.broadcast` returns the `Connection`s that refused it (empty when all took it).
- `startServer` closes the UDP socket it opened when the Server rejects its options (budget, Tick rate), so the port is free again.

Tests: seam 1 in `packages/server/test/send-budget.test.ts` (`metered` wraps a Transport and adds up bytes per send time and destination; `fill` sends Unreliable Messages until refused, to the last byte). One UDP test in `udp.test.ts` checks that a Server refused for invalid options releases its port.

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer sub-agent). Everything is tested at seam 1 on the simulated network; there is no seam-2 test.
- **"Configurable on the Server per Connection"** read as one Server option that applies to each Connection separately, as the spec's option list says ("Send budget" among the Server options). There is no per-Connection setter. On the Client, the budget is per send step, the Client's equivalent of a Tick.
- **Default: 4800 bytes per Tick**, four full Datagrams: about 1.2 Mbit/s per Connection at the default 30 Hz. It stays well under the 32 Datagrams one acknowledgement covers (ticket 10's note) and leaves a small Reliable Message plus a few Datagrams of Unreliable state per Tick. Not measured on any real game.
- **What the budget counts:** every byte of every connected Datagram a flush puts on the network for that Connection, header (with the acknowledgement) included, Reliable resends included. The Handshake and the close notice are not Connection traffic of a Tick and are not counted.
- **Acknowledgements and keepalives stay inside the budget rather than outside it**, contrary to the plan in tickets 09 and 10, because no exception is needed: acknowledgements ride on the header of every Datagram that leaves, and an acknowledgement-only or keepalive Datagram (20 bytes) is sent only when nothing else is, so it always fits in a budget of at least 1200. The strict bound "no Tick over the budget" then holds with no carve-out.
- **Who gets the budget.** First come, first served within a Tick, with priority to Reliable Messages already waiting. An Unreliable or Sequenced Message is admitted at send time only if it fits together with the Reliable Messages already due (`waiting`); once admitted it always leaves at the next flush, so `true` from `send` is never a silent drop. The Reliable stream gets the rest at flush time, resends first in send order. A Reliable Message that does not fit waits and is counted in `waiting`, so Unreliable sends of the next Tick leave room for it: a game that fills the budget with Unreliable Messages every Tick delays Reliable ones by at most about a Tick each, but cannot starve them (the saturation test fails without this reservation). Conversely, a Reliable backlog bigger than the budget gets every Tick's budget, and Unreliable sends are refused until it drains. A resend that comes due between two flushes is not reserved in advance; if the rest of the budget cannot take it, it is reserved for the next Tick.
- **Refusal granularity.** Admission is exact to the byte, including a new Datagram's 20-byte header when the Message would start one; so a 1-byte Message may still be admitted after a 300-byte one was refused.
- **Broadcast** returns the refusing Connections rather than a boolean, so the game can tell which Clients missed it. The size check still throws before anything is queued.
- **Invalid budgets:** non-integers, NaN, and anything under 1200 are a RangeError from the engine constructors, which `startServer` and `connect` turn into a rejection. `startServer` now closes its UDP socket on that path; this also fixes the same leak for an invalid Tick rate.
- **Characterization test.** "The budget is restored at each Tick" passed when first run, since the count was reset at each flush from the first slice; checked by mutation (removing the reset fails it). The allowance and the reservation were also checked by mutation: without either, the saturation test fails.
- **No test changed.** Existing tests send well under the default budget (the 70,000-Message wrap test included).

### Notes for later tickets

- Merged with ticket 12 (Fragmentation). `entrySize` and `PackedSize` take a `SizedEntry` (`delivery`, `body`, optional `fragment`), so Fragments are measured with their 11-byte header. Each Fragment is added to `waiting` as it is pushed and taken like any Reliable entry, so a large Message leaves over several Ticks (about 4 full Datagrams per Tick by default), which also keeps it under the 32-Datagram acknowledgement span. `Link.send` checks Reliable sizes through the sender (ticket 12) and Unreliable/Sequenced sizes before the budget, so an oversized body still throws rather than being refused. A seam-1 test sends a 50 KB Reliable Message each way under a 2400-byte budget and bad conditions.
- Because waiting Reliable entries have priority, a maximum-size Reliable Message (225 Fragments, about 270 KB on the wire) makes every Unreliable and Sequenced send of that Connection return false until it has drained: about 56 Ticks, close to 2 s at 30 Hz with the default budget. A game that sends large Reliable Messages and wants its Unreliable traffic to keep flowing should raise `sendBudget`.
- Ticket 13: `send` and `broadcast` now return what was refused; positions sent as Sequenced may be refused on a crowded Tick and simply skipped. The demo can lower `sendBudget` to show Reliable chat waiting while effects are refused.
- Ticket 14: `DEFAULT_SEND_BUDGET` is exported by all three packages.
