# 02: Connect over the simulated network

**What to build:** A game developer starts a Server and connects a Client to it in one process, over a simulated network with a manual Clock. The Server is told a Connection opened; the Client's connect call resolves. Behind this sits the Handshake: the Server proves the Client's address with a challenge before allocating anything. This ticket introduces the Transport and Clock interfaces, the protocol engine for both roles, and a simulated network with perfect conditions. See the spec, sections "Core modules" (Handshake, Datagram codec, Transport interface, Clock interface) and "Testing Decisions".

**Blocked by:** 01

**Status:** resolved

- [x] Through the public API, with Transport and Clock injected, a Client connects to a Server: the Server raises a Connection opened event and the Client's connect resolves
- [x] Several Clients can connect to the same Server and each gets its own Connection
- [x] Time only moves when the test advances the manual Clock; core reads no real time and arms no real timer
- [x] A Client that gets no answer fails to connect with a timeout reason after the configured delay
- [x] Every Datagram starts with the protocol version byte; a Client and Server with different versions refuse each other with a version mismatch reason
- [x] Through the protocol engine: a connection request from an address that never echoes the challenge creates no Connection and leaves no per-address state on the Server
- [x] Through the protocol engine: a challenge echoed from a different address than it was issued to is rejected
- [x] Through the protocol engine: no Datagram sent to an unproven address is larger than the Datagram that triggered it
- [x] Through the protocol engine: malformed, truncated and oversized Datagrams are dropped without an event and without throwing
- [x] No Datagram exceeds 1200 bytes

## Comments

### Architecture map (for later tickets)

core (`packages/core/src/`, no Bun or Node API):

- `transport.ts`: `Address` (`{ host, port }`), `addressKey`, the `Transport` interface (`listen(receiver)`, `send(datagrams[])` returning how many were accepted, `close()`) and `TransportReceiver` (`datagram(data, from)`). The spec's "socket writable again" report is not there yet: ticket 04 adds `writable()` to `TransportReceiver` when the UDP adapter needs it.
- `clock.ts`: the `Clock` interface (`now()` in milliseconds, `schedule(at, callback)` returning a cancel function).
- `engine.ts`: the `Engine<Event>` contract shared by both roles (`receive(data, from, now)`, `advance(now)`, `nextDeadline()`, `pollDatagrams()`, `pollEvents()`), and `EngineDriver`, the only place where an engine meets a Transport and a Clock. It feeds received Datagrams in, sends what the engine queued in one `send` call, hands events to a callback until both queues are empty, and keeps one Clock wake-up at `nextDeadline()`. Every timed behavior (Ticks, send rate, keepalive, timeouts, resends) is meant to be an engine deadline, so the driver needs no change for it.
- `server-engine.ts`: `ServerEngine`, the Server role. Connections are keyed by address; a Connection exists only after a valid challenge echo; replies to unproven addresses go through `#answerUnproven`, which drops anything larger than the trigger.
- `client-engine.ts`: `ClientEngine`, one connection attempt (a reconnect is a new engine). States `requesting` → `echoing` → `connected`, or `closed` with a reason. The Handshake deadline is `now + timeout`.
- `datagram.ts`: the codec. Byte 0 is the version, byte 1 the kind, then a kind-specific body. `decodeDatagram` returns a `Datagram`, `{ kind: "otherVersion" }` or `undefined` (malformed, truncated, oversized). Kinds 1 to 5: connect request, challenge, challenge response, accepted, refused. Later kinds (Messages with a Tick number and acknowledgement data, close notice, keepalive) get new kind bytes and their own header after byte 1.
- `challenge.ts` and `siphash.ts`: the stateless challenge, 12 bytes: the time of issue (32-bit milliseconds, wrapping) plus a SipHash-2-4 tag over that time and the Client's address, keyed by a 16-byte Server secret. Valid for 5 seconds.
- `close-reason.ts`: the `CloseReason` union, `timeout` and `versionMismatch` so far. Tickets 05 and 06 add the other reasons from the spec.
- `testing/`: the `@ticknet/core/testing` entry point, with `ManualClock` (`advance(ms)` runs due callbacks in time order, including those scheduled meanwhile) and `SimulatedNetwork` (`bind(address)` returns a Transport; perfect conditions; delivery is scheduled on the Clock at the current time, never synchronous). Ticket 07 adds conditions there.

