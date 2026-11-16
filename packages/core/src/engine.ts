import type { Clock } from "./clock";
import type { Address, OutgoingDatagram, Transport } from "./transport";

/**
 * A protocol engine, one per role. It performs no I/O and never reads the
 * time: received Datagrams and the current time are handed to it, and it
 * queues Datagrams to send and events for the caller to collect.
 *
 * The caller handles every event of one `pollEvents` call before calling
 * `pollDatagrams` again, so that an engine can hold Datagrams back until the
 * game has reacted to an event (the Server ends a Tick that way).
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
  #stopped = false;

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
    if (!this.#pumping && !this.#stopped) this.#pump();
  }

  /**
   * Stops waking the engine and closes the Transport, after sending and
   * handing out what the engine has already queued (close notices, say);
   * from inside an event handler, once the pump running is done. The engine
   * then receives and sends nothing more. Releasing the Transport and the
   * Clock this way lets the process exit.
   */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancelWake?.();
    this.#cancelWake = undefined;
    this.#wakeAt = undefined;
    if (!this.#pumping) this.#transport.close();
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
    // An event handler may have stopped the driver.
    if (this.#stopped) this.#transport.close();
    else this.#scheduleWake();
  }

  #scheduleWake(): void {
    if (this.#stopped) return;
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
