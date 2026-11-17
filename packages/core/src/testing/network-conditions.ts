import type { Clock } from "../clock";

/** How a link mistreats the Datagrams crossing it. Every field is optional and defaults to a perfect link. */
export interface NetworkConditions {
  /** Share of Datagrams dropped, from 0 to 1. */
  readonly loss?: number;
  /** Milliseconds every Datagram takes to arrive. */
  readonly latency?: number;
  /** At most this many milliseconds added to each Datagram's latency, drawn uniformly. */
  readonly jitter?: number;
  /** Share of Datagrams that arrive twice, from 0 to 1; each copy has its own jitter. */
  readonly duplication?: number;
  /**
   * Share of Datagrams held back until the next Datagram on the same path
   * overtakes them, from 0 to 1. One that nothing overtakes within 100 ms of
   * its due time arrives then.
   */
  readonly reordering?: number;
}

/** Conditions on each direction of one endpoint's traffic, so that a test can make only one direction bad. */
export interface EndpointConditions {
  /** Conditions on the Datagrams the endpoint sends. */
  readonly send?: NetworkConditions;
  /** Conditions on the Datagrams the endpoint receives. */
  readonly receive?: NetworkConditions;
}

/**
 * A pseudo-random sequence fully determined by its seed (Mulberry32), so that
 * a run under the same conditions and the same seed replays identically.
 */
export class SeededRandom {
  #state: number;

  /** Any number; only its integer part modulo 2^32 matters. */
  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** The next number, from 0 included to 1 excluded. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  }
}

function rate(
  conditions: NetworkConditions,
  name: "loss" | "duplication" | "reordering",
): number {
  const value = conditions[name] ?? 0;
  if (!(value >= 0 && value <= 1))
    throw new RangeError(`The ${name} rate must be from 0 to 1, not ${value}`);
  return value;
}

function duration(
  conditions: NetworkConditions,
  name: "latency" | "jitter",
): number {
  const value = conditions[name] ?? 0;
  if (!(value >= 0 && Number.isFinite(value)))
    throw new RangeError(
      `The ${name} must be a finite number of milliseconds, at least 0, not ${value}`,
    );
  return value;
}

/**
 * How long past its due time a Datagram held back for reordering waits for
 * the next one on its path; then it arrives anyway, late but in order.
 */
const MAX_REORDER_HOLD = 100;

interface Held<Item> {
  readonly item: Item;
  /** When it was due before being held back. */
  readonly at: number;
  readonly cancel: () => void;
}

/**
 * One direction of a link with conditions: each Datagram passed in reaches
 * `arrive` later, on the Clock, as the conditions decide. `Item` is the
 * Datagram with whatever its receiver needs to know about it.
 */
export class ConditionedLink<Item extends { readonly data: Uint8Array }> {
  readonly #loss: number;
  readonly #latency: number;
  readonly #jitter: number;
  readonly #duplication: number;
  readonly #reordering: number;
  readonly #random: SeededRandom;
  readonly #clock: Clock;
  readonly #arrive: (item: Item) => void;
  /** At most one Datagram held back per path, waiting to be overtaken. */
  readonly #held = new Map<string, Held<Item>>();
  readonly #pending = new Set<() => void>();
  /** Called once nothing is on its way any more, after `drain`. */
  #drained: (() => void) | undefined;

  constructor(
    conditions: NetworkConditions,
    random: SeededRandom,
    clock: Clock,
    arrive: (item: Item) => void,
  ) {
    this.#loss = rate(conditions, "loss");
    this.#latency = duration(conditions, "latency");
    this.#jitter = duration(conditions, "jitter");
    this.#duplication = rate(conditions, "duplication");
    this.#reordering = rate(conditions, "reordering");
    this.#random = random;
    this.#clock = clock;
    this.#arrive = arrive;
  }

  /** `path` names the pair of endpoints the Datagram travels between: reordering happens within a path. */
  pass(path: string, item: Item): void {
    if (this.#random.next() < this.#loss) return;
    this.#travel(path, item);
    // A copy of its own, so that a receiver changing one copy cannot change the other.
    if (this.#random.next() < this.#duplication)
      this.#travel(path, { ...item, data: item.data.slice() });
  }

  /** Drops every Datagram still on its way. */
  stop(): void {
    for (const cancel of this.#pending) cancel();
    this.#pending.clear();
    this.#held.clear();
  }

  /** Calls `then` once every Datagram on its way has arrived; at once if none is. */
  drain(then: () => void): void {
    if (this.#pending.size === 0) then();
    else this.#drained = then;
  }

  #travel(path: string, item: Item): void {
    const at =
      this.#clock.now() + this.#latency + this.#random.next() * this.#jitter;
    const held = this.#held.get(path);
    if (held) {
      // Overtaken: the held Datagram now arrives right behind this one.
      held.cancel();
      this.#held.delete(path);
      this.#schedule(at, item);
      this.#schedule(Math.max(at, held.at), held.item);
    } else if (this.#random.next() < this.#reordering) {
      const cancel = this.#schedule(at + MAX_REORDER_HOLD, item, () =>
        this.#held.delete(path),
      );
      this.#held.set(path, { item, at, cancel });
    } else {
      this.#schedule(at, item);
    }
  }

  #schedule(at: number, item: Item, before?: () => void): () => void {
    const cancel = (): void => {
      this.#pending.delete(cancel);
      cancelTimer();
    };
    const cancelTimer = this.#clock.schedule(at, () => {
      this.#pending.delete(cancel);
      before?.();
      this.#arrive(item);
      if (this.#pending.size === 0) {
        const drained = this.#drained;
        this.#drained = undefined;
        drained?.();
      }
    });
    this.#pending.add(cancel);
    return cancel;
  }
}
