# Terminal arena

A small arena played in terminals over real UDP: one Server, any number of Clients each moving a character, and any number of bots. It is built only on the public API of `@ticknet/server`, `@ticknet/client` and `@ticknet/core` (and `@ticknet/core/testing` for the network conditions), with no other dependency.

## Run it

From the repository root, after `bun install`, in three terminals:

```sh
bun examples/arena/src/server.ts                  # the Server, on UDP port 4000
bun examples/arena/src/bots.ts --count 20         # 20 bots that wander on their own
bun examples/arena/src/client.ts --name Ada       # you
```

Start as many Clients as you like, each in its own terminal. In the Client, the arrow keys or WASD move your character (yellow), space lets off a blast, Enter opens the chat line (Enter sends, Esc cancels), and `q` or Ctrl-C quits. Ctrl-C stops the Server and the bots.

Every command takes `--port` (4000 by default); the Client and the bots take `--host` (127.0.0.1 by default). The Server also takes `--host`, `--timeout` (milliseconds of silence before a Client is dropped, 5000 by default) and `--max-connections` (100 by default, 200 at most).

## Which Delivery mode for what

| What                                                                  | Delivery mode | Why                                                                       |
| --------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------- |
| Positions (each Client's own, the Server's world snapshot every Tick) | Sequenced     | Only the newest matters, and a late one must never move a character back. |
| Blasts (a one-off effect)                                             | Unreliable    | A lost flash is not worth sending again.                                  |
| Chat lines, joins and leaves, the greeting                            | Reliable      | Every line must arrive, once and in order.                                |

A Client that quits disappears from the other terminals at once. A Client that is killed disappears once the Server's timeout has passed.

## Play over a bad link

The Client and the bots take `--loss` (the share of Datagrams lost, from 0 to 1), `--latency` and `--jitter` (milliseconds), all applied to each direction of their own link through `withNetworkConditions` from `@ticknet/core/testing`, plus `--seed` to replay the same run (random by default, and shown).

```sh
bun examples/arena/src/client.ts --name Ada --loss 0.2 --latency 80 --jitter 20
```

The Client's top line shows its round-trip time and loss rate. Below the arena, one line per Delivery mode counts what arrived and what did not:

- **Sequenced** positions: snapshots skipped, lost or arriving after a newer one. The other characters move in jumps; nobody ever moves back.
- **Unreliable** blasts: those that never arrived and never will.
- **Reliable** chat: always 0 lost; lines arrive late, never out of order.

## Check

`bun test examples` starts the Server and a few bots in one process over loopback and checks that they connect and see each other. The interactive Client is not tested otherwise.
