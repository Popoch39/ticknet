// The terminal Client: `bun examples/arena/src/client.ts --name Ada`.
// Arrows or WASD move, space lets off a blast, Enter opens the chat line,
// q or Ctrl-C quits.
import { parseArgs } from "node:util";
import { ConnectError, connect } from "@ticknet/client";
import {
  connectOptions,
  describeLink,
  linkOptions,
  linkSettings,
} from "./link";
import {
  HEIGHT,
  MAX_SAY_LENGTH,
  WIDTH,
  describeClose,
  encodeName,
} from "./protocol";
import { ArenaView, EFFECT_DURATION, type Tally } from "./view";

const FRAME_INTERVAL = 50;
const MOVES: Record<string, readonly [number, number]> = {
  "\x1b[A": [0, -1],
  "\x1b[B": [0, 1],
  "\x1b[C": [1, 0],
  "\x1b[D": [-1, 0],
  w: [0, -1],
  s: [0, 1],
  d: [1, 0],
  a: [-1, 0],
};

const style = {
  self: (text: string) => `\x1b[1;33m${text}\x1b[0m`,
  other: (text: string) => `\x1b[1;36m${text}\x1b[0m`,
  effect: (text: string) => `\x1b[35m${text}\x1b[0m`,
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

const { values } = parseArgs({
  options: {
    ...linkOptions,
    name: { type: "string", default: Bun.env.USER ?? "player" },
  },
});
const settings = linkSettings(values);

let view: ArenaView;
try {
  view = new ArenaView(
    await connect({
      ...connectOptions(settings),
      authToken: encodeName(values.name),
    }),
  );
} catch (error) {
  if (!(error instanceof ConnectError)) throw error;
  const { reason } = error;
  console.error(
    `Could not join the arena at ${settings.host}:${settings.port}: ${
      reason.kind === "hostNotFound"
        ? `no address found for ${reason.host}`
        : describeClose(reason)
    }`,
  );
  process.exit(1);
}

/** The chat line being typed, or undefined when the keys move the character. */
let typing: string | undefined;
const interactive = process.stdin.isTTY && process.stdout.isTTY;

if (interactive) {
  // Alternate screen, cursor hidden; both restored when the Client ends.
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.on("data", (data: Buffer) => {
    for (const key of data.toString().match(/\x1b\[[A-D]|[\s\S]/g) ?? [])
      press(key);
  });
}
process.on("SIGINT", () => view.close());
process.on("SIGTERM", () => view.close());

const frames = setInterval(
  () => process.stdout.write(render()),
  FRAME_INTERVAL,
);

view.client.on("connectionClosed", (reason) => {
  clearInterval(frames);
  if (interactive) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  console.log(
    reason.kind === "closedByClient"
      ? "You left the arena."
      : `Disconnected: ${describeClose(reason)}.`,
  );
  // Nothing should keep the process alive by now; this only guards against it.
  setTimeout(() => process.exit(0), 2000).unref();
});

function press(key: string): void {
  if (key === "\x03") return view.close();
  if (typing !== undefined) {
    if (key === "\r") {
      view.say(typing);
      typing = undefined;
    } else if (key === "\x1b") typing = undefined;
    else if (key === "\x7f" || key === "\b") typing = typing.slice(0, -1);
    else if (key >= " " && typing.length < MAX_SAY_LENGTH) typing += key;
    return;
  }
  const move = MOVES[key];
  if (move) view.move(move[0], move[1]);
  else if (key === " ") view.blast();
  else if (key === "\r" || key === "t") typing = "";
  else if (key === "q") view.close();
}

function render(): string {
  const now = performance.now();
  const cells: string[][] = Array.from({ length: HEIGHT }, () =>
    Array.from({ length: WIDTH }, () => "."),
  );
  const put = (x: number, y: number, text: string) => {
    const row = cells[y];
    if (row && x >= 0 && x < WIDTH) row[x] = text;
  };
  // Each blast is a ring that grows for as long as it stays on screen.
  for (const { x, y, at } of view.liveEffects(now)) {
    const radius = 1 + Math.floor(((now - at) / EFFECT_DURATION) * 3);
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          put(x + dx, y + dy, style.effect("*"));
  }
  const { self } = view;
  for (const character of view.characters.values())
    if (character.id !== self?.id)
      put(character.x, character.y, style.other(character.glyph));
  // Your own character is drawn where you moved it, not where the Server last saw it.
  if (self) put(self.x, self.y, style.self(self.glyph));

  const { roundTripTime, lossRate } = view.client;
  const lines = [
    `ticknet arena  ${style.self(values.name)}  ${view.characters.size} in the arena  ` +
      `rtt ${roundTripTime === undefined ? "-" : `${Math.round(roundTripTime)} ms`}  ` +
      `loss ${lossRate === undefined ? "-" : `${Math.round(lossRate * 100)}%`}  ` +
      style.dim(describeLink(settings)),
    `+${"-".repeat(WIDTH)}+`,
    // Empty cells are dim; each styled cell resets the style, so dimming resumes after it.
    ...cells.map(
      (row) =>
        `|\x1b[2m${row.map((cell) => (cell === "." ? cell : `${cell}\x1b[2m`)).join("")}\x1b[0m|`,
    ),
    `+${"-".repeat(WIDTH)}+`,
    tally(
      "Sequenced ",
      "positions",
      view.snapshots,
      "snapshots",
      "skipped",
      "others jump",
    ),
    tally(
      "Unreliable",
      "blasts   ",
      view.blasts,
      "seen",
      "lost",
      "lost ones never show",
    ),
    tally(
      "Reliable  ",
      "chat     ",
      view.lines,
      "lines",
      "lost",
      "late, never lost",
    ),
    ...Array.from({ length: 6 }, (_, index) => view.chat[index] ?? ""),
    typing === undefined
      ? style.dim("arrows/WASD move  space blast  enter chat  q quit")
      : `say> ${typing}_`,
  ];
  return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`;
}

function tally(
  mode: string,
  what: string,
  counts: Tally,
  received: string,
  missing: string,
  hint: string,
): string {
  const total = counts.received + counts.missing;
  const share = total === 0 ? 0 : Math.round((counts.missing / total) * 100);
  return `${mode} ${what} ${String(counts.received).padStart(6)} ${received}, ${counts.missing} ${missing} (${share}%)  ${style.dim(hint)}`;
}
