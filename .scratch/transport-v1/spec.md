# ticknet transport v1

Status: ready-for-agent

## Problem Statement

A developer building a real-time multiplayer game on Bun has `Bun.udpSocket` and nothing above it. Raw UDP gives them datagrams that can be lost, duplicated, reordered or spoofed, and no notion of who is connected. Before writing any game logic they must build connections, a handshake, timeouts, acknowledgements, resends, ordering, fragmentation and bandwidth limits, and they must do it identically on the server and on the client. No library on npm or GitHub offers this on top of `Bun.udpSocket` today.

## Solution

ticknet is a transport library for real-time games on Bun, published as three npm packages: a Server library, a Client library and a shared core.

The developer defines typed Messages, starts a Server on a port and connects Clients to it. Each Message is sent with one of three Delivery modes: Unreliable, Sequenced or Reliable. The library owns a fixed-rate Tick loop: everything sent during a Tick leaves together, in as few Datagrams as possible. The developer never sees a Datagram, an acknowledgement or a Fragment.

v1 covers Bun-to-Bun only. It does not replicate game state, does not encrypt, and does not reach browsers.

## User Stories

### Defining Messages

1. As a game developer, I want to define a Message once with an id and my own encode and decode functions, so that Server and Client share one typed definition.
2. As a game developer, I want sending and receiving a Message to be type-checked against its definition, so that I catch payload mistakes at compile time.
3. As a game developer, I want to choose my own binary format, so that I am not locked into a schema language.
4. As a game developer, I want a clear error when two Messages are defined with the same id, so that I do not debug silent misrouting.
5. As a game developer, I want a Datagram carrying an unknown Message id to be ignored without crashing, so that a misbehaving Client cannot take the Server down.
6. As a game developer, I want a decode function that throws to be contained and reported, so that one malformed Message does not break the Tick.

### Running a Server

7. As a game developer, I want to start a Server on a port with a Tick rate, so that I have a fixed-rate loop without writing one.
8. As a game developer, I want a callback on every Tick with the Tick number, so that I run my simulation step there.
9. As a game developer, I want Messages I send during a Tick to leave when that Tick ends, so that my sends are batched without effort.
10. As a game developer, I want to be notified when a Connection opens, so that I can spawn the player.
11. As a game developer, I want to be notified when a Connection closes, with a reason, so that I can clean up and log why.
12. As a game developer, I want to register a handler per Message type that receives the Connection and the decoded value, so that routing is done for me.
13. As a game developer, I want to send a Message to one Connection, so that I can address a single Client.
14. As a game developer, I want to send a Message to every Connection at once, so that broadcasting is one call.
15. As a game developer, I want to close a Connection with a reason code of my choosing, so that the Client knows why it was kicked.
16. As a game developer, I want to cap the number of Connections, so that the Server refuses extra Clients cleanly.
17. As a game developer, I want to stop the Server and have every Client told it closed, so that shutdown is not seen as a timeout.
18. As a game developer, I want to attach my own data to a Connection at authentication, so that I can find the player behind it.

### Connecting a Client

19. As a game developer, I want to connect a Client to a host name and port, so that I do not resolve DNS myself.
20. As a game developer, I want connecting to resolve once the Handshake is complete, so that I know when I can send.
21. As a game developer, I want a failed connection to tell me why (denied, Server full, timeout, version mismatch), so that I can show the right message to the player.
22. As a game developer, I want to pass an Auth token when connecting, so that my Server can decide who gets in.
23. As a game developer, I want the Client to batch its sends at a fixed send rate, so that input Messages do not each cost a Datagram.
24. As a game developer, I want the Client to expose the last Server Tick number it received, so that I can timestamp what I render.
25. As a game developer, I want to disconnect a Client on purpose and have the Server learn it immediately, so that the player leaves without waiting for a timeout.
26. As a game developer, I want the Client to tell me when it lost the Server, with a reason, so that I can return to a menu.

### Delivery modes

27. As a game developer, I want to send a Message as Unreliable, so that one-off effects cost nothing when lost.
28. As a game developer, I want to send a Message as Sequenced, so that a late position update never overwrites a newer one.
29. As a game developer, I want to send a Message as Reliable, so that chat and score events arrive exactly once and in order.
30. As a game developer, I want a duplicated Datagram to never deliver a Message twice, so that I do not deduplicate myself.
31. As a game developer, I want a Reliable Message larger than one Datagram to be split into Fragments and reassembled, so that I can send an initial world state.
32. As a game developer, I want an immediate error when I send an Unreliable or Sequenced Message that cannot fit in one Datagram, so that I find the problem during development.
33. As a game developer, I want Reliable Messages to keep being resent until acknowledged, so that packet loss only delays them.

### Limits and health

