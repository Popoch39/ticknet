import {
  MAX_DATAGRAM_MESSAGE_SIZE,
  MAX_FRAGMENT_BODY_SIZE,
  MAX_RELIABLE_MESSAGE_SIZE,
  type FragmentPosition,
  type ReliableEntry,
} from "./datagram";

/** What one entry of the Reliable stream carries of a Message: all of it, or one Fragment's piece. */
export interface Piece {
  readonly body: Uint8Array;
  readonly fragment?: FragmentPosition;
}

/** Throws a RangeError for a Reliable Message body over MAX_RELIABLE_MESSAGE_SIZE. */
export function assertFitsReliableMessage(id: number, body: Uint8Array): void {
  if (body.byteLength > MAX_RELIABLE_MESSAGE_SIZE)
    throw new RangeError(
      `Message id ${id} is ${body.byteLength} bytes once encoded; a Reliable Message holds at most ${MAX_RELIABLE_MESSAGE_SIZE} bytes`,
    );
}

/**
 * Splits the body of a Reliable Message into the pieces its Fragments carry,
 * each but the last filling a Datagram, or leaves it whole when it fits in
 * one Datagram.
 */
export function piecesOf(body: Uint8Array): Piece[] {
  if (body.byteLength <= MAX_DATAGRAM_MESSAGE_SIZE) return [{ body }];
  const count = Math.ceil(body.byteLength / MAX_FRAGMENT_BODY_SIZE);
  return Array.from({ length: count }, (_, index) => ({
    body: body.subarray(
      index * MAX_FRAGMENT_BODY_SIZE,
      (index + 1) * MAX_FRAGMENT_BODY_SIZE,
    ),
    fragment: { index, count },
  }));
}

/**
 * Joins Fragments back into whole Reliable Messages. It takes the Reliable
 * stream in send order, where the Fragments of one Message follow each other
 * from the first to the last, so it only ever holds the pieces of one
 * Message.
 */
export class Reassembly {
  #pieces: Uint8Array[] = [];
  #id = 0;
  #count = 0;

  /** Takes in the next entry of the Reliable stream; returns the whole Message it completes, if any. */
  add(entry: ReliableEntry): ReliableEntry | undefined {
    const { fragment } = entry;
    if (!fragment) {
      this.#pieces = [];
      return entry;
    }
    if (fragment.index === 0) {
      this.#pieces = [entry.body];
      this.#id = entry.id;
      this.#count = fragment.count;
    } else if (
      fragment.index === this.#pieces.length &&
      fragment.count === this.#count &&
      entry.id === this.#id
    )
      this.#pieces.push(entry.body);
    else {
      // Out of place in the stream: no sender keeping to the protocol sent it.
      this.#pieces = [];
      return undefined;
    }
    if (this.#pieces.length < this.#count) return undefined;
    const body = new Uint8Array(
      this.#pieces.reduce((size, piece) => size + piece.byteLength, 0),
    );
    let offset = 0;
    for (const piece of this.#pieces) {
      body.set(piece, offset);
      offset += piece.byteLength;
    }
    this.#pieces = [];
    return {
      delivery: "reliable",
      id: entry.id,
      sequence: entry.sequence,
      body,
    };
  }
}
