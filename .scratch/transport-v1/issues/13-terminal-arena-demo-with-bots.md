# 13: Terminal arena demo with bots

**What to build:** A prospective user runs a small arena in terminals and sees the library working within a minute: one Server process, any number of Client processes each moving a character, and any number of bots. The demo uses the three Delivery modes for what each is good at (positions as Sequenced, one-off effects as Unreliable, chat as Reliable) and can be started with simulated loss and latency to show how each degrades. It is built only on the public API of the server and client packages and the public testing entry point of core. See the spec, user stories 51 to 54, and "Demo".

**Blocked by:** 06, 08, 10

**Status:** ready-for-agent

- [ ] One command starts the arena Server; one command starts a Client that joins it over real UDP
- [ ] A player moves a character with the keyboard and sees the other characters move in their terminal
- [ ] Positions travel as Sequenced, a one-off effect as Unreliable, and chat lines as Reliable
- [ ] A player who quits disappears from the other terminals at once; a killed Client disappears after the timeout
- [ ] One command starts a chosen number of bots that connect and move on their own
- [ ] The Client shows its round-trip time and loss rate
- [ ] Options apply loss and latency to a Client's link through the network-condition wrapper, and the difference between the three Delivery modes is visible
- [ ] The demo imports only public entry points of the three packages and adds no runtime dependency
- [ ] A short how-to-run note sits with the demo
- [ ] An automated check starts the Server and a few bots and verifies they connect; the interactive part is not otherwise tested