34. As a game developer, I want each Connection to have a Send budget per Tick, so that one busy Tick cannot flood a player's link.
35. As a game developer, I want Reliable Messages over the Send budget to wait for the next Tick, so that they are delayed rather than dropped.
36. As a game developer, I want to be told at send time when an Unreliable Message is refused because the Send budget is spent, so that I can decide what to skip.
37. As a game developer, I want to read the round-trip time and loss rate of a Connection, so that I can show a ping indicator.
38. As a game developer, I want a silent Connection to time out after a configurable delay, so that crashed Clients do not stay connected.
39. As a game developer, I want an idle Connection to stay alive without me sending anything, so that a player in a menu is not dropped.
40. As a game developer, I want a Connection whose Reliable backlog grows without bound to be closed with a reason, so that a dead link does not eat the Server's memory.

### Security

41. As a server operator, I want the Server to prove a Client's address before allocating anything for it, so that spoofed source addresses cannot fill the Connection table.
42. As a server operator, I want the Server to never answer an unproven address with more bytes than it received, so that my Server cannot be used to amplify an attack.
43. As a game developer, I want a callback that receives the Auth token and decides to accept or deny, synchronously or not, so that I can check a session with my own backend.
44. As a game developer, I want a denied Client to receive my denial reason, so that the player sees why.
45. As a server operator, I want malformed, truncated or oversized Datagrams to be dropped silently, so that garbage on the port has no effect.
46. As a game developer, I want a Client and Server built on incompatible ticknet versions to refuse each other explicitly, so that I do not chase undefined behavior.

### Testing my own game

47. As a game developer, I want to run a Server and several Clients in one process over a simulated network, so that my game tests need no sockets.
48. As a game developer, I want to set loss, latency, jitter, reordering and duplication on that network from a seed, so that a failing test replays identically.
49. As a game developer, I want to advance time by hand in tests, so that a ten-second timeout test runs instantly.
50. As a game developer, I want to apply the same network conditions on top of real UDP, so that I can feel bad connections in a running game.

### Demo

51. As a prospective user, I want to run a terminal arena where several Clients move characters, so that I see the library working in a minute.
52. As a prospective user, I want the demo to use all three Delivery modes (positions, effects, chat), so that I learn when to use each.
53. As a prospective user, I want to launch bots against the demo Server, so that I see it under load.
54. As a prospective user, I want to start the demo with simulated loss and latency, so that I see how each Delivery mode degrades.

### Packaging

55. As a game developer, I want to install the Server and Client packages separately, so that my client build does not pull server code.
56. As a game developer, I want the packages to have no runtime dependencies, so that installing ticknet adds nothing else to my project.
57. As a game developer, I want JavaScript with type declarations in the published packages, so that my own type-check does not re-check ticknet's source.
58. As a maintainer, I want one command each for type-check, tests, lint and format across the workspace, so that the quality gate is the same locally and in CI.
59. As a maintainer, I want the core package to use no Bun API, so that a browser Transport can reuse it later.

## Implementation Decisions

### Packages

- A Bun workspace with three packages under one npm scope: core, server, client. All three are released together at the same version.
- **core** holds the whole protocol and is written without any Bun or Node API. It never reads the time and never arms a timer: time is given to it.
- **server** and **client** are thin: they bind the core to `Bun.udpSocket` and to real timers, and expose the public API. The client package also resolves host names, because `Bun.udpSocket` only accepts IP addresses.
- The simulated network and the network-condition wrapper ship as a public testing entry point of core, so that games can use them in their own tests and the demo can use them over real UDP.

### Core modules

- **Protocol engine.** One deep module per role (Server side, Client side). Inputs: a received Datagram with its origin, the passage of time, Messages to send, a request to close. Outputs: Datagrams to send and events (Connection opened, Connection closed with reason, Message received). Everything else below is hidden behind it.
- **Message registry.** Maps a numeric id to a codec supplied by the game. Duplicate ids are rejected at definition.
- **Datagram codec.** Every Datagram starts with a protocol version byte, reserved so that encryption or format changes can be introduced later. Datagrams also carry the sender's Tick number and acknowledgement data.
- **Delivery.** Acknowledgements ride on every outgoing Datagram. Reliable Messages form a single ordered stream per Connection and are resent after a delay derived from the measured round-trip time. Sequenced ordering is tracked per Message type.
- **Fragmentation.** Only Reliable Messages are fragmented. A Datagram never exceeds 1200 bytes.
- **Handshake.** The Client asks to connect; the Server answers with a challenge that it can verify later without storing anything; the Client echoes the challenge together with its Auth token; only then does the Server call the game's authentication callback and create the Connection. Client handshake Datagrams are padded so that no reply to an unproven address is larger than the request.
- **Connection health.** Round-trip time and loss rate are estimated from acknowledgements. A Connection with nothing to send still emits keepalive Datagrams well inside the timeout.
- **Send budget.** A fixed number of bytes per Connection per Tick. No adaptive congestion control.
- **Transport interface.** Send one or many Datagrams to an address, receive Datagrams with their origin, report that the underlying socket is writable again, close. This is the only thing a future browser adapter has to implement.
- **Clock interface.** Current time and a way to be called back at a given time. Real in the adapters, manual in tests.

### Public API behavior

