import { expect, test } from "bun:test";
import { startBots } from "../src/bots";
import { startArena } from "../src/server";

// Real sockets and real timers, as the demo runs: the test waits for what the
// bots see, never for a fixed delay.

test("bots started against the arena Server connect and see every character, and one that quits vanishes from the others", async () => {
  const arena = await startArena({ port: 0 });
  const bots = await startBots({
    host: "127.0.0.1",
    port: arena.port,
    count: 3,
  });

  await Promise.all(
    bots.map((bot) => bot.view.until((view) => view.characters.size === 3)),
  );
  expect(arena.characterCount()).toBe(3);

  const [leaving, ...staying] = bots;
  leaving?.stop();
  await Promise.all(
    staying.map((bot) => bot.view.until((view) => view.characters.size === 2)),
  );
  expect(arena.characterCount()).toBe(2);

  for (const bot of staying) bot.stop();
  arena.stop();
});
