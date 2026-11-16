# 05: Authentication and refusals

**What to build:** A game developer decides who gets in. The Client passes an Auth token when connecting; once the Handshake has proven the Client's address, the Server hands the token to the developer's authentication callback, which accepts or denies, synchronously or not. An accepted Client gets a Connection carrying data the developer attached; a refused Client learns why. The Server also refuses Clients beyond its maximum number of Connections. See the spec, user stories 16, 18, 21, 22, 43 and 44, and "Core modules" (Handshake).

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] The Client's Auth token reaches the Server's authentication callback unchanged, as opaque bytes, together with the Client's address
- [ ] The callback is never called for an address that has not completed the challenge
- [ ] An accepting callback opens the Connection, and data it returns is readable on that Connection
- [ ] A denying callback opens no Connection, and the Client's connect fails with a denied reason carrying the developer's code
- [ ] The callback may answer asynchronously; the Client connects or is denied once it answers, and times out if it never does
- [ ] A callback that throws denies the Client and is reported, without stopping the Server
- [ ] An Auth token too large to fit the Handshake in one Datagram fails the connect call immediately with a clear error
- [ ] With the maximum number of Connections reached, a further Client fails to connect with a Server full reason, and can connect once a Connection has closed
- [ ] With no authentication callback configured, every Client that completes the Handshake is accepted
- [ ] Tests go through the public Server and Client API on the simulated network
