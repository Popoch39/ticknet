# 09: Connection health: round-trip time and loss

**What to build:** A game developer reads the round-trip time and the loss rate of a Connection on the Server, and of its link to the Server on the Client, to show a ping indicator or spot a bad link. Both are estimated from acknowledgements that ride on every outgoing Datagram, which is also the groundwork the Reliable Delivery mode needs. See the spec, user story 37, and "Core modules" (Delivery, Connection health).

**Blocked by:** 07

**Status:** resolved

- [x] The Server exposes a round-trip time and a loss rate per Connection; the Client exposes the same for its link to the Server
- [x] On a simulated link with a fixed latency and no loss, the round-trip time converges close to twice that latency
- [x] When the latency of the link changes, the round-trip time follows within a few seconds of simulated time
- [x] On a simulated link with a known loss rate, the reported loss rate converges close to it; with no loss it reports zero
- [x] Duplicated and reordered Datagrams do not distort the estimates beyond what the conditions explain
- [x] An idle Connection still reports health values, kept fresh by keepalive Datagrams
- [x] Through the protocol engine: every outgoing Datagram carries acknowledgement data for recently received Datagrams
- [x] Health values are exposed before any sample exists in a way that cannot be mistaken for a real measurement

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `datagram.ts`: the connected header gains the **acknowledgement** after the Datagram sequence number: newest sequence number received (u32), received mask (u32, bit i set when `newest - i` arrived, so it covers `ACKNOWLEDGEMENT_SPAN` = 32 sequence numbers), delay (u16, milliseconds between the arrival of `newest` and the sending of this Datagram, capped at 65535). Header: version, kind, Tick, sequence, ack newest, ack mask, ack delay = 20 bytes; entries start at byte 20. Nothing received yet is `{ newest: 0, received: 0 }`, which acknowledges nothing (no sentinel value). `MAX_DATAGRAM_MESSAGE_SIZE` dropped to 1173 on its own (1200 - 20 - the 7-byte Sequenced entry header). `ConnectedDatagram` names the connected variant.
- `link.ts` (new): `Link`, one side of an open Connection, used by both engines (`OpenConnection.link` on the Server, `#link` on the Client). It owns the `Outbox`, ticket 07's `ReceivedSequences`, the new `SentDatagrams`, the Datagram sequence counter and the keepalive. `receive(datagram, now)` returns the Messages, or undefined for a copy; `flush(tick, now)` encodes Datagrams, stamping each with the next sequence number and the current acknowledgement, and records its send time; `health` returns `{ roundTripTime, lossRate }`. Ticket 06's `keepaliveInterval(timeout)` moved here from `outbox.ts`, unchanged.
- `outbox.ts`: now only a queue (with ticket 08's Sequenced numbering): `take()` returns the packed groups; sequence numbers and encoding moved to `Link`.
- `received-sequences.ts`: `accept(sequence, now)` remembers when the newest arrived; `acknowledgement(now)` builds the header field.
- `sent-datagrams.ts` (new): `SentDatagrams`, a ring of the last 256 Datagram sequence numbers sent with their send time and state (pending, acknowledged, missed). `acknowledge(ack, now)` marks each covered sequence number, and takes a round-trip sample only when the newest is newly acknowledged: `now - sentAt - delay`. This is where ticket 10 learns which Datagrams (and so which Reliable Messages) arrived. `ConnectionHealth` is exported from core.
- Engines: `ServerEngine.health(connection)` (undefined once closed), `ClientEngine.health`.

server and client: `Connection.roundTripTime`, `Connection.lossRate`, `Client.roundTripTime`, `Client.lossRate`, all `number | undefined`.

Tests: seam 1 in `packages/server/test/health.test.ts` (its `withAdjustableLatency` wrapper holds back a Client's sends by a delay the test can change mid-run); seam 2 in `packages/core/test/connected.test.ts` (each of three Datagrams sent in one flush, delivered alone, gives the other engine the exact round-trip time and a 1/3 loss rate after one of three was dropped).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent): seam 1 for every checkbox but one, seam 2 for "every outgoing Datagram carries acknowledgement data", asserted through the health it produces rather than bytes.
- **The round-trip time leaves out the other side's wait before answering.** Acknowledgements leave at the next Tick or send step, or with the next keepalive (up to a second later), so the raw delay is noisy. The sender subtracts the `delay` field, as QUIC does, and the result is the network round trip: exactly twice the latency on the simulated network (within the 1 ms rounding of the delay field). Smoothed like TCP's SRTT (gain 1/8); undefined before the first sample.
- **Loss rate is outbound**: the share of this side's recent Datagrams the other side did not receive, over the last 256 sent. A Datagram counts only once an acknowledgement has covered it: received, or missed (covered but not set). A missed one that arrives late turns into received, so reordering does not count as loss; one no acknowledgement ever covered (for example over 32 sent between two acknowledgements, or all its acknowledgements lost) is left out rather than counted lost, which keeps the estimate unbiased. Undefined before the first covered Datagram.
- **Acknowledgement-only Datagrams.** A side that received Messages since its last Datagram sends an empty connected Datagram at its next Tick or send step, so one-way traffic is still acknowledged. Empty Datagrams (acknowledgements, keepalives) ask for no answer, or two quiet sides would answer each other forever; an idle Connection exchanges only ticket 06's keepalives, whose acknowledgements ride on the other side's next keepalive.
- **Ticket 06 landed during this ticket** and was merged in: its keepalive (empty connected Datagram after `keepaliveInterval(timeout)`, `min(1000, timeout / 4)`) moved from `Outbox` into `Link` with the same behavior. The idle test relies on it: health values follow a latency change within 30 s of silence (about one sample per second per side).
- **Test change from ticket 07/08.** `connected.test.ts` hardcoded the 10-byte connected header; it now uses 20. `connectedPair` also returns the Connection id it accepted. No assertion changed.

### Notes for later tickets

- Ticket 10: the round-trip time excludes the peer's acknowledgement delay, so a resend delay must add the peer's longest wait before acknowledging (one Tick or send step, since a Datagram carrying Messages is acknowledged at the next one). Reliable entries make a Datagram ask for an acknowledgement automatically (any Message does). Hook resends on `SentDatagrams.acknowledge`, which visits every sequence number newly acknowledged; 256 tracked Datagrams and a 32-wide acknowledgement bound how much can be in flight before acknowledgements stop covering it.
- Ticket 10's "sequence counters wrap around": Datagram sequence numbers (u32) are compared with plain arithmetic in `ReceivedSequences` and `SentDatagrams`; wrap-around was not handled (4.5 years at 30 Hz), as in ticket 07.
- Ticket 11: acknowledgements are part of the 20-byte header of every connected Datagram; acknowledgement-only Datagrams and keepalives are 20 bytes each and must stay outside, or ahead of, the budget refusal so that a saturated Connection still acknowledges.
