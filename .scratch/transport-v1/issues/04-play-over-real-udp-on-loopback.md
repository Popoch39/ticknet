# 04: Play over real UDP on loopback

**What to build:** A game developer starts a Server on a port and connects a Client to a host name and port with no Transport or Clock supplied: the server and client packages default to `Bun.udpSocket` and real timers. The scenario of ticket 03 now runs between real sockets. This ticket proves that the Transport interface fits `Bun.udpSocket` before more protocol is built on it. See the spec, "Packages", "Public API behavior" and the `Bun.udpSocket` facts in "Further Notes".

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] With default options, a Server listens on a UDP port and a Client connects to it on loopback
- [ ] An Unreliable Message crosses real sockets in each direction and reaches its typed handler
- [ ] The Client accepts a host name and resolves it itself, since `Bun.udpSocket` only takes IP addresses; a host name that does not resolve fails the connect with a clear reason
- [ ] The Server flushes all Connections of a Tick through one `sendMany` call
- [ ] When the socket reports it is full, the Datagrams that could not be written are treated as lost, and sending resumes after the socket reports it is writable again
- [ ] Stopping the Server and closing the Client release their sockets, so the process can exit and the port can be reused
- [ ] The integration tests use an OS-assigned port and do not depend on fixed delays to pass
- [ ] core still uses no Bun or Node API
