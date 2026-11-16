# 08: Sequenced delivery mode

**What to build:** A game developer sends a Message as Sequenced, typically a position update, and a late one never overwrites a newer one: once a Sequenced Message of a given type has been delivered, any older Message of that type arriving afterwards is discarded. Sequenced Messages are never resent. See the spec, user stories 28 and 32, and "Core modules" (Delivery).

**Blocked by:** 04, 07

**Status:** ready-for-agent

- [x] Sequenced is selectable as the Delivery mode of a send, in both directions
- [x] With reordering enabled, the values delivered for one Message type are always in increasing send order; older ones arriving late are dropped
- [x] Ordering is tracked per Message type: a late Sequenced Message of one type is not dropped because a newer Message of another type arrived
- [x] With loss enabled, a lost Sequenced Message is never delivered later
- [x] With duplication enabled, a Sequenced Message is delivered at most once
- [x] Sending a Sequenced Message too large for one Datagram fails immediately with a clear error
- [x] A long-running Connection keeps ordering correctly after its sequence counters wrap around
- [x] These go through the public API on the simulated network with seeded conditions
- [x] One integration test on real UDP loopback exchanges a Sequenced Message in each direction

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `message.ts`: `DeliveryMode` is `"unreliable" | "sequenced"`. Ticket 10 adds `"reliable"`.
- `datagram.ts`: new **entry type 2, Sequenced**: type (u8), Message id (u16), Sequenced sequence number (u16), body length (u16), body; 7 bytes of entry header against 5 for Unreliable. In every entry type the body length is the last field of the entry header, which the decoder relies on. `MessageEntry` is now a union on `delivery`; the Sequenced variant carries `sequence`. `isNewer(a, b)` compares two Sequenced sequence numbers across the 2^16 wrap (serial number arithmetic: `a` is newer when it is 1 to 32767 ahead of `b`). `SEQUENCED_SEQUENCE_MASK` is `0xffff`.
- `MAX_DATAGRAM_MESSAGE_SIZE` is now one limit for every single-Datagram mode, computed with the larger Sequenced entry header: 1183 (was 1185). It keeps shrinking on its own when ticket 09 puts acknowledgement data in the connected header.
- `outbox.ts`: `Outbox.push` gives each Sequenced Message the next sequence number of its Message id on that Connection and side, from 0, wrapping at 2^16; a refused push takes no number. `assertFitsInDatagram(id, body, delivery)` names the Delivery mode in its error ("a Sequenced Message must fit in one Datagram, which holds at most 1183 bytes of it").
- `sequenced-order.ts`: `SequencedOrder.admit(message)`, one per Connection and side (on `OpenConnection.sequenced` in the Server engine, `#sequenced` in the Client engine). It lets every non-Sequenced entry through, and a Sequenced one only if it is newer than the newest delivered of its Message id, which it then becomes. Both engines call it per entry, after ticket 07's `ReceivedSequences` has accepted the Datagram.

server and client: no change; `send`, `broadcast` and `Connection.send` accept `"sequenced"` through the widened `DeliveryMode`.

Tests: seam 1 in `packages/server/test/sequenced.test.ts` (each direction, reordering, loss, duplication, oversized, wrap-around past 2^16, per-type ordering) and `packages/server/test/udp.test.ts` (one Sequenced Message each way on loopback); seam 2 in `packages/core/test/connected.test.ts` (cut Sequenced entries are never partially delivered).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent): seam 1 for every checkbox, as the ticket requires, plus one seam-2 test for truncated Sequenced entries, since the spec keeps seam 2 for hostile input.
- **16-bit Sequenced sequence numbers, per Message type, with wrap-around**, rather than 32-bit ones without: 2 bytes per entry instead of 4, and the ticket asks for wrap-around to be handled. The wrap test sends 70,000 Messages of one type each way (100 per Datagram) under reordering; with a plain `>` comparison it stops delivering at 65535 (checked by mutation).
- **Limit of the comparison.** A Sequenced Message 32768 or more behind the newest of its type would look newer. Ticket 07's window already drops Datagrams 1024 or more behind the newest, so this needs over 32 Sequenced Messages of one type per Datagram and a Datagram held back for about 1000 others: not a realistic case.
- **One size limit for Unreliable and Sequenced**, so that whether a Message fits does not depend on its Delivery mode. Unreliable bodies lose 2 bytes (1185 to 1183). The ticket-03 test using `MAX_DATAGRAM_MESSAGE_SIZE` is unchanged and still passes.
- **Equal sequence numbers are dropped**, so a Sequenced Message is delivered at most once even without ticket 07's per-Datagram deduplication.
- **Unreliable sends of a Message type do not take part** in that type's Sequenced order: they are neither dropped by it nor advance it.
- **A Sequenced Message is never resent**: nothing in the engines resends connected Datagrams. The loss test checks that nothing more arrives 30 seconds later, which guards against ticket 10's resend mechanism picking up Sequenced entries.
- **Characterization tests.** The loss, duplication and per-type tests passed when first run, since the behavior follows from the design (no resend, Datagram deduplication, a filter keyed by Message id from the start). The per-type test was checked by mutation (one order for every type makes it fail).

### Notes for later tickets

- Reordering on the simulated network needs Datagrams closer together than 100 ms (`MAX_REORDER_HOLD`): at 10 Ticks per second, a held Datagram's hold expires as the next one is due and nothing is reordered. `sequenced.test.ts` runs both sides at 20 Hz for that reason.
- Ticket 10: add a third `MessageEntry` variant and entry type; keep the body length as the last field of the entry header, or change the decoder's `bodyStart - 2`. `SequencedOrder.admit` lets Reliable entries through untouched. Reliable fragments are not bound by `MAX_DATAGRAM_MESSAGE_SIZE`, but `assertFitsInDatagram`'s `MODE_NAMES` record will need a `reliable` entry for the type-check.
- Ticket 13's demo can send positions as `"sequenced"` with no further API.
