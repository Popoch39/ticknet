# 09: Connection health: round-trip time and loss

**What to build:** A game developer reads the round-trip time and the loss rate of a Connection on the Server, and of its link to the Server on the Client, to show a ping indicator or spot a bad link. Both are estimated from acknowledgements that ride on every outgoing Datagram, which is also the groundwork the Reliable Delivery mode needs. See the spec, user story 37, and "Core modules" (Delivery, Connection health).

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] The Server exposes a round-trip time and a loss rate per Connection; the Client exposes the same for its link to the Server
- [ ] On a simulated link with a fixed latency and no loss, the round-trip time converges close to twice that latency
- [ ] When the latency of the link changes, the round-trip time follows within a few seconds of simulated time
- [ ] On a simulated link with a known loss rate, the reported loss rate converges close to it; with no loss it reports zero
- [ ] Duplicated and reordered Datagrams do not distort the estimates beyond what the conditions explain
- [ ] An idle Connection still reports health values, kept fresh by keepalive Datagrams
- [ ] Through the protocol engine: every outgoing Datagram carries acknowledgement data for recently received Datagrams
- [ ] Health values are exposed before any sample exists in a way that cannot be mistaken for a real measurement
