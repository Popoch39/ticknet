# 12: Fragmentation of Reliable Messages

**What to build:** A game developer sends a Reliable Message larger than one Datagram, such as an initial world state, and it arrives whole. The library splits it into Fragments, each travelling reliably, and reassembles it on the other side before delivering it once, in its place in the Reliable stream. Unreliable and Sequenced Messages are never fragmented. See the spec, user stories 31 and 32, and "Core modules" (Fragmentation).

**Blocked by:** 10

**Status:** ready-for-agent

- [ ] A Reliable Message many times larger than a Datagram is delivered intact, in both directions
- [ ] Under seeded loss, reordering and duplication, a large Reliable Message is still delivered intact, exactly once
- [ ] A large Reliable Message keeps its place in the stream: Reliable Messages sent before and after it are delivered before and after it
- [ ] There is a documented maximum size for a Reliable Message, and sending beyond it fails immediately with a clear error
- [ ] No Datagram exceeds 1200 bytes while Fragments are in flight
- [ ] Sending an Unreliable or Sequenced Message too large for one Datagram still fails immediately; it is not fragmented
- [ ] Through the protocol engine: missing Fragments keep the Message undelivered, repeated Fragments are harmless, and Fragments claiming an impossible count or index are dropped without allocating for them
- [ ] A Connection that closes mid-reassembly releases the partial Message
