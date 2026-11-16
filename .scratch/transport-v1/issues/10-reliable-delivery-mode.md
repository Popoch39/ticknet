# 10: Reliable delivery mode

**What to build:** A game developer sends a Message as Reliable, such as chat or a score event, and it arrives exactly once and in the order it was sent, whatever the network does. Reliable Messages form a single ordered stream per Connection and are resent until acknowledged, after a delay derived from the measured round-trip time. A Connection whose Reliable backlog keeps growing is closed with a reason rather than eating memory. See the spec, user stories 29, 30, 33 and 40, and "Core modules" (Delivery).

**Blocked by:** 04, 09

**Status:** ready-for-agent

- [ ] Reliable is selectable as the Delivery mode of a send, in both directions
- [ ] Under seeded loss, reordering and duplication together, every Reliable Message sent is delivered exactly once and in send order
- [ ] Order holds across Message types: Reliable Messages of different types are delivered in the order they were sent
- [ ] A Reliable Message sent while the link drops everything is delivered once the link recovers, as long as the Connection has not timed out
- [ ] Unreliable and Sequenced Messages keep flowing while a Reliable Message is waiting to be resent
- [ ] Through the protocol engine: an unacknowledged Reliable Message is resent after a delay that follows the measured round-trip time, not on every Tick, and is no longer resent once acknowledged
- [ ] When the Reliable backlog of a Connection passes its limit, the Connection is closed on both sides with a backlog overflow reason
- [ ] A long-running Connection keeps delivering correctly after its sequence counters wrap around
- [ ] One integration test on real UDP loopback exchanges a Reliable Message in each direction
