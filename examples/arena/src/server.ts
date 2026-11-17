// The arena Server: `bun examples/arena/src/server.ts --port 4000`.
import { parseArgs } from "node:util";
import { startServer } from "@ticknet/server";
import { integer } from "./link";
import {
  DENIED_NAME,
  HEIGHT,
  MAX_CHARACTERS,
  MAX_SAY_LENGTH,
  WIDTH,
  clamp,
  decodeName,
  describeClose,
  messages,
  type Position,
} from "./protocol";

export interface ArenaOptions {
  /** UDP port to listen on; 0 for one the system picks. */
  readonly port: number;
  /** Host name or IP address to listen on; every IPv4 interface by default. */
  readonly host?: string;
  /** Milliseconds of silence after which a Client is dropped. */
  readonly timeout?: number;
  readonly maxConnections?: number;
  /** Told about joins and leaves; nothing by default. */
  readonly log?: (line: string) => void;
}

export interface Arena {
  /** The UDP port the arena listens on. */
  readonly port: number;
  characterCount(): number;
  /** Tells every Client the arena closed, then releases the socket. */
  stop(): void;
}

/** What the Server knows of the character behind a Connection. */
interface Player {
  readonly id: number;
  readonly name: string;
  readonly glyph: string;
  position: Position;
}

export async function startArena(options: ArenaOptions): Promise<Arena> {
  const log = options.log ?? (() => {});
  const players = new Set<Player>();
  let nextId = 1;
  let effectSerial = 0;
  let chatSerial = 0;

  const server = await startServer({
    port: options.port,
    host: options.host,
    timeout: options.timeout ?? 5000,
    maxConnections: Math.min(options.maxConnections ?? 100, MAX_CHARACTERS),
    authenticate: ({ authToken }) => {
      const name = decodeName(authToken);
      if (name === undefined) return { accept: false, code: DENIED_NAME };
      const id = nextId;
      nextId = (nextId % 0xffff) + 1;
      const player: Player = {
        id,
        name,
        glyph: name[0] ?? "?",
        position: freeSpot(players),
      };
      return { accept: true, data: player };
    },
  });
  if (server.port === undefined) throw new Error("The arena has no UDP port");

  const announce = (text: string) =>
    server.broadcast(messages.chat, { serial: chatSerial++, text }, "reliable");

  server.on("connectionOpened", (connection) => {
    const player = connection.data;
    players.add(player);
    connection.send(
      messages.welcome,
      { id: player.id, glyph: player.glyph, ...player.position },
      "reliable",
    );
    announce(`* ${player.name} joined`);
    log(`${player.name} joined from ${connection.address.host}`);
  });

  server.on("connectionClosed", (connection, reason) => {
    const player = connection.data;
    players.delete(player);
    const why = describeClose(reason);
    announce(`* ${player.name} left (${why})`);
    log(`${player.name} left (${why})`);
  });

  server.onMessage(messages.position, (connection, position) => {
    connection.data.position = clamp(position);
  });

  server.onMessage(messages.blast, (connection) => {
    server.broadcast(
      messages.effect,
      { serial: effectSerial++, ...connection.data.position },
      "unreliable",
    );
  });

  server.onMessage(messages.say, (connection, line) => {
    const said = line.trim().slice(0, MAX_SAY_LENGTH);
    if (said) announce(`${connection.data.name}: ${said}`);
  });

  server.on("tick", (tick) => {
    const characters = [...players].map(({ id, glyph, position }) => ({
      id,
      glyph,
      ...position,
    }));
    server.broadcast(messages.world, { tick, characters }, "sequenced");
  });

  return {
    port: server.port,
    characterCount: () => players.size,
    stop: () => server.stop(),
  };
}

/** A random cell no character stands on, if there is one. */
function freeSpot(players: ReadonlySet<Player>): Position {
  const taken = new Set(
    [...players].map(({ position }) => position.y * WIDTH + position.x),
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const x = Math.floor(Math.random() * WIDTH);
    const y = Math.floor(Math.random() * HEIGHT);
    if (!taken.has(y * WIDTH + x)) return { x, y };
  }
  return { x: 0, y: 0 };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4000" },
      host: { type: "string", default: "0.0.0.0" },
      timeout: { type: "string", default: "5000" },
      "max-connections": { type: "string", default: "100" },
    },
  });
  const arena = await startArena({
    port: integer("port", values.port),
    host: values.host,
    timeout: integer("timeout", values.timeout),
    maxConnections: integer("max-connections", values["max-connections"]),
    log: (line) => console.log(line),
  });
  console.log(
    `Arena Server listening on UDP port ${arena.port}. Ctrl-C to stop.`,
  );
  process.on("SIGINT", () => {
    arena.stop();
    process.exit(0);
  });
}
