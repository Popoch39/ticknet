# 02: Connect over the simulated network

**What to build:** A game developer starts a Server and connects a Client to it in one process, over a simulated network with a manual Clock. The Server is told a Connection opened; the Client's connect call resolves. Behind this sits the Handshake: the Server proves the Client's address with a challenge before allocating anything. This ticket introduces the Transport and Clock interfaces, the protocol engine for both roles, and a simulated network with perfect conditions. See the spec, sections "Core modules" (Handshake, Datagram codec, Transport interface, Clock interface) and "Testing Decisions".

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Through the public API, with Transport and Clock injected, a Client connects to a Server: the Server raises a Connection opened event and the Client's connect resolves
- [ ] Several Clients can connect to the same Server and each gets its own Connection
- [ ] Time only moves when the test advances the manual Clock; core reads no real time and arms no real timer
- [ ] A Client that gets no answer fails to connect with a timeout reason after the configured delay
- [ ] Every Datagram starts with the protocol version byte; a Client and Server with different versions refuse each other with a version mismatch reason
- [ ] Through the protocol engine: a connection request from an address that never echoes the challenge creates no Connection and leaves no per-address state on the Server
- [ ] Through the protocol engine: a challenge echoed from a different address than it was issued to is rejected
- [ ] Through the protocol engine: no Datagram sent to an unproven address is larger than the Datagram that triggered it
- [ ] Through the protocol engine: malformed, truncated and oversized Datagrams are dropped without an event and without throwing
- [ ] No Datagram exceeds 1200 bytes
