# 06: Closing, timeouts and keepalive

**What to build:** A game developer always knows when and why a Connection ended. A Client can leave on purpose and the Server learns it at once; the Server can kick a Connection with its own reason code; stopping the Server tells every Client; a peer that goes silent times out after a configurable delay. A Connection with nothing to send stays alive without the developer doing anything. Reconnecting always creates a new Connection. See the spec, user stories 11, 15, 17, 25, 26, 38 and 39, and "Public API behavior" (close reasons).

**Blocked by:** 03, 04

**Status:** resolved

- [x] A Client that disconnects on purpose causes a Connection closed event on the Server with a closed-by-Client reason, without waiting for the timeout
- [x] The Server closes a Connection with a developer-chosen code, and the Client is told it was closed by the Server with that code
- [x] Stopping the Server tells every connected Client it was closed by the Server
- [x] A close notice lost on the network still ends in a closed Connection on the other side, through the timeout
- [x] A Client that stops responding causes a Connection closed event with a timeout reason after the configured delay, and a Client whose Server vanishes is told the same
- [x] A Connection on which neither side sends any Message stays open well beyond the timeout
- [x] After a Connection closed event, sending on that Connection fails clearly and no further Message from it is delivered
- [x] A Client that connects again after being closed gets a new Connection; nothing from the old one is resumed
- [x] Each of these goes through the public API on the simulated network with the manual Clock
- [x] One integration test on real UDP loopback covers a Client disconnecting and a Server stopping

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `close-reason.ts`: adds `{ kind: "closedByClient" }` and `{ kind: "closedByServer", code }`, and `assertCloseCode(code, what)`, shared by denials and closes (RangeError outside 0 to `MAX_CLOSE_CODE`).
- `datagram.ts`: new kind 7, the **close notice**: one reason byte (1 closed by Client, 2 closed by Server followed by the game's 16-bit code). A Server only acts on reason 1, a Client only on reason 2. A **keepalive** is a connected Datagram (kind 6) with no Message entry, so the acknowledgement data that joins that header later rides on keepalives for free.
- `outbox.ts`: `keepaliveInterval(timeout)` is `min(1000, timeout / 4)`. `new Outbox(keepaliveInterval, now)`; `flush(tick, now)` returns one empty connected Datagram when nothing has left for that long. The Server flushes at each Tick (at the Tick's start time), the Client at each send step, so neither engine needs a deadline of its own for keepalives.
- `server-engine.ts`: new event `connectionClosed` (`connection`, `reason`), raised once per opened Connection whichever side ended it. `close(connection, code)` sends the close notice, forgets the Connection and raises the event; it replaces ticket 05's silent `close(connection)`. `accept(connection, now)` now takes the time. `#silenceDeadlines` holds each open Connection's timeout, re-inserted on every connected Datagram from it, so the map stays ordered by deadline (same trick as `#authenticating`). Each open Connection keeps the challenge that opened it: an echo of the same challenge resends `accepted` as before; a valid echo of a different one from the same address closes the old Connection (`closedByClient`) and authenticates anew.
- `client-engine.ts`: `close()` sends the close notice if connected and closes with `closedByClient`. Once connected, the Connection times out `timeout` ms after the last connected Datagram from the Server (or the acceptance); `send` after closing throws `The Connection is closed (<reason>); …`.
- `engine.ts`: `EngineDriver.stop()` no longer cuts the pump short. It cancels the wake-up and, if called from an event handler, lets the running pump drain both queues (so close notices still leave) before closing the Transport. `perform` after `stop` runs its action but sends nothing, as before.

server and client:

- `Server.on("connectionClosed", (connection, reason) => …)`. The Server forgets the `Connection` object when that event is dispatched, so Messages are routed to it up to the event and never after. `Connection.close(code = 0)` and `Connection.send` after closing throws (`Connection N is closed; …`). `Server.stop()` closes every Connection with code 0 (each raising `connectionClosed`) before releasing the socket, also when called from a Tick callback. The `timeout` option now also bounds silence on open Connections. `CloseReason` is re-exported by the server package.
- `Client.on("connectionClosed", (reason) => …)` runs once, for any end, including `client.close()`; the Client then releases its socket and timers by itself. `Client.close()` tells the Server first. `ClientOptions.timeout` bounds the Handshake and then silence from the Server.

Tests: seam 1 in `packages/server/test/closing.test.ts` (its `cuttable` Transport wrapper loses everything one endpoint sends while cut, and can be restored, so a single close notice can be lost); the loopback test is in `packages/server/test/udp.test.ts`.

### Decisions and assumptions

- **Seams.** The spec's seam 1 and its loopback integration tests, with no new seam; not confirmed interactively (implementer sub-agent). Loss is produced by a test-local Transport wrapper rather than by the simulated network, which ticket 07 is changing.
- **The closer's own side raises the closed event too** (`closedByServer` on the Server after `Connection.close` or `stop`, `closedByClient` on the Client after `close`), so that a game has one place to clean up. The ticket did not require it either way.
- **`Server.stop()` takes no code**: Clients are told `closedByServer` with code 0. A `stop(code)` overload is a one-line addition if a game needs to say "restarting" versus "shutting down".
- **One close notice, no repeats.** A lost notice ends in a timeout on the other side, as the ticket asks. Messages still queued when a side closes are dropped, not flushed ahead of the notice.
- **Keepalive interval** is `min(1000 ms, timeout / 4)` of the sender's own timeout. The one-second cap keeps a peer with a shorter timeout than ours alive; nothing is sent while Messages are flowing anyway.
- **Reconnecting from the same address.** On real UDP a new Client gets a new port, so the Server sees a new address. On a simulated network (or behind a NAT reusing a mapping) the Server may still hold the old Connection if its close notice was lost; a fresh echo then replaces it, as above, with the old one closing `closedByClient`. Two challenges for one address differ only by their millisecond of issue, so this needs the two connects to be at least 1 ms apart (the test advances 100 ms).
- **Changed seam-2 tests.** `ServerEngine.accept` takes `now`, so the three `accept(…)` calls in `handshake.test.ts` and `connected.test.ts` pass `0`, the time those tests run at. No assertion changed.
- **Close notices are not authenticated**, like everything else in v1 (ADR 0004): anyone able to spoof a Client's or the Server's address can close its Connection.

### Notes for later tickets

- **Merge with tickets 07 and 08.** Ticket 07's Handshake resend repeats the _same_ echo, which the challenge comparison above relies on: a different challenge from an open address replaces the Connection. Only connected Datagrams that `ReceivedSequences` accepts (not copies, not ones 1024 or more behind) push a silence deadline back. The keepalive is an ordinary connected Datagram, so it takes the next Datagram sequence number. Ticket 07's note about remembering recent refusals was not taken up.
- A Client in `echoing` accepts a `closedByServer` notice.
- Ticket 09: keepalives are empty connected Datagrams, so acks put in that header are carried by them; `keepaliveInterval` is the knob if round-trip time needs fresher samples.
- Ticket 10: the backlog-overflow reason joins `CloseReason`; closing with it should go through the same `#forget` path (one event per Connection). A close drops queued Messages, Reliable ones included.
- A Message handler that closes its Connection still sees the remaining Messages of the same Datagram, which were received before the close; nothing arrives after the closed event.
- Clients still being authenticated when the Server stops are not told; they time out on their own.
- **Review fixes (superseding the notes above where they differ).** Each side now tells the other its timeout during the Handshake: 32 bits of milliseconds in the echo (so `MAX_AUTH_TOKEN_SIZE` is 4 bytes smaller) and in the acceptance. `keepaliveInterval(own, other)` is `min(1000, min(own, other) / 4)`, so an idle Connection stays open whatever timeouts the two sides set; chosen over a one-second floor or a ping/answer flag because it costs nothing after the Handshake and needs no new Datagram kind. The Client makes its `Link` on acceptance, when it learns the Server's timeout. A side's timeout still has to exceed the other side's Tick or send step, which no keepalive can beat. `Server.stop(code = 0)` (engine `stop(code)`) tells open Connections and Clients still being authenticated `closedByServer` with the game's code, so a game picks a shutdown code no `Connection.close` uses; no new close reason was needed.
