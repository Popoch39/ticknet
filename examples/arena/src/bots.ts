// Bots that join the arena and wander on their own:
// `bun examples/arena/src/bots.ts --count 20 --port 4000`.
import { parseArgs } from "node:util";
import { connect, type ClientOptions } from "@ticknet/client";
import {
  connectOptions,
  describeLink,
  integer,
  linkOptions,
  linkSettings,
} from "./link";
import { describeClose, encodeName } from "./protocol";
import { ArenaView } from "./view";

/** How often a bot takes a step. */
const STEP_INTERVAL = 150;
/** Chances, on each step, that a bot turns, lets off a blast, or says something. */
const TURN_CHANCE = 0.2;
const BLAST_CHANCE = 0.02;
const SAY_CHANCE = 0.002;
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

export interface Bot {
  readonly name: string;
  readonly view: ArenaView;
  /** Quits the arena, telling the Server. */
  stop(): void;
}

export type BotOptions = Pick<ClientOptions, "host" | "port" | "wrapTransport">;

/** Connects one bot, which then wanders until it is stopped or its Connection closes. */
export async function startBot(
  name: string,
  options: BotOptions,
): Promise<Bot> {
  const client = await connect({ ...options, authToken: encodeName(name) });
  const view = new ArenaView(client);
  let direction = pick(DIRECTIONS);
  let said = 0;
  const wander = setInterval(() => {
    if (Math.random() < TURN_CHANCE) direction = pick(DIRECTIONS);
    view.move(direction[0], direction[1]);
    if (Math.random() < BLAST_CHANCE) view.blast();
    if (Math.random() < SAY_CHANCE) view.say(`beep boop #${++said}`);
  }, STEP_INTERVAL);
  client.on("connectionClosed", () => clearInterval(wander));
  return {
    name,
    view,
    stop() {
      clearInterval(wander);
      view.close();
    },
  };
}

/** Connects `count` bots named bot-1, bot-2 and so on, all at once. */
export function startBots(
  options: BotOptions & { readonly count: number },
): Promise<Bot[]> {
  return Promise.all(
    Array.from({ length: options.count }, (_, index) =>
      startBot(`bot-${index + 1}`, options),
    ),
  );
}

function pick<T>(choices: readonly T[]): T {
  const choice = choices[Math.floor(Math.random() * choices.length)];
  if (choice === undefined) throw new Error("Nothing to pick from");
  return choice;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { ...linkOptions, count: { type: "string", default: "5" } },
  });
  const settings = linkSettings(values);
  const count = integer("count", values.count);
  const bots = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const bot = await startBot(
        `bot-${index + 1}`,
        connectOptions(settings, index),
      );
      bot.view.client.on("connectionClosed", (reason) =>
        console.log(`${bot.name} disconnected (${describeClose(reason)})`),
      );
      return bot;
    }),
  );
  console.log(
    `${bots.length} bots connected to ${settings.host}:${settings.port} (${describeLink(settings)}). Ctrl-C to stop them.`,
  );
  // Once every bot has quit, nothing keeps the process alive: it exits after their close notices leave.
  const stop = () => {
    for (const bot of bots) bot.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
