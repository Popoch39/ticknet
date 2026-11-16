# 07: Seeded network conditions

**What to build:** A game developer testing their own game sets loss, latency, jitter, reordering and duplication on the simulated network from a seed, and a failing test replays identically. The same conditions can be wrapped around any Transport, including real UDP, so a running game can be played on a bad link. These tools ship as a public testing entry point of core. Under these conditions the library already guarantees one thing: a duplicated Datagram never delivers a Message twice. See the spec, user stories 30 and 47 to 50, and "Packages".

**Blocked by:** 03

**Status:** ready-for-agent

- [x] The simulated network accepts a loss rate, a latency, a jitter, a reordering rate and a duplication rate, and a seed
- [x] Two runs with the same seed and the same test produce the same sequence of deliveries; a different seed produces a different one
- [x] Latency and jitter are measured on the injected Clock, so a test with a slow link still runs instantly
- [x] Conditions can be set per direction, so a test can make only the Client-to-Server path lossy
- [ ] The same conditions can be applied as a wrapper around any Transport, and work over real UDP on loopback
- [x] The simulated network, the manual Clock and the wrapper are importable by a game through a public testing entry point of core
- [x] With duplication enabled, an Unreliable Message is delivered at most once
- [x] With loss enabled, lost Unreliable Messages are simply absent and the Connection stays open
- [x] A Server and several Clients run together in one process on the simulated network

## Comments

### Architecture map update (for later tickets)

core, testing entry point (`@ticknet/core/testing`, `packages/core/src/testing/`):

- `network-conditions.ts`: `NetworkConditions` (`loss`, `latency`, `jitter`, `reordering`, `duplication`, all optional; rates from 0 to 1, times in milliseconds, a RangeError otherwise), `EndpointConditions` (`send`, `receive`), `SeededRandom` (Mulberry32) and `ConditionedLink<Item>`, one direction of a link: `pass(path, item)` drops, duplicates, delays and reorders on the Clock, then calls `arrive`; `stop()` drops everything in flight. Per Datagram, in this order: loss, then each copy (the original, plus a duplicate at the duplication rate) gets `latency + uniform(0, jitter)`, then the reordering roll.
- **Reordering** holds a Datagram back until the next one on the same path (same sender and receiver) overtakes it; it then arrives right behind it. At most one is held per path, and one that nothing overtakes arrives 100 ms after its due time (`MAX_REORDER_HOLD`), so reordering never turns into loss.
- `simulated-network.ts`: `new SimulatedNetwork({ clock, seed?, conditions? })`: `conditions` apply to every path; `bind(address, { send?, receive? })` adds an endpoint's own conditions per direction. A Datagram crosses the sender's `send` conditions, then the network's, then the receiver's `receive` conditions, so effects add up. One `SeededRandom` per network (seed 1 by default), so a run replays as long as the test itself is deterministic.
- `conditioned-transport.ts`: `withNetworkConditions(transport, { clock, seed?, send?, receive? })` returns a Transport. `send` copies each Datagram and returns the full count (what the conditions lose was "accepted, then lost"); `close()` drops what is in flight and closes the inner Transport. Over a real socket, pass a real Clock.

core, protocol:

- `datagram.ts`: the connected Datagram header gains a **sequence number** (u32) after the Tick number: version, kind, Tick (u32), sequence (u32), then entries. Entries now start at byte 10; `MAX_DATAGRAM_MESSAGE_SIZE` dropped to 1185 on its own.
- `outbox.ts`: `Outbox.flush` stamps each Datagram with the next sequence number of that Connection and side, from 0.
- `received-sequences.ts`: `ReceivedSequences.accept(sequence)`, a window of 1024 sequence numbers per Connection and side. A copy is dropped, and so is anything 1024 or more behind the newest, since it may be lost anyway. Ticket 09's acknowledgements can build on the same sequence number.
- `client-engine.ts`: the Client resends the current Handshake Datagram (connect request, then echo) every 100 ms (`HANDSHAKE_RESEND_INTERVAL`) until the next step or its timeout. `nextDeadline()` during the Handshake is the earlier of the resend and the timeout.
- `challenge.ts`: `Challenger` takes an optional `maxAge` (capped at the 5-second lifetime). The Server passes `floor(timeout) - 1`; see below.

Tests: the testing entry point in `packages/core/test/network-conditions.test.ts` (raw Transports: each condition, replay by seed, validation, per direction, the wrapper); seam 1 in `packages/server/test/network-conditions.test.ts` (Handshake under 50% loss for 20 seeds, duplication, loss, Client-to-Server-only loss, three Clients on a bad link, replay by seed); seam 2 in `packages/core/test/handshake.test.ts` (a resent echo after the Server gave up does not ask again).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent). Besides seam 1, the testing entry point is tested on its own, as a public interface games use directly.
- **Real UDP is pending ticket 04.** `transport-v1` has no UDP Transport yet. The wrapper is proven around a simulated-network Transport standing in for any Transport, so that box stays unticked. Once ticket 04 lands, the check is one loopback test: wrap both sockets with `withNetworkConditions` and a real Clock, connect, and exchange.
- **The seed defaults to 1**, not to a random value, so a run without a seed still replays. The demo (ticket 13) can pass a random seed and print it.
- **Duplication is handled per Datagram, not per Message**, because a duplicate is a whole Datagram. The 4-byte sequence was chosen over a 2-byte one so that no wrap-around logic is needed (4.5 years at 30 Datagrams per second).
- **Handshake resend, 100 ms.** It was needed: without it, the test connecting under 50% loss failed. The echo is resent with the same challenge. If echoes keep getting lost for longer than the challenge stays valid, the Client waits for its own timeout; it does not restart from the connect request.
- **Merge with ticket 05: resent echoes vs. the Server `timeout`.** With resends, a Client whose authentication timed out kept echoing, and the Server asked the game again, retaking the freed place. Ticket 05's "stops waiting … freeing the place" test failed on that. Fix, stateless: the Server only accepts an echo whose challenge is younger than its `timeout`. An authentication starts no earlier than its challenge was issued, so once it times out, every echo of that challenge is too old. The challenge now lives `min(5 s, timeout - 1 ms)`.
- **A connected Datagram that reaches the Client before `accepted` is still ignored** (ticket 03's note). No test needed it: with hold-back reordering, `accepted` arrives right behind the Datagram that overtook it, and Messages arriving before `connect` resolves have no handler anyway.
- **Test change from ticket 03.** `connected.test.ts` hardcoded the 6-byte connected header (`6 + 3`, `[6]`); it now uses 10. The behavior it checks is unchanged.

### Notes for later tickets

- A test that sets conditions should advance the Clock past the last send by at least `latency + jitter + 100 ms` so that held-back Datagrams arrive.
- Under loss, a Client's `connect` takes several 100 ms rounds. The `connectClient` helper in `packages/server/test/network-conditions.test.ts` advances 1 ms at a time and settles until it resolves.
- A denied or accepted Client may still have an echo in flight. An accepted one gets `accepted` again; a denied one makes the Server ask the game a second time (as a duplicated echo already did). Harmless today; ticket 06 may want to remember recent refusals.
- `ConditionedLink` is internal; only the types, `SimulatedNetwork`, `ManualClock` and `withNetworkConditions` are exported from `@ticknet/core/testing`.
