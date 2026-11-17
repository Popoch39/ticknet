// What a Client knows of the arena, built from the Messages it receives, and
// how it moves its own character. Shared by the terminal Client and the bots;
// it does no terminal I/O.
import type { Client } from "@ticknet/client";
import {
  clamp,
  messages,
  type Character,
  type Effect,
  type Position,
} from "./protocol";

/** How often the own position is sent again, so that a lost one is soon replaced. */
const POSITION_INTERVAL = 100;
/** How long an effect stays on screen, in milliseconds. */
export const EFFECT_DURATION = 600;
const CHAT_HISTORY = 6;

/**
 * Counts what each Delivery mode delivered and what never arrived, from the
 * serial numbers the Server puts in its Messages.
 */
export class Tally {
  received = 0;
  missing = 0;
  #newest: number | undefined;

  /** Notes the arrival of the Message numbered `serial`. */
  note(serial: number): void {
    this.received++;
    if (this.#newest === undefined) {
      this.#newest = serial;
    } else if (serial > this.#newest) {
      this.missing += serial - this.#newest - 1;
      this.#newest = serial;
    } else {
      // An Unreliable Message that arrives late was counted as missing when it was overtaken.
      this.missing = Math.max(0, this.missing - 1);
    }
  }
}

export class ArenaView {
  readonly client: Client;
  /** Your own character, once the Server has said which one it is. */
  self: Character | undefined;
  /** Everyone, yourself included, as of the newest snapshot. */
  readonly characters = new Map<number, Character>();
  readonly effects: (Effect & { readonly at: number })[] = [];
  readonly chat: string[] = [];
  /** World snapshots: one per Server Tick, so a skipped Tick is a lost or stale snapshot. */
  readonly snapshots = new Tally();
  readonly blasts = new Tally();
  readonly lines = new Tally();
  readonly #changed = new Set<() => void>();
  readonly #resend: ReturnType<typeof setInterval>;

  constructor(client: Client) {
    this.client = client;
    client.onMessage(messages.welcome, (character) => {
      this.self = character;
      this.#sendPosition();
      this.#change();
    });
    client.onMessage(messages.world, ({ tick, characters }) => {
      this.snapshots.note(tick);
      this.characters.clear();
      for (const character of characters)
        this.characters.set(character.id, character);
      this.#change();
    });
    client.onMessage(messages.effect, (effect) => {
      this.blasts.note(effect.serial);
      this.effects.push({ ...effect, at: performance.now() });
      this.#change();
    });
    client.onMessage(messages.chat, ({ serial, text }) => {
      this.lines.note(serial);
      this.chat.push(text);
      if (this.chat.length > CHAT_HISTORY) this.chat.shift();
      this.#change();
    });
    this.#resend = setInterval(() => this.#sendPosition(), POSITION_INTERVAL);
    client.on("connectionClosed", () => clearInterval(this.#resend));
  }

  /** Moves your character by one step, at once on your screen. */
  move(dx: number, dy: number): void {
    if (!this.self) return;
    this.self = {
      ...this.self,
      ...clamp({ x: this.self.x + dx, y: this.self.y + dy }),
    };
    this.#sendPosition();
    this.#change();
  }

  blast(): void {
    if (this.self) this.client.send(messages.blast, undefined, "unreliable");
  }

  say(line: string): void {
    if (line.trim()) this.client.send(messages.say, line, "reliable");
  }

  /** Effects still on screen, oldest first; older ones are forgotten. */
  liveEffects(now: number): readonly (Effect & { readonly at: number })[] {
    while (this.effects[0] && now - this.effects[0].at > EFFECT_DURATION)
      this.effects.shift();
    return this.effects;
  }

  /** Resolves once `predicate` holds, checked now and after every change. */
  until(predicate: (view: ArenaView) => boolean): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!predicate(this)) return;
        this.#changed.delete(check);
        resolve();
      };
      this.#changed.add(check);
      check();
    });
  }

  /** Leaves the arena, telling the Server. */
  close(): void {
    clearInterval(this.#resend);
    this.client.close();
  }

  #sendPosition(): void {
    if (!this.self) return;
    const position: Position = { x: this.self.x, y: this.self.y };
    this.client.send(messages.position, position, "sequenced");
  }

  #change(): void {
    for (const listener of [...this.#changed]) listener();
  }
}
