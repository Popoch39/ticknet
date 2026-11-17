# 03: Typed Unreliable Messages batched per Tick

**What to build:** A game developer defines a Message once, with an id and their own encode and decode functions, then sends it as Unreliable in both directions and receives it in a typed handler. The Server runs a fixed-rate Tick loop owned by the library: the developer gets a callback per Tick, and everything sent during a Tick leaves when it ends. The Client batches its sends at its own send rate and exposes the last Server Tick number it received. See the spec, user stories 1 to 9, 12 to 14, 23, 24, 27 and 32, and "Public API behavior".

**Blocked by:** 02

**Status:** ready-for-agent

- [x] A Message is defined from a numeric id and a codec; sending and handling it are type-checked against that definition
- [x] Defining two Messages with the same id fails with a clear error
- [x] A Client sends an Unreliable Message and the Server's handler for that Message type receives the Connection and the decoded value; the same works from Server to Client
- [x] The Server calls the Tick callback at the configured rate with an increasing Tick number, driven by the injected Clock
- [x] Messages sent during a Tick are not on the network until the Tick ends, and several small Messages to one Connection leave in a single Datagram
- [x] The Client flushes at its configured send rate, not on every send
- [x] The Client exposes the last Server Tick number it received
- [x] The Server can send one Message to every Connection in one call
- [x] Sending an Unreliable Message too large for one Datagram fails immediately with a clear error
- [x] A received Message with an unknown id is ignored and the rest of the Datagram is still delivered
- [x] A decode function that throws is contained and reported; the Tick continues and other Messages are delivered
- [x] Tests go through the public Server and Client API on the simulated network

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `message.ts`: `defineMessages({ name: { id, encode, decode } })` returns a frozen record of `MessageType<T>` (`{ name, id, encode, decode }`), with `T` inferred from the codec. Ids are integers from 0 to `MAX_MESSAGE_ID` (65535); a duplicate id or an id out of range throws at definition. `DeliveryMode` is `"unreliable"` only: tickets 08 and 10 widen the union.
- `message-router.ts`: `MessageRouter<Context>`, shared by both adapters. One handler per Message type (`on(type, handler)` throws for a second handler, or for another type with the same id). `route(id, body, context)` ignores ids without a handler, and contains a throwing decode function or handler, reporting an `Error` with the original as `cause`.
- `datagram.ts`: new kind 6, the **connected Datagram**, sent both ways on an open Connection. Layout: version, kind, sender's Tick number (u32 big-endian), then Message entries up to the end. Each entry: entry type (u8, `1` = Unreliable), Message id (u16), body length (u16), body. A cut, overrunning or unknown-type entry drops the whole Datagram. `MAX_DATAGRAM_MESSAGE_SIZE` (1189 today) is derived from the header sizes, so it shrinks on its own when acknowledgement data joins the header. `packMessages` fills Datagrams in send order.
- `outbox.ts`: `Outbox`, the per-Connection queue of Messages not yet on the network; `push` checks the size (`assertFitsInDatagram`) and `flush(tick)` returns encoded connected Datagrams. This is the natural home for acks, Sequenced and Reliable state, resends and the Send budget.
- `cadence.ts`: `Cadence`, the instants `start + n * interval` of a fixed-rate loop, computed from the start (no drift at 30 Hz); validates the rate.
- `server-engine.ts`: `new ServerEngine({ secret, tickRate }, now)`. Ticks are numbered from 1, the first one interval after the Server starts; `nextDeadline()` is always the next Tick. New events `tick` and `message` (`connection`, `id`, `body`); new methods `send(connection, id, body, delivery)` and `broadcast(id, body, delivery)`. A Tick ends at the first `pollDatagrams` after the `pollEvents` that returned its `tick` event, so whatever the game sends while handling it leaves with it; `advance` runs at most one Tick per call. This relies on a contract now written on `Engine`: the caller handles every event of one `pollEvents` before calling `pollDatagrams` again (`EngineDriver` already does).
- `client-engine.ts`: `ClientEngineConfig.sendRate`; new event `message`; `send(id, body, delivery)` (throws unless connected); `lastServerTick`. Once connected, `nextDeadline()` is the next send step; a late wake-up flushes once and skips the missed steps. The Client stamps its own send-step count as the Tick number of its Datagrams; the Server ignores it for now.

