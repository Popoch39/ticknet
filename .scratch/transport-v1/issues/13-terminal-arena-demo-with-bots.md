# 13: Terminal arena demo with bots

**What to build:** A prospective user runs a small arena in terminals and sees the library working within a minute: one Server process, any number of Client processes each moving a character, and any number of bots. The demo uses the three Delivery modes for what each is good at (positions as Sequenced, one-off effects as Unreliable, chat as Reliable) and can be started with simulated loss and latency to show how each degrades. It is built only on the public API of the server and client packages and the public testing entry point of core. See the spec, user stories 51 to 54, and "Demo".

**Blocked by:** 06, 08, 10

**Status:** resolved

- [x] One command starts the arena Server; one command starts a Client that joins it over real UDP
- [x] A player moves a character with the keyboard and sees the other characters move in their terminal
- [x] Positions travel as Sequenced, a one-off effect as Unreliable, and chat lines as Reliable
- [x] A player who quits disappears from the other terminals at once; a killed Client disappears after the timeout
- [x] One command starts a chosen number of bots that connect and move on their own
- [x] The Client shows its round-trip time and loss rate
- [x] Options apply loss and latency to a Client's link through the network-condition wrapper, and the difference between the three Delivery modes is visible
- [x] The demo imports only public entry points of the three packages and adds no runtime dependency
- [x] A short how-to-run note sits with the demo
- [x] An automated check starts the Server and a few bots and verifies they connect; the interactive part is not otherwise tested

## Comments

### Map (for later tickets)

- **Public API added: `ClientOptions.wrapTransport?: (transport, clock) => Transport`** (`packages/client/src/client.ts`). It wraps whichever Transport the Client uses (its UDP socket, or an injected one) and is given the Client's Clock (real by default), so `wrapTransport: (transport, clock) => withNetworkConditions(transport, { clock, send, receive })` puts conditions on a Client's real link. This closes ticket 07's gap without exporting `openUdpTransport` or `realClock`, which stay internal to the server and client packages. Tests: `packages/server/test/udp-conditions.test.ts` (real loopback: 100 ms each way shows in a Message's round trip) and `packages/server/test/network-conditions.test.ts` (injected Transport and manual Clock: the Handshake takes exactly two 100 ms round trips, which fails if the wrapper gets any other Clock, checked by mutation). The Server has no such option: the ticket only asks for a Client's link; adding the same option to `ServerOptions` would be symmetrical if wanted.
- **The demo is `examples/arena/`**, a private workspace package `@ticknet/arena` (`"private": true`, version 0.0.0), added to the root `workspaces` (`examples/*`) and to the root `tsconfig.json` references, so `bun check`, `bun test` and `bun fmt --check` cover it. It depends on the three packages through `workspace:*` and on nothing else (`node:util`'s `parseArgs` for flags).
  - `src/protocol.ts`: the shared Message definitions and their Delivery modes; `src/view.ts`: `ArenaView`, what a Client knows of the arena and how it moves, shared by the terminal Client and the bots (no terminal I/O); `src/link.ts`: the `--host --port --loss --latency --jitter --seed` flags and the `wrapTransport` they produce; `src/server.ts` (`startArena`), `src/bots.ts` (`startBot`, `startBots`), `src/client.ts` (the terminal Client), each runnable with `bun <file>`; `README.md`: how to run it.
  - Test: `examples/arena/test/arena.test.ts` starts the arena and three bots in one process over loopback, waits until every bot's view shows the three characters, then stops one and waits until the others show two.

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer sub-agent). Seam 1 (public Client API) for the new option; the demo's automated check goes through the demo's own `startArena` and `startBots`, as the ticket asks, rather than spawning the command-line processes.
- **Positions.** Each Client owns its character's position and sends it as Sequenced on every move and every 100 ms, so a lost one is soon replaced; the Server clamps it to the arena and broadcasts one `world` snapshot (every character's id, position and glyph) per Tick as Sequenced. The Client draws its own character where it moved it, the others from the newest snapshot. A Client that quits or times out is simply absent from the next snapshot, so it disappears within one Tick; a Reliable chat line also announces joins and leaves.
- **Making the difference visible.** The Server numbers its snapshots (the Tick), effects and chat lines; each Client counts gaps, and shows, per Delivery mode, what arrived and what never did (snapshots skipped, blasts lost, chat lines lost, always 0), next to its round-trip time and loss rate and the link settings. With `--loss 0.2 --latency 80 --jitter 20` a run showed rtt 180 ms, loss 18%, 18% of snapshots skipped, 14% of blasts lost and no chat line lost.
- **Conditions apply to each direction of a Client's (or bot's) own link**, with the same values both ways; the seed is random unless `--seed` is given, and shown on the Client's top line. Each bot gets seed + its index.
- **A close notice under latency.** `withNetworkConditions`'s `close()` drops everything still delayed (ticket 07), the close notice of a quitting Client included, so a Client quitting over a slow link was only noticed at the Server's timeout. The demo's `wrapTransport` delays the inner `close()` by `latency + jitter + 1` ms, which keeps "quit" instant on a slow link. The wrapper itself was left unchanged (core is being changed by tickets 11 and 12); letting in-flight Datagrams leave on `close()` would make this unnecessary for games too.
- **Defaults for the demo:** port 4000, arena 48 × 18 cells, Server `timeout` 5 s (so a killed Client vanishes quickly), `maxConnections` 100 and at most 200, so that every character's position fits in one Sequenced `world` Message (5 bytes each). The name a Client joins with travels as its Auth token (1 to 16 printable characters, otherwise denied with code 1) and its first character is the glyph; the authentication callback attaches the character to the Connection as `data`.
- **Run by hand** on loopback: a Server, 10 then 20 bots, and a Client under a pseudo-terminal (`script`) that moved, let off blasts, chatted and quit with `q`; the Server logged the quit as `quit` on a perfect and on a degraded link, and a Client killed with SIGKILL as `timed out` after 5 s. Without a terminal (stdin not a TTY) the Client still runs and renders, without keyboard input.

### Notes for later tickets

- Ticket 14: `examples/arena` is private and must stay out of `bun publish` (it is `"private": true`, so `bun publish -r` / `--filter` should skip it; worth checking in the dry run). Its `package.json` has `scripts` (`server`, `client`, `bots`) but none named `check`, `fmt`, `test` or `lint`. The demo imports `@ticknet/core`, `@ticknet/core/testing`, `@ticknet/client` and `@ticknet/server` by package name, so the switch of `exports` to built output must keep `@ticknet/core/testing` resolvable in the workspace (the demo runs from source with plain `bun`, no `--conditions` flag).
- `ClientOptions.wrapTransport` is part of the public types and needs no Bun type in its signature.
