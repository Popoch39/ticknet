import type { Clock } from "./clock";
import type { Address, OutgoingDatagram, Transport } from "./transport";

/**
 * A protocol engine, one per role. It performs no I/O and never reads the
 * time: received Datagrams and the current time are handed to it, and it
 * queues Datagrams to send and events for the caller to collect.
 */
export interface Engine<Event> {
  receive(data: Uint8Array, from: Address, now: number): void;
  /** Lets the engine act on the passage of time, up to `now`. */
  advance(now: number): void;
  /** The time at which `advance` next has something to do, if any. */
  nextDeadline(): number | undefined;
  pollDatagrams(): OutgoingDatagram[];
  pollEvents(): Event[];
}

/**
 * Binds an engine to a Transport and a Clock: feeds it what the Transport
 * receives and wakes it at its deadlines, then sends what it queued and hands
 * its events to `onEvent`.
 */
export class EngineDriver<Event> {
  readonly #engine: Engine<Event>;
  readonly #transport: Transport;
  readonly #clock: Clock;
  readonly #onEvent: (event: Event) => void;
  #wakeAt: number | undefined;
  #cancelWake: (() => void) | undefined;
  #pumping = false;

  constructor(
    engine: Engine<Event>,
    transport: Transport,
    clock: Clock,
    onEvent: (event: Event) => void,
  ) {
    this.#engine = engine;
    this.#transport = transport;
    this.#clock = clock;
    this.#onEvent = onEvent;
    transport.listen({
      datagram: (data, from) => {
        engine.receive(data, from, clock.now());
        this.#pump();
      },
    });
    this.#pump();
  }

  /**
   * Runs `action`, which calls into the engine from outside a received
   * Datagram or a deadline (an answer that arrived asynchronously, say), then
   * sends what it queued and hands out its events.
   */
  perform(action: () => void): void {
    action();
    // From inside an event handler, the pump already running picks the output up.
    if (!this.#pumping) this.#pump();
  }

  #pump(): void {
    this.#pumping = true;
    try {
      // Handling an event may queue more output, so drain until both queues are empty.
      for (;;) {
        const datagrams = this.#engine.pollDatagrams();
        if (datagrams.length > 0) this.#transport.send(datagrams);
        const events = this.#engine.pollEvents();
        for (const event of events) this.#onEvent(event);
        if (datagrams.length === 0 && events.length === 0) break;
      }
    } finally {
      this.#pumping = false;
    }
    this.#scheduleWake();
  }

  #scheduleWake(): void {
    const at = this.#engine.nextDeadline();
    if (at === this.#wakeAt) return;
    this.#cancelWake?.();
    this.#wakeAt = at;
    this.#cancelWake =
      at === undefined
        ? undefined
        : this.#clock.schedule(at, () => {
            this.#wakeAt = undefined;
            this.#cancelWake = undefined;
            this.#engine.advance(this.#clock.now());
            this.#pump();
          });
  }
}
