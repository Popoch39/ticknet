# 04: Play over real UDP on loopback

**What to build:** A game developer starts a Server on a port and connects a Client to a host name and port with no Transport or Clock supplied: the server and client packages default to `Bun.udpSocket` and real timers. The scenario of ticket 03 now runs between real sockets. This ticket proves that the Transport interface fits `Bun.udpSocket` before more protocol is built on it. See the spec, "Packages", "Public API behavior" and the `Bun.udpSocket` facts in "Further Notes".

**Blocked by:** 03

**Status:** ready-for-agent

- [x] With default options, a Server listens on a UDP port and a Client connects to it on loopback
- [x] An Unreliable Message crosses real sockets in each direction and reaches its typed handler
- [x] The Client accepts a host name and resolves it itself, since `Bun.udpSocket` only takes IP addresses; a host name that does not resolve fails the connect with a clear reason
- [x] The Server flushes all Connections of a Tick through one `sendMany` call
- [x] When the socket reports it is full, the Datagrams that could not be written are treated as lost, and sending resumes after the socket reports it is writable again
- [x] Stopping the Server and closing the Client release their sockets, so the process can exit and the port can be reused
- [x] The integration tests use an OS-assigned port and do not depend on fixed delays to pass
- [x] core still uses no Bun or Node API

## Comments

### Architecture map update (for later tickets)

core (`packages/core/src/`):

- `socket-transport.ts`: `SocketTransport`, the Transport over a UDP socket, and `DatagramSocket`, the structural shape it drives (`sendMany` with flat `data, port, address` triples returning a prefix count, `close`). `Bun.udpSocket`'s socket fits it, so core names no Bun API. The code that opens the socket forwards `received(data, from)` and `drained()`. After a partial `sendMany`, the transport is "full": the rest of that batch and every later `send` return 0 (lost, nothing queued, `sendMany` not even called) until `drained()`.
- `engine.ts`: `EngineDriver.stop()` cancels the wake-up, closes the Transport and makes the pump stop, including when called from an event handler mid-pump. It sits next to ticket 05's `perform()`; a `perform` after `stop` runs its action but sends nothing.

server and client:

- `bun-adapter.ts`, **the same file in both packages** (they ship separately and the client must not pull server code): `realClock` (`performance.now()` and `setTimeout`, rounded up so a wake-up never fires before its deadline), `resolveHost` (IP literals pass through; names go through `Bun.dns.lookup`, IPv4 preferred), `openUdpTransport(hostname, port)` (opens an unconnected `uint8array` socket, wires `data` and `drain` to a `SocketTransport`, and returns it with the bound port). A change to one copy goes to the other.
- `startServer({ port?, host?, transport?, clock?, tickRate? })`: without a Transport, resolves `host` (`0.0.0.0` by default) and listens on `port` (0, system-picked, by default). `Server.port` is the bound UDP port, `undefined` with an injected Transport. `Server.stop()` releases socket and timers. After merging ticket 05, the `Server` constructor takes `(options, authenticate, transport, clock, port?)`; `startServer` is the entry point.
- `connect({ host, port, transport?, clock?, ... })`: with an injected Transport, `host` is used as is and the first Datagram still leaves synchronously (seam-1 tests unchanged); otherwise the host is resolved, then a socket is opened on `0.0.0.0` (or `::` for an IPv6 Server) port 0. `ConnectError.reason` is now a `ConnectFailure`: a `CloseReason` or `{ kind: "hostNotFound", host }`, with the lookup error as `cause`. `Client.close()` releases socket and timers. A failed connect releases them too, including an Auth token rejected by `ClientEngine` (ticket 05) after the socket was opened (test in `packages/client/test/connect.test.ts`).

Tests: `packages/server/test/udp.test.ts` (real loopback: default connect, host name, unresolvable name, Message each way, process exit in a subprocess with `test/fixtures/connect-then-leave.ts`, port reuse); `packages/server/test/socket-transport.test.ts` (seam 1 with `SocketTransport` over a fake socket bridged to the simulated network: one `sendMany` per Tick, partial write then pause until `drained`).

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer subagent): seam 1 over real loopback sockets with default options, plus seam 1 with an injected `SocketTransport` over a fake socket for `sendMany` and backpressure, since a loopback socket never reports itself full (`send` never fails on 127.0.0.1). The fake socket stands for the operating system, the only thing mocked.
- **The "socket writable again" report stays inside `SocketTransport`**, not on `TransportReceiver`: nothing above the Transport needs it yet. Pausing until `drain` follows the ticket; Bun fires `drain` after every partial write. Ticket 10 may surface it (to resend Reliable content early) by adding `writable?()` to `TransportReceiver`.
- **IPv4 first.** `Bun.dns.lookup("localhost")` lists `::1` first, and the default Server listens on IPv4 only, so both sides prefer an IPv4 address. The Server resolves its own `host` with the same rule, so `host: "localhost"` on both sides meets (binding `"localhost"` straight through Bun picks `::1`).
- **Host not found is not a `CloseReason`**: the spec's close reasons describe a Connection, so the client package widens only `ConnectError.reason`. Any lookup failure (including an empty host) maps to it.
- **Socket errors.** `ECONNREFUSED` (a Datagram bounced off a closed port, reported asynchronously by Linux, even for unconnected sockets) is ignored: the other side is gone and the protocol learns it by itself. Any other socket error is written with `console.error`, not raised on the `error` event, since the socket opens before the Server or Client exists. Without an `error` handler Bun would mark the process as failed.
- **`stop()` and `close()` only release resources.** Telling the other side is ticket 06.
- **`Server.port` is `number | undefined`** rather than a number that would be meaningless with an injected Transport.
- **`port` defaults to 0** (system-picked), which suits tests; a game Server passes its port.

### Notes for later tickets

- **Bun 1.4.4 quirk:** `Bun.dns.lookup` of an IPv4 literal (`"127.0.0.1"`, `"0.0.0.0"`) keeps the process alive for a second after it resolves; names and IPv6 literals do not. `resolveHost` passes IP literals through (`isIP` from `node:net`) for that reason. Found because the exit test took a second.
- Loopback tests wait on promises resolved by handlers, never on sleeps. The process-exit test spawns `bun` with `timeout: 4000`, so a regression kills the child and fails instead of leaving it running.
- Ticket 06's loopback test (disconnect and Server stop) can sit in `udp.test.ts` and reuse `portOf`.
- Ticket 07's wrapper over real UDP can wrap `SocketTransport` (or any Transport) and be passed as `transport`; with an injected Transport, `connect` does not resolve the host, so pass an IP address.
- Ticket 14: `bun-adapter.ts` uses `node:net` (`isIP`) besides Bun; both are fine in the server and client packages.
