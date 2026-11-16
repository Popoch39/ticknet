# 06: Closing, timeouts and keepalive

**What to build:** A game developer always knows when and why a Connection ended. A Client can leave on purpose and the Server learns it at once; the Server can kick a Connection with its own reason code; stopping the Server tells every Client; a peer that goes silent times out after a configurable delay. A Connection with nothing to send stays alive without the developer doing anything. Reconnecting always creates a new Connection. See the spec, user stories 11, 15, 17, 25, 26, 38 and 39, and "Public API behavior" (close reasons).

**Blocked by:** 03, 04

**Status:** ready-for-agent

- [ ] A Client that disconnects on purpose causes a Connection closed event on the Server with a closed-by-Client reason, without waiting for the timeout
- [ ] The Server closes a Connection with a developer-chosen code, and the Client is told it was closed by the Server with that code
- [ ] Stopping the Server tells every connected Client it was closed by the Server
- [ ] A close notice lost on the network still ends in a closed Connection on the other side, through the timeout
- [ ] A Client that stops responding causes a Connection closed event with a timeout reason after the configured delay, and a Client whose Server vanishes is told the same
- [ ] A Connection on which neither side sends any Message stays open well beyond the timeout
- [ ] After a Connection closed event, sending on that Connection fails clearly and no further Message from it is delivered
- [ ] A Client that connects again after being closed gets a new Connection; nothing from the old one is resumed
- [ ] Each of these goes through the public API on the simulated network with the manual Clock
- [ ] One integration test on real UDP loopback covers a Client disconnecting and a Server stopping
