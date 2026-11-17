import {
  PackedSize,
  RELIABLE_SEQUENCE_MASK,
  type MessageEntry,
  type ReliableEntry,
} from "./datagram";
import { TRACKED_DATAGRAMS } from "./sent-datagrams";

/**
 * The most Reliable Messages one side of a Connection may have waiting for
 * acknowledgement, counted from the oldest one not acknowledged yet to the
 * newest one sent; one more closes the Connection with a
 * reliableBacklogOverflow reason, rather than letting a link that cannot
 * keep up eat memory.
 *
 * It is also how far ahead of the next Reliable Message it expects the
 * receiving side accepts one, so a sender never has one in flight that the
 * receiver would refuse. It is far below half the 16-bit sequence space, so
 * that sequence numbers are never confused across the wrap.
 */
export const MAX_RELIABLE_BACKLOG = 1024;

interface OutgoingReliable {
  readonly entry: ReliableEntry;
  /** When it is due to be sent again; -Infinity until it is first sent. */
  resendAt: number;
  acknowledged: boolean;
}

/**
 * The sending half of one side's Reliable stream: every Reliable Message it
 * sent on a Connection, numbered in send order across every Message type,
 * kept and sent again until a Datagram carrying it is acknowledged.
 */
export class ReliableSender {
  #nextSequence = 0;
  /** From the oldest Reliable Message not yet acknowledged to the newest, in send order. */
  #backlog: OutgoingReliable[] = [];
  /** The Reliable Messages each recent Datagram carried, by Datagram sequence number, oldest first. */
  readonly #carried = new Map<number, OutgoingReliable[]>();
  #waiting = new PackedSize();

  push(id: number, body: Uint8Array): void {
    const entry: ReliableEntry = {
      delivery: "reliable",
      id,
      sequence: this.#nextSequence,
      body,
    };
    this.#backlog.push({ entry, resendAt: -Infinity, acknowledged: false });
    this.#waiting.add(entry);
    this.#nextSequence = (this.#nextSequence + 1) & RELIABLE_SEQUENCE_MASK;
  }

  /** Whether more Reliable Messages wait for acknowledgement than MAX_RELIABLE_BACKLOG. */
  get overflowed(): boolean {
    return this.#backlog.length > MAX_RELIABLE_BACKLOG;
  }

  /**
   * The Reliable Messages to put in the Datagrams sent at `now`: those never
   * sent, and those still unacknowledged `resendDelay` milliseconds after
   * they were last sent, in send order, as many as packing them takes at most
   * `allowance` bytes; the others stay due for a later call. None beyond
   * MAX_RELIABLE_BACKLOG, which the other side would refuse.
   */
  take(now: number, resendDelay: number, allowance: number): ReliableEntry[] {
    const due: ReliableEntry[] = [];
    const size = new PackedSize();
    this.#waiting = new PackedSize();
    const end = Math.min(this.#backlog.length, MAX_RELIABLE_BACKLOG);
    for (let index = 0; index < end; index++) {
      const outgoing = this.#backlog[index];
      if (!outgoing || outgoing.acknowledged || outgoing.resendAt > now)
        continue;
      // Past the first one left out, the rest wait too, so that they go out in send order.
      if (this.#waiting.bytes > 0 || size.with(outgoing.entry) > allowance) {
        this.#waiting.add(outgoing.entry);
        continue;
      }
      size.add(outgoing.entry);
      outgoing.resendAt = now + resendDelay;
      due.push(outgoing.entry);
    }
    return due;
  }

  /**
   * The bytes the Reliable Messages already due take on the network: those
   * pushed since the last `take`, and those it left out. They are due at the
   * next `take` whenever it comes, so a sender can keep room for them.
   */
  get waiting(): number {
    return this.#waiting.bytes;
  }

  /** Remembers which Reliable Messages the Datagram numbered `sequence` carried. */
  sent(sequence: number, messages: readonly MessageEntry[]): void {
    const oldest = this.#backlog[0]?.entry.sequence ?? 0;
    const carried = messages.flatMap((message) =>
      message.delivery === "reliable"
        ? (this.#backlog[
            (message.sequence - oldest) & RELIABLE_SEQUENCE_MASK
          ] ?? [])
        : [],
    );
    if (carried.length === 0) return;
    this.#carried.set(sequence, carried);
    // An older Datagram can no longer be acknowledged; what it carried is sent again anyway.
    if (this.#carried.size > TRACKED_DATAGRAMS)
      for (const oldest of this.#carried.keys()) {
        this.#carried.delete(oldest);
        break;
      }
  }

  /** Takes in that the Datagram numbered `sequence` was received, with every Reliable Message it carried. */
  acknowledge(sequence: number): void {
    const carried = this.#carried.get(sequence);
    if (!carried) return;
    this.#carried.delete(sequence);
    for (const outgoing of carried) outgoing.acknowledged = true;
    let acknowledged = 0;
    while (this.#backlog[acknowledged]?.acknowledged) acknowledged++;
    if (acknowledged > 0) this.#backlog = this.#backlog.slice(acknowledged);
  }
}

/**
 * The receiving half of one side's Reliable stream: it hands out each
 * Reliable Message once, in the order the other side sent them, holding back
 * those that arrive ahead of one still missing.
 */
export class ReliableReceiver {
  /** The sequence number of the next Reliable Message to deliver. */
  #next = 0;
  readonly #held = new Map<number, ReliableEntry>();

  /** Takes in a received Reliable Message; returns those it lets through, in send order. */
  receive(entry: ReliableEntry): ReliableEntry[] {
    const ahead = (entry.sequence - this.#next) & RELIABLE_SEQUENCE_MASK;
    // Behind the next one, it is a copy of one delivered already; further ahead than a sender may have in
    // flight, no sender keeping to MAX_RELIABLE_BACKLOG sent it.
    if (ahead >= MAX_RELIABLE_BACKLOG || this.#held.has(entry.sequence))
      return [];
    if (ahead > 0) {
      this.#held.set(entry.sequence, entry);
      return [];
    }
    const ready = [entry];
    this.#next = (this.#next + 1) & RELIABLE_SEQUENCE_MASK;
    for (
      let held = this.#held.get(this.#next);
      held;
      held = this.#held.get(this.#next)
    ) {
      ready.push(held);
      this.#held.delete(this.#next);
      this.#next = (this.#next + 1) & RELIABLE_SEQUENCE_MASK;
    }
    return ready;
  }
}
