# 10: Reliable delivery mode

**What to build:** A game developer sends a Message as Reliable, such as chat or a score event, and it arrives exactly once and in the order it was sent, whatever the network does. Reliable Messages form a single ordered stream per Connection and are resent until acknowledged, after a delay derived from the measured round-trip time. A Connection whose Reliable backlog keeps growing is closed with a reason rather than eating memory. See the spec, user stories 29, 30, 33 and 40, and "Core modules" (Delivery).

**Blocked by:** 04, 09

**Status:** resolved

- [x] Reliable is selectable as the Delivery mode of a send, in both directions
- [x] Under seeded loss, reordering and duplication together, every Reliable Message sent is delivered exactly once and in send order
- [x] Order holds across Message types: Reliable Messages of different types are delivered in the order they were sent
- [x] A Reliable Message sent while the link drops everything is delivered once the link recovers, as long as the Connection has not timed out
- [x] Unreliable and Sequenced Messages keep flowing while a Reliable Message is waiting to be resent
- [x] Through the protocol engine: an unacknowledged Reliable Message is resent after a delay that follows the measured round-trip time, not on every Tick, and is no longer resent once acknowledged
- [x] When the Reliable backlog of a Connection passes its limit, the Connection is closed on both sides with a backlog overflow reason
- [x] A long-running Connection keeps delivering correctly after its sequence counters wrap around
- [x] One integration test on real UDP loopback exchanges a Reliable Message in each direction

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `message.ts`: `DeliveryMode` is `"unreliable" | "sequenced" | "reliable"`.
- `datagram.ts`: new **entry type 3, Reliable**: type (u8), Message id (u16), Reliable sequence number (u16), body length (u16), body. Same 7-byte header as Sequenced, so `MAX_DATAGRAM_MESSAGE_SIZE` stays 1173. `MessageEntry` gains a `reliable` variant whose `sequence` counts every Reliable Message one side sent on a Connection, across Message types, wrapping at 2^16 (`RELIABLE_SEQUENCE_MASK`); `ReliableEntry` names it. The close notice (kind 7) gains reason byte 3, Reliable backlog overflow, accepted from either side; `CloseNoticeReason` is exported. `sequenceDistance(a, b)` compares 32-bit Datagram sequence numbers across the wrap (`(a - b) | 0`).
- `close-reason.ts`: adds `{ kind: "reliableBacklogOverflow" }`.
- `reliable-stream.ts` (new): `MAX_RELIABLE_BACKLOG` (1024; exported by core, server and client). `ReliableSender`: `push(id, body)`; `take(now, resendDelay)` returns the entries never sent and those due again, never one beyond the window, and stamps their next resend time; `sent(datagramSequence, messages)` remembers what each of the last 256 Reliable-carrying Datagrams carried; `acknowledge(datagramSequence)`; `overflowed`. `ReliableReceiver.receive(entry)` returns the entries now deliverable, in send order: it holds those ahead of a missing one (within the window) and drops copies.
- `link.ts`: owns one `ReliableSender` and one `ReliableReceiver`. `send` routes Reliable Messages to the sender (after `assertFitsInDatagram`) and the others to the `Outbox`. `receive` hands each Datagram sequence number `SentDatagrams.acknowledge` newly acknowledges to the sender, and returns Messages in delivery order: Reliable ones released in stream order, the others as they came. `flush` packs the due Reliable entries first (resends included), then the Outbox. `reliableBacklogOverflowed`. Datagram sequence numbers start at `FIRST_DATAGRAM_SEQUENCE`, 2^32 − 4096, and wrap.
- `outbox.ts`: Unreliable and Sequenced only; `take()` returns the entries and `Link` packs them.
- `sent-datagrams.ts`: `LOSS_WINDOW` is now the exported `TRACKED_DATAGRAMS` (256). `record(sequence, now, carriesMessages)`; `acknowledge` returns the sequence numbers it newly acknowledges; `resendDelay` (see below). A round-trip variation (TCP's RTTVAR, gain 1/4) is kept next to the smoothed round-trip time, whose values are unchanged.
- `received-sequences.ts` and `sent-datagrams.ts` compare sequence numbers across the 32-bit wrap.
- Engines: at the end of a Tick, the Server closes a Connection whose backlog overflowed instead of flushing it, through `#closeOpen` (close notice, then ticket 06's `#forget`), which `close` now uses too. The Client does the same at its send step, through `#tellServer`, which `close` now uses too. Either engine acts on an overflow notice from the other side.

client (`packages/client/src/client.ts`):

- Once the Connection is open, Messages and the close event go through a private `Arrivals` holder. They are held until the game registers a handler or listener (`onMessage` or `on`), or until the code awaiting `connect` has run, then handed out in order, ahead of anything that arrives later. `connect` is no longer `async`: it wraps the private `open` and, when the Connection opens, registers a reaction on the promise it returned, so that the release queues behind the caller's own continuation, whether the caller awaited before or after. The `Client` constructor takes a `registered` callback rather than the private class, for ticket 14's declaration emit.

Tests: seam 1 in `packages/server/test/reliable.test.ts` (its `cuttable` wrapper loses what one endpoint sends while cut; `welcomingServer` sends Reliable Messages as a Connection opens and on every Tick); seam 2 in `packages/core/test/connected.test.ts` (`linkedPair(latency)` drives two engines 1 ms at a time over a fixed-latency link and records when the Client sends and when the Server delivers); one Reliable Message each way on loopback in `packages/server/test/udp.test.ts`.

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer sub-agent). Seam 1 covers every checkbox but one. Seam 2 covers resend timing, asserted on when the Client puts Datagrams on the network and when the Server delivers, never on bytes.
- **Resend delay.** It is TCP's retransmission timeout (RFC 6298: smoothed round-trip time plus 4 × its variation, floored at 10 ms) on ticket 09's round-trip time, plus the peer's acknowledgement wait, which that round-trip time leaves out. The wait is measured from the `delay` the peer reports for Datagrams carrying Messages: it jumps to a longer wait at once and decays with gain 1/8, so one stall of the peer does not slow every later resend. Before the first sample the delay is 1 s, as TCP's. Resends go out at the first flush (Tick or send step) after they are due. On a steady link this is 2 × latency + 10 ms + at most one peer step; the seam-2 test checks the gap falls within [2L, 2L + 40] for L = 20 and 100. There is no exponential backoff and no resend on a gap in the acknowledgements: neither was asked for. On a dead link, resends are bounded by the backlog limit and the timeout, and ticket 11's budget will bound bytes per Tick.
- **Backlog limit: 1024 Reliable Messages.** It counts the span from the oldest unacknowledged Message to the newest one sent. Acknowledged Messages in between count until the oldest one is acknowledged. A count rather than bytes, because the same number is the receiver's window: a sender never has in flight a Message the receiver would drop after acknowledging its Datagram. Worst case about 1024 × 1173 bytes per side. Not configurable, since the spec's option lists do not name it; it is exported for documentation and tests.
- **Overflow is checked at the end of each Tick (Server) or send step (Client)**, not in `send`, so that sending has no side effect. The overflowing side sends a close notice with reason 3, and each side raises one `connectionClosed` with `reliableBacklogOverflow`. A lost overflow notice ends in a timeout on the other side, like any lost close notice. Exactly 1024 waiting keeps the Connection open; the 1025th closes it.
- **Wrap-around.** Reliable sequence numbers are 16-bit with mask arithmetic; the 1024 window is far below 2^15. Datagram sequence numbers stay 32-bit, now compared across the wrap. They start 4096 short of it (as Linux starts its jiffies counter), so every Connection that lasts a few minutes crosses it, rather than one in 4.5 years. The wrap test sends 70,000 Reliable Messages each way over 5000 Datagrams under loss, reordering and duplication, crossing both counters. Checked by mutation: plain 32-bit comparisons in `ReceivedSequences`, or a Reliable comparison that does not wrap, fail that test and no other.
- **Messages that arrive before a handler exists** (ticket 03's note). A Reliable one would have been acknowledged, then dropped, so lost for good. Now they are held as above. Unreliable and Sequenced Messages are held the same way: the adapter does not see the Delivery mode, and holding keeps the order. The close is held behind them, so nothing is delivered after the closed event. Once the code awaiting `connect` has run, a Message without a handler is ignored, as before. Limit: a game that registers its handlers only after a further `await` misses what arrived before.
- **No head-of-line blocking across Delivery modes.** Unreliable and Sequenced entries are delivered as they arrive, even when a Reliable entry of the same Datagram is held behind a missing one. The sender keeps flushing the Outbox while Reliable Messages wait.
- **Characterization tests.** "Order across types", "link drops everything" and "Unreliable and Sequenced keep flowing" passed when first run, since they follow from one stream per Connection and resending until acknowledged. Each was checked by mutation (a receiver that does not hold back; resends pushed far out).
- **Test change in seam 2.** `connectedPair` in `connected.test.ts` takes optional rates and a timeout; its defaults are unchanged.

### Notes for later tickets

- Ticket 11: `Link.flush` packs every due Reliable entry (resends first, then new ones), then the Outbox, into as many Datagrams as needed; the budget cuts there. `ReliableSender.take` marks everything it returns as sent, so to leave some for a later Tick, take fewer (pass an allowance) rather than dropping what it returned. An acknowledgement covers the newest 32 Datagrams and the peer acknowledges once per Tick or send step: of a flush of more than 32 Reliable-carrying Datagrams, only the newest 32 get acknowledged and the rest wait for a resend. A budget well under 32 Datagrams per Tick avoids that. Acknowledgement-only Datagrams and keepalives must stay outside the budget, as ticket 09 noted.
- Ticket 12: Fragments of one Message can each take a Reliable sequence number, so that the receiver's in-order release keeps a large Message in its place, and the window and backlog then count Fragments. The maximum Reliable Message size must keep its Fragment count well under 1024, and the 32-Datagram note above applies to a large Message sent at once. `Link.send` currently rejects an oversized Reliable Message through `assertFitsInDatagram` ("a Reliable Message must fit in one Datagram"); ticket 12 replaces that check. The body length is still the last field of every entry header.
- Ticket 13: chat as `"reliable"` needs no further API. Register the Client's handlers right after `await connect(...)`.
