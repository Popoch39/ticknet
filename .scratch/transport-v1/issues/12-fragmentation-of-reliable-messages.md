# 12: Fragmentation of Reliable Messages

**What to build:** A game developer sends a Reliable Message larger than one Datagram, such as an initial world state, and it arrives whole. The library splits it into Fragments, each travelling reliably, and reassembles it on the other side before delivering it once, in its place in the Reliable stream. Unreliable and Sequenced Messages are never fragmented. See the spec, user stories 31 and 32, and "Core modules" (Fragmentation).

**Blocked by:** 10

**Status:** resolved

- [x] A Reliable Message many times larger than a Datagram is delivered intact, in both directions
- [x] Under seeded loss, reordering and duplication, a large Reliable Message is still delivered intact, exactly once
- [x] A large Reliable Message keeps its place in the stream: Reliable Messages sent before and after it are delivered before and after it
- [x] There is a documented maximum size for a Reliable Message, and sending beyond it fails immediately with a clear error
- [x] No Datagram exceeds 1200 bytes while Fragments are in flight
- [x] Sending an Unreliable or Sequenced Message too large for one Datagram still fails immediately; it is not fragmented
- [x] Through the protocol engine: missing Fragments keep the Message undelivered, repeated Fragments are harmless, and Fragments claiming an impossible count or index are dropped without allocating for them
- [x] A Connection that closes mid-reassembly releases the partial Message

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `datagram.ts`: new **entry type 4, Fragment**: type (u8), Message id (u16), Reliable sequence number (u16), Fragment index (u16), Fragment count (u16), body length (u16), body; 11 bytes of entry header. The body length is still the last field of every entry header. A Fragment is the `reliable` `MessageEntry` variant with the new optional `fragment: { index, count }` (`FragmentPosition`). New constants: `MAX_FRAGMENT_BODY_SIZE` (1169, so that one Fragment fills a 1200-byte Datagram), `MAX_RELIABLE_MESSAGE_SIZE` (256 KiB = 262,144 bytes; exported by core, server and client) and `MAX_FRAGMENT_COUNT` (225, derived). The decoder drops the whole Datagram when a Fragment's count is under 2 or over `MAX_FRAGMENT_COUNT`, or its index is not below its count, like any other malformed entry. `MAX_DATAGRAM_MESSAGE_SIZE` is unchanged (1173).
- `fragments.ts` (new): `assertFitsReliableMessage(id, body)`; `piecesOf(body)` returns the body whole when it fits in one Datagram (≤ 1173 bytes), otherwise pieces of 1169 bytes (the last one shorter), each with its position; `Reassembly.add(entry)` takes the Reliable stream in send order and returns whole Messages.
- `reliable-stream.ts`: `ReliableSender.push` checks the size, then queues one entry per piece, **each Fragment taking its own Reliable sequence number**. `ReliableReceiver.receive` releases entries in sequence order as before (now the private `#inOrder`), then passes them through its `Reassembly`, so it returns whole Messages only. `take`, `sent` and `acknowledge` are unchanged: resends, acknowledgements, the window and the backlog all work per Fragment.
- `link.ts`: `Link.send` no longer checks Reliable sizes itself (the sender does). New `assertSendable(id, body, delivery)`: one Datagram for Unreliable and Sequenced, `MAX_RELIABLE_MESSAGE_SIZE` for Reliable; `ServerEngine.broadcast` uses it so that it still refuses before sending to anyone.
- `outbox.ts`: `assertFitsInDatagram` takes only `"unreliable" | "sequenced"`; its `reliable` mode name is gone.

server and client: `MAX_RELIABLE_MESSAGE_SIZE` re-exported; the `send` and `broadcast` doc comments state both limits.

Tests: seam 1 in `packages/server/test/fragmentation.test.ts` (its `thinnable` wrapper loses every other Datagram one endpoint sends while thinned); seam 2 in `packages/core/test/connected.test.ts` (`fragmentedDatagrams()` gives the three Datagrams that first carry a three-Fragment Message and the three that resend it; `withFragmentFields` rewrites a Fragment's index and count to craft hostile input).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent): the spec's two seams. Seam 1 for every checkbox but one; seam 2 for missing, repeated, impossible and out-of-place Fragments, asserted on events, with bytes only rewritten to craft hostile input.
- **One Reliable sequence number per Fragment**, as ticket 10 suggested, rather than one per Message. The receiver's in-order release then keeps a large Message in its place with no extra logic, and it releases a Message's Fragments one after the other, so `Reassembly` only ever holds the pieces of one Message. The cost: a Message's Fragments count towards `MAX_RELIABLE_BACKLOG` (and towards the receiver's window), so four maximum-size Messages take 900 of its 1024 places, and a fifth sent before any is acknowledged closes the Connection with `reliableBacklogOverflow`.
- **Maximum size, 256 KiB.** A round, documented number whose 225 Fragments stay well under the 1024 backlog (about a fifth), as ticket 10 asked. It is not configurable, like `MAX_RELIABLE_BACKLOG`. The error reads "Message id N is X bytes once encoded; a Reliable Message holds at most 262144 bytes", thrown by `Client.send`, `Connection.send` and `Server.broadcast` before anything is queued.
- **Only Messages that do not fit in one Datagram are fragmented**, and they are split into full pieces of 1169 bytes. A Message up to 1173 bytes still travels as one Reliable entry, so the Reliable wire format for small Messages is unchanged. The last Fragment is shorter and can share its Datagram with other Messages.
- **"Without allocating for them".** An impossible count or index (count < 2, count > 225, index ≥ count) is rejected by the decoder, before anything is kept for the Datagram, and the whole Datagram is dropped. `Reassembly` never allocates based on the claimed count: it collects the pieces that arrive and allocates the whole Message only once its last Fragment is there. Fragments within range but out of place in the stream (a wrong index or count for the Message in progress, or an index other than 0 with no Message in progress) drop the partial Message; only a peer breaking the protocol sends those. What a peer can make the receiver hold stays bounded by the 1024-entry window, as before.
- **Released on close.** The partial Message lives in the Connection's `Link` (its `ReliableReceiver`), which both engines forget when the Connection closes. The seam-1 test checks the behavior: a Client that leaves mid-Message never has it delivered, and a new Connection from the same address delivers a new large Message intact. Memory itself is not measured: there is no stable way to observe it from a test.
- **Characterization tests.** The seam-1 tests for loss, reordering and duplication, for the place in the stream, and for the 1200-byte ceiling passed when first run, since they follow from one sequence number per Fragment over ticket 10's stream. The ceiling and delivery tests were checked by mutation (a Fragment piece one byte too large fails five of them). The seam-2 test for impossible fields failed before the decoder checked them.

### Notes for later tickets

- Ticket 11: one maximum-size Message is 225 Fragments, each a full 1200-byte Datagram, all due at the same flush. With no budget, they all leave in one Tick; ticket 10's note applies: the peer's acknowledgement covers only the newest 32 Datagrams of that flush, so the rest are acknowledged over several resend rounds (the 256 KiB test gives it 5 s on a perfect link). A budget well under 32 Datagrams per Tick spreads them out and avoids it. `ReliableSender.take` returns Fragments like any Reliable entry, so taking fewer per Tick needs nothing specific to Fragments.
- Ticket 13: an initial world state can be sent as one `"reliable"` Message up to `MAX_RELIABLE_MESSAGE_SIZE`; register the handler right after `await connect(...)`.
- The encoded body is kept as given (Fragments are views into it, as unfragmented Reliable bodies already were), so a codec that returns a buffer the game later changes would change what is resent.