server and client:

- `packages/server/src/server.ts`: `startServer({ transport, clock })` (async, ready for ticket 04's socket binding), `Server.on("connectionOpened", listener)`, `Connection` (`address`). The challenge secret comes from `crypto.getRandomValues`.
- `packages/client/src/client.ts`: `connect({ host, port, transport, clock, timeout? })` resolving to a `Client` (empty for now), or rejecting with a `ConnectError` carrying `reason: CloseReason`.

Tests: seam 1 in `packages/server/test/connect.test.ts` (Server and Client together) and `packages/client/test/connect.test.ts` (Client against raw simulated endpoints); seam 2 in `packages/core/test/handshake.test.ts`.

### Decisions and assumptions

- **Cross-version contract.** Two rules are fixed for every future version: the version byte comes first, and a Client's Handshake Datagrams are exactly 1200 bytes. A Server answers a 1200-byte Datagram of another version with a refusal starting with its own version byte; any other foreign Datagram is dropped, so stray bytes on the port go unanswered. A Client in the Handshake treats any Datagram from the Server's address with another version byte as a version mismatch.
- **Padding.** Both Client Handshake Datagrams (connect request, challenge response) are padded to the full 1200 bytes, and the Server ignores them at any other size. This gives the Server room to answer an unproven address with up to 1200 bytes (ticket 05's refusals included) and checks the 1200-byte path at connect time. Ticket 05's Auth token goes after the challenge in the challenge response, inside that padding.
- **SipHash-2-4 in core.** core's lib has no Web Crypto or Node crypto, and Web Crypto's HMAC is asynchronous, so core implements SipHash-2-4, the standard keyed hash for short-input cookies. It was checked against the published reference vectors and an independent BigInt implementation (about 1.4 µs per challenge). The secret is passed in (`ServerEngineConfig.secret`), so core still uses no runtime API.
- **`Address` is `{ host, port }`**, not an opaque string, so that the Client's `host` and `port` options map to it directly and `Bun.udpSocket`'s `(port, address)` callbacks and `sendMany` triples convert without parsing.
- **Options.** `transport` and `clock` are required for now, since there is no UDP default before ticket 04; the Server has no `port` or `host` option yet. The Client's `timeout` (10 seconds by default) bounds the Handshake; ticket 06 is expected to reuse it for silent Connections.
- **No Handshake retransmission yet.** On a perfect network it is never needed. Under loss (ticket 07), the Client should resend its request or echo on a short deadline; `ClientEngine.nextDeadline` is the hook. The Server already answers a repeated echo again without opening a second Connection.
- **Refusals.** The Server encodes `refused` (kind 5, one reason byte) only for version mismatch; the Client does not decode it yet, since a Server of the same version never sends it. Ticket 05 adds decoding with `denied` and `serverFull`.
- **Workspace dev dependency.** `@ticknet/server` has `@ticknet/client` as a workspace dev dependency so that seam-1 tests can run both sides. No third-party dependency was added.
- **Scaffold tests.** The trivial `PROTOCOL_VERSION` tests from ticket 01 are kept; server and client also re-export `Address`, `Clock` and `Transport` (and the client `CloseReason`) for the types in their options.

### Notes for later tickets

- Bun's `expect(promise).resolves` and `.rejects` wait for the promise synchronously, so a promise that never settles hangs the run past `--timeout`. Record the outcome with `.then` or `.catch`, let callbacks run with `await new Promise((resolve) => setImmediate(resolve))`, then assert (see `track` and `settle` in `packages/client/test/connect.test.ts`).
- Nothing crosses the simulated network until the Clock moves: `clock.advance(0)` delivers everything due now, including the whole Handshake.
- `connect` sends its first Datagram synchronously. Ticket 04's host name resolution must keep the injected-Transport path free of real I/O, or every seam-1 test must change.