- Server options: port, host, Tick rate, maximum Connections, timeout, Send budget, authentication callback, and optionally a Transport and a Clock.
- Client options: host, port, Auth token, send rate, timeout, and optionally a Transport and a Clock.
- The Tick callback runs first, then the Server flushes every Connection. With the UDP Transport the flush goes through one `sendMany` call.
- When the socket reports it is full, Datagrams that could not be written are treated as lost: Unreliable and Sequenced content is gone, Reliable content is resent by the normal mechanism.
- Close reasons are a closed set plus an application code: timeout, closed by Client, closed by Server (with the game's code), denied (with the game's code), Server full, version mismatch, Reliable backlog overflow.
- Reconnecting always creates a new Connection. Nothing is resumed.
- The Client exposes the last received Server Tick number and its round-trip time. It does not estimate the Server's current Tick.
- The Auth token is opaque bytes, bounded so that the Handshake fits in one Datagram.

### Tooling and release

- TypeScript in strict mode. Quality gate: `bun check`, `bun test`, `bun lint`, `bun fmt`.
- Published artifacts: JavaScript built by `bun build`, declarations emitted by `tsc`. `typescript` is the only development dependency.
- License: MIT.

### Demo

- A terminal arena run as separate Bun processes: one Server, any number of Clients, any number of bots. Positions are Sequenced, effects are Unreliable, chat is Reliable.
- Flags to apply loss and latency through the network-condition wrapper.

## Testing Decisions

A good test here describes what a game developer or a remote endpoint can observe: Messages delivered, events raised, values exposed, Datagrams emitted. It never reaches into acknowledgement tables, queues or private state. Tests on the simulated network use a seed and a manual Clock: no real timers, no sleeps, no flakiness.

There is no prior art in the repository; these tests establish the pattern.

Two seams are tested.

- **Seam 1: the public Server and Client API**, with Transport and Clock injected. This carries most of the suite: connect and deny, the three Delivery modes under loss, reordering and duplication, fragmentation of large Reliable Messages, Send budget behavior, timeouts and keepalive, close reasons, Tick batching, Server full, shutdown.
- **Seam 2: the core protocol engine**, driven directly with Datagrams and time. It is reserved for what the public API cannot express, because it needs hostile or precise input: spoofed and replayed handshakes, the no-amplification rule, malformed and truncated Datagrams, an unknown version byte, the 1200-byte ceiling, resend timing against a known round-trip time, Fragment reassembly with missing or repeated Fragments.

To keep seam 2 from freezing the wire format, its tests assert on emitted events and on behavior between two engines wherever possible. Byte-level assertions are limited to the properties this spec fixes: the leading version byte, the Datagram size ceiling and handshake reply sizes.

A small number of integration tests run seam 1 over real UDP on loopback, to cover the `Bun.udpSocket` adapters: connect, exchange each Delivery mode once, disconnect, and Server shutdown.

The demo is not covered by automated tests beyond starting a Server and bots and checking that they connect.

## Out of Scope

- Browser Clients. The planned path is WebTransport datagrams once Bun supports it natively; v1 only guarantees that core has no Bun dependency and that the Transport interface exists.
- State synchronization: snapshots, deltas, interpolation, prediction, estimating the Server's current Tick on the Client.
- Encryption and signed connect tokens. Datagrams are plaintext in v1.
- Peer-to-peer, NAT traversal, relays, matchmaking, rooms.
- Node.js compatibility.
- Adaptive congestion control.
- Transparent reconnection and Connection migration across IP changes.
- Fragmentation of Unreliable or Sequenced Messages.
- A built-in schema or serialization language.
- The actual `npm publish`. The spec ends with packages that pass a publish dry run; publishing is a human step, after checking that the package name and scope are available.

## Further Notes

- **Glossary and ADRs are not written yet.** The vocabulary used here (Datagram, Message, Delivery mode, Unreliable, Sequenced, Reliable, Fragment, Server, Client, Connection, Handshake, Auth token, Tick, Send budget, Transport) was agreed during the grilling session and still has to be recorded in the root glossary. Terms to avoid: Packet, Peer, Channel, Player. Five decisions are candidates for ADRs: transport-only scope, sans-IO core in its own package, library-owned Tick, plaintext Datagrams in v1, WebTransport for browsers.
- **`bun lint` is not in Bun 1.4.4.** It is documented as built in at bun.com/docs/lint, but on the installed 1.4.4 the command looks for a package script and fails. Until a Bun release ships it, the gate is `bun check`, `bun fmt --check` and `bun test`; `bun lint` joins the gate when available. No third-party linter is to be added in the meantime.
- **`Bun.udpSocket` facts relied on** (Bun 1.4.4): connected sockets, `sendMany`, a `drain` handler for backpressure, `uint8array` binary type, IP addresses only.
- **Defaults chosen without discussion**, to confirm or change during implementation: Server Tick rate 30 Hz; Client send rate 30 Hz; 64 Connections maximum; Sequenced ordering per Message type; a single Reliable stream per Connection; closing a Connection when its Reliable backlog passes a limit; a broadcast helper on the Server; the testing entry point being public.
- **Suggested build order**: workspace scaffold; core with Handshake and Unreliable Messages on the simulated network; UDP adapters with loopback tests and close reasons; Sequenced and health metrics; Reliable and Send budget; Fragmentation; demo; publishable build.
