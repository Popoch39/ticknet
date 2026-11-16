# 07: Seeded network conditions

**What to build:** A game developer testing their own game sets loss, latency, jitter, reordering and duplication on the simulated network from a seed, and a failing test replays identically. The same conditions can be wrapped around any Transport, including real UDP, so a running game can be played on a bad link. These tools ship as a public testing entry point of core. Under these conditions the library already guarantees one thing: a duplicated Datagram never delivers a Message twice. See the spec, user stories 30 and 47 to 50, and "Packages".

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] The simulated network accepts a loss rate, a latency, a jitter, a reordering rate and a duplication rate, and a seed
- [ ] Two runs with the same seed and the same test produce the same sequence of deliveries; a different seed produces a different one
- [ ] Latency and jitter are measured on the injected Clock, so a test with a slow link still runs instantly
- [ ] Conditions can be set per direction, so a test can make only the Client-to-Server path lossy
- [ ] The same conditions can be applied as a wrapper around any Transport, and work over real UDP on loopback
- [ ] The simulated network, the manual Clock and the wrapper are importable by a game through a public testing entry point of core
- [ ] With duplication enabled, an Unreliable Message is delivered at most once
- [ ] With loss enabled, lost Unreliable Messages are simply absent and the Connection stays open
- [ ] A Server and several Clients run together in one process on the simulated network