server and client:

- `Server`: `tickRate` option (30 by default), `on("tick", (tick) => …)`, `on("error", (error) => …)`, `onMessage(type, (connection, value) => …)`, `broadcast(type, value, delivery)`. `Connection.send(type, value, delivery)`. `Connection` objects are stable per Connection (the same object reaches every handler).
- `Client`: `sendRate` option (30 by default), `send(type, value, delivery)`, `onMessage(type, (value) => …)`, `on("error", …)`, `lastServerTick`.
- Encoding happens at send time, so an encoder error or an oversized Message throws at the call site.
- `defineMessages`, `MessageType`, `MessageCodec`, `MessageDefinition` and `DeliveryMode` are re-exported by server and client; a game's shared definition file can import them from `@ticknet/core`.

Tests: seam 1 in `packages/server/test/messages.test.ts` (a `recorded` Transport wrapper observes Datagrams emitted); seam 2 in `packages/core/test/connected.test.ts` (malformed connected Datagrams only).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent): seam 1 as the ticket requires, plus seam 2 only for malformed connected Datagrams, as the spec reserves it for hostile input.
- **Definition scope.** Duplicate ids are rejected within one `defineMessages` call ("at definition"). Two separate calls reusing an id are caught when both get a handler on the same endpoint, not when sending.
- **Delivery mode is a required argument of every send**, as the glossary makes it a per-send choice; it is not part of the definition.
- **Messages are delivered as they arrive**, not held until the next Tick. Handlers may run between Ticks; whatever they send waits for the end of the next Tick.
- **Handler errors are contained too**, not only decode errors, since a throwing handler would otherwise stop the Messages after it and leave the driver without its next wake-up. Without an `error` listener, errors go to `console.error`.
- **`lastServerTick` is the highest Tick number received**, so a reordered older Datagram does not move it back. It is `undefined` until a connected Datagram arrives.
- **Wire sizes.** Message ids are u16 and entry overhead is 5 bytes; the Tick number is u32 (about 4.5 years at 30 Hz before it wraps).
- **Test change in ticket 02's seam 2.** "a connection request that is never echoed … leaves nothing pending" asserted `nextDeadline()` was undefined, which a ticking Server makes false by design. It now compares with a Server that never saw the request (same events, same deadline, no Datagram), which keeps its intent.

### Notes for later tickets

- A Client's handlers can only be registered after `connect` resolves. With the manual Clock, a single `clock.advance` that covers both the Handshake and a Server Tick delivers that Tick's Messages before the `await` resumes, and they are dropped for lack of a handler: tests connect with `clock.advance(0)` and `await` before advancing further. Reliable delivery (ticket 10) will need an answer for Messages that arrive before a handler exists.
- Under reordering (ticket 07), a connected Datagram can reach the Client before `accepted`; it is ignored for now. Treating it as an implicit acceptance would be cheap.
- A Tick callback (or `connectionOpened` listener) that throws escapes `EngineDriver.#pump`, which then never re-arms its wake-up: the Server stops ticking. Only Message handlers are contained so far. (Review fix: the Server now contains every `tick`, `connectionOpened` and `connectionClosed` listener and reports a throw on `error` as `A "<event>" listener threw`, with the original as `cause`.)
- `Connection.send` on a Connection the engine no longer has throws "There is no open Connection"; ticket 06 decides the final behavior.
- Ticket 11's refusal by Send budget will need `send` to return a value; it returns `void` today.
