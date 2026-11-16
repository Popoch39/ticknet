# 03: Typed Unreliable Messages batched per Tick

**What to build:** A game developer defines a Message once, with an id and their own encode and decode functions, then sends it as Unreliable in both directions and receives it in a typed handler. The Server runs a fixed-rate Tick loop owned by the library: the developer gets a callback per Tick, and everything sent during a Tick leaves when it ends. The Client batches its sends at its own send rate and exposes the last Server Tick number it received. See the spec, user stories 1 to 9, 12 to 14, 23, 24, 27 and 32, and "Public API behavior".

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] A Message is defined from a numeric id and a codec; sending and handling it are type-checked against that definition
- [ ] Defining two Messages with the same id fails with a clear error
- [ ] A Client sends an Unreliable Message and the Server's handler for that Message type receives the Connection and the decoded value; the same works from Server to Client
- [ ] The Server calls the Tick callback at the configured rate with an increasing Tick number, driven by the injected Clock
- [ ] Messages sent during a Tick are not on the network until the Tick ends, and several small Messages to one Connection leave in a single Datagram
- [ ] The Client flushes at its configured send rate, not on every send
- [ ] The Client exposes the last Server Tick number it received
- [ ] The Server can send one Message to every Connection in one call
- [ ] Sending an Unreliable Message too large for one Datagram fails immediately with a clear error
- [ ] A received Message with an unknown id is ignored and the rest of the Datagram is still delivered
- [ ] A decode function that throws is contained and reported; the Tick continues and other Messages are delivered
- [ ] Tests go through the public Server and Client API on the simulated network
