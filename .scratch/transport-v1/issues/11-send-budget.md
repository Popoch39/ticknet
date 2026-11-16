# 11: Send budget

**What to build:** A game developer gives each Connection a Send budget, a fixed number of bytes it may emit per Tick, so that one busy Tick cannot flood a player's link. When the budget is spent, Reliable Messages wait for the next Tick, and Unreliable or Sequenced Messages are refused at send time so the developer can decide what to skip. There is no adaptive congestion control. See the spec, user stories 34 to 36, and "Core modules" (Send budget).

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] The Send budget is configurable on the Server per Connection and on the Client, with a sensible default
- [ ] In no Tick does a Connection put more bytes on the network than its Send budget, counting resends and acknowledgements
- [ ] Reliable Messages that do not fit the remaining budget are sent in later Ticks, still exactly once and in order
- [ ] Sending an Unreliable or Sequenced Message when the budget for the current Tick is spent tells the caller it was refused, without throwing
- [ ] The budget is restored at each Tick; an unused budget does not accumulate
- [ ] Keepalive and acknowledgement traffic still gets through when the game fills the budget every Tick, so a saturated Connection does not time out
- [ ] A budget too small to ever carry a full Datagram is rejected when the Server or Client is created
- [ ] Tests go through the public API on the simulated network
