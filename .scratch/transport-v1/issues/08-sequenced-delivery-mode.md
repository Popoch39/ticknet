# 08: Sequenced delivery mode

**What to build:** A game developer sends a Message as Sequenced, typically a position update, and a late one never overwrites a newer one: once a Sequenced Message of a given type has been delivered, any older Message of that type arriving afterwards is discarded. Sequenced Messages are never resent. See the spec, user stories 28 and 32, and "Core modules" (Delivery).

**Blocked by:** 04, 07

**Status:** ready-for-agent

- [ ] Sequenced is selectable as the Delivery mode of a send, in both directions
- [ ] With reordering enabled, the values delivered for one Message type are always in increasing send order; older ones arriving late are dropped
- [ ] Ordering is tracked per Message type: a late Sequenced Message of one type is not dropped because a newer Message of another type arrived
- [ ] With loss enabled, a lost Sequenced Message is never delivered later
- [ ] With duplication enabled, a Sequenced Message is delivered at most once
- [ ] Sending a Sequenced Message too large for one Datagram fails immediately with a clear error
- [ ] A long-running Connection keeps ordering correctly after its sequence counters wrap around
- [ ] These go through the public API on the simulated network with seeded conditions
- [ ] One integration test on real UDP loopback exchanges a Sequenced Message in each direction
