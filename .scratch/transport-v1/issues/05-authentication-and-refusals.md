# 05: Authentication and refusals

**What to build:** A game developer decides who gets in. The Client passes an Auth token when connecting; once the Handshake has proven the Client's address, the Server hands the token to the developer's authentication callback, which accepts or denies, synchronously or not. An accepted Client gets a Connection carrying data the developer attached; a refused Client learns why. The Server also refuses Clients beyond its maximum number of Connections. See the spec, user stories 16, 18, 21, 22, 43 and 44, and "Core modules" (Handshake).

**Blocked by:** 02

**Status:** resolved

- [x] The Client's Auth token reaches the Server's authentication callback unchanged, as opaque bytes, together with the Client's address
- [x] The callback is never called for an address that has not completed the challenge
- [x] An accepting callback opens the Connection, and data it returns is readable on that Connection
- [x] A denying callback opens no Connection, and the Client's connect fails with a denied reason carrying the developer's code
- [x] The callback may answer asynchronously; the Client connects or is denied once it answers, and times out if it never does
- [x] A callback that throws denies the Client and is reported, without stopping the Server
- [x] An Auth token too large to fit the Handshake in one Datagram fails the connect call immediately with a clear error
- [x] With the maximum number of Connections reached, a further Client fails to connect with a Server full reason, and can connect once a Connection has closed
- [x] With no authentication callback configured, every Client that completes the Handshake is accepted
- [x] Tests go through the public Server and Client API on the simulated network

## Comments

### Architecture map update (for later tickets)

core:

- `datagram.ts`: the challenge response (kind 3) carries, after the 12-byte challenge, a 16-bit token length and the Auth token, all inside the 1200-byte padding. `MAX_AUTH_TOKEN_SIZE` is 1184. `refused` (kind 5) is now decoded: one reason byte (1 version mismatch, 3 Server full), or reason 2 (denied) followed by the game's 16-bit code.
- `close-reason.ts`: adds `{ kind: "denied", code }` and `{ kind: "serverFull" }`, and `MAX_CLOSE_CODE` (65535): codes travel as 16-bit integers. Ticket 06's "closed by Server" code should use the same range.
- `server-engine.ts`: a valid echo no longer opens a Connection. It raises `authenticationRequested` (`connection` id, `address`, `authToken`), and the caller answers with `accept(connection)` (returns whether it opened) or `deny(connection, code)` (throws a RangeError for a code out of range). The Connection id is allocated at that point and kept on acceptance. `ServerEngineConfig` gains `maxConnections` and `timeout`. Pending Clients live in `#authenticating` (with their deadline) and `#authenticatingAddresses`; open ones in ticket 03's `#byAddress` and `#byId`. The cap counts both. A pending authentication expires after `timeout` (the engine's first real deadline); a later decision is ignored. `close(connection)` forgets an open Connection, without telling the Client.
- `client-engine.ts`: `ClientEngineConfig.authToken`; the constructor throws a RangeError for a token over `MAX_AUTH_TOKEN_SIZE`, before queuing anything. A `refused` received during the Handshake closes the attempt with its reason.
- `engine.ts`: `EngineDriver.perform(action)` calls into the engine from outside a receive or a deadline (here, an asynchronous authentication answer or `Connection.close()`), then sends and dispatches as usual. Called from inside an event handler, it leaves the output to the pump already running. Ticket 03's sends from outside the Tick can use it.

server and client:

- `startServer` has two overloads: without `authenticate` it returns `Server<undefined>`, with it `Server<Data>`, where `Data` is what accepting decisions attach. New options: `authenticate`, `maxConnections` (64), `timeout` (10 s).
- `authenticate({ address, authToken })` returns, or resolves to, `{ accept: true, data? }` or `{ accept: false, code? }` (code 0 by default). `data` is optional only when `Data` allows `undefined`.
- `Connection` gains `data` and a minimal `close()`, next to ticket 03's `send`; both go through a private `ConnectionLink`. Authentication failures are reported on ticket 03's `error` event. A thrown value that is not an `Error` is wrapped in one, with the value as its `cause`.
- After merging ticket 03, the Server keeps one `#connections` map from acceptance to `close()`. It feeds both the `connectionOpened` event and Message routing, and `onMessage` handlers receive `Connection<Data>`.
- `connect` takes `authToken`; `MAX_AUTH_TOKEN_SIZE` is exported by the client, `MAX_CLOSE_CODE` by the server.

Tests: seam 1 in `packages/server/test/authentication.test.ts` (callback, data, denial, asynchronous answers, throwing callbacks, cap, Server timeout, largest token) and `packages/client/test/connect.test.ts` (oversized token). Seam 2 in `packages/core/test/handshake.test.ts`: authentication is requested only once the challenge comes back from its address, and only once per address while pending. The existing spoofed, expired and other-secret echo tests now also prove the callback is never reached, since they assert the Server raises no event at all. The "no callback, everyone accepted" checkbox is covered by the unchanged tests in `packages/server/test/connect.test.ts`.

### Decisions and assumptions

- **Seams.** The spec's two seams were used, with no new ones. I could not confirm them with the user beforehand, since I ran as a sub-agent.
- **Changed seam-2 tests.** The engine's contract changed: a valid echo now raises `authenticationRequested` instead of `connectionOpened`. So the helpers in `handshake.test.ts` accept explicitly (`acceptAll`), and "a replayed echo opens no second Connection" now replays after the acceptance and checks that the acceptance is sent again. A new test covers replays while authentication is pending.
- **A minimal `Connection.close()`.** The cap checkbox needs a Connection to close, which is ticket 06's work. `close()` only frees the place on the Server: no close notice to the Client, no `connectionClosed` event on the Server, no code. Ticket 06 should extend it (code, notice, event) rather than add a second method.
- **A Server `timeout` option**, 10 seconds by default. Clients being authenticated count towards `maxConnections`, so that an asynchronous callback cannot let more Clients in than the cap. Without a time limit, a callback that never answers would hold its place forever. After `timeout`, the Server forgets the request, sends nothing (the Client times out on its own), and ignores a late answer. Ticket 06 is expected to reuse this option for silent Connections, as the spec lists one Server `timeout`.
- **A full Server refuses before asking the game**, and only in answer to a valid echo, so a refusal never goes to an unproven address.
- **Denial codes** are integers from 0 to 65535. A thrown error, a rejected promise, or a code out of range all deny with code 0 and are reported on `error`. The Server keeps running.
- **Typing without casts.** The implementation behind the `startServer` overloads works at `Data = unknown`, where "data optional when `Data` allows undefined" resolves. It turns each decision into an internal one where `data` is always present, so `Connection<Data>.data` needs no cast. `Server` is invariant in `Data`, so the implementation's return type names both `Server<unknown>` and `Server<undefined>`.
- **Synchronous answers stay synchronous.** A callback that returns a plain decision opens or refuses within the same Handshake step. Only a returned `Promise` waits for a microtask.
- **The token is copied** when `connect` is called and again when it is decoded, so the callback gets its own bytes.

### Notes for later tickets

- In seam-1 tests, an asynchronous answer needs `await settle()` (so the promise callback runs) and then `clock.advance(0)` (so the acceptance or refusal crosses the network). The `deferredCallback` helper in `authentication.test.ts` hands answers out one request at a time.
- A Server `timeout` shorter than the Client's leaves the Client waiting until its own timeout after the Server has given up. Ticket 06's close notices may want to tell it.
