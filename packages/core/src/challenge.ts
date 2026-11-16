import { sipHash24 } from "./siphash";
import type { Address } from "./transport";

/** Four bytes for the time of issue, then an eight-byte tag. */
export const CHALLENGE_SIZE = 12;

/** Milliseconds a Client has to echo a challenge; this is also how long a captured echo can be replayed. */
const CHALLENGE_LIFETIME = 5_000;

/**
 * Issues the challenges the Server answers a connection request with, and
 * verifies their echoes. A challenge binds the Client's Address to the time of
 * issue under a secret key, so the Server can check an echo later without
 * having stored anything when it issued the challenge.
 */
export class Challenger {
  readonly #secret: Uint8Array;

  /** `secret` is 16 random bytes, known only to this Server. */
  constructor(secret: Uint8Array) {
    if (secret.byteLength !== 16)
      throw new RangeError("The challenge secret must be 16 bytes long");
    this.#secret = secret.slice();
  }

  issue(to: Address, now: number): Uint8Array {
    const challenge = new Uint8Array(CHALLENGE_SIZE);
    const issuedAt = millisecondsMod32(now);
    new DataView(challenge.buffer).setUint32(0, issuedAt);
    challenge.set(this.#tag(to, issuedAt), 4);
    return challenge;
  }

  /** Whether `challenge` was issued by this Server to `from`, and has not expired. */
  verify(challenge: Uint8Array, from: Address, now: number): boolean {
    if (challenge.byteLength !== CHALLENGE_SIZE) return false;
    const issuedAt = new DataView(
      challenge.buffer,
      challenge.byteOffset,
    ).getUint32(0);
    // Wrapping subtraction, so that the 32-bit time of issue may roll over.
    const age = (millisecondsMod32(now) - issuedAt) >>> 0;
    if (age > CHALLENGE_LIFETIME) return false;
    return equalInConstantTime(
      this.#tag(from, issuedAt),
      challenge.subarray(4),
    );
  }

  #tag(address: Address, issuedAt: number): Uint8Array {
    // The host comes last, as UTF-16 code units, so that the encoding is unambiguous.
    const input = new Uint8Array(6 + 2 * address.host.length);
    const view = new DataView(input.buffer);
    view.setUint32(0, issuedAt);
    view.setUint16(4, address.port);
    for (let index = 0; index < address.host.length; index++) {
      view.setUint16(6 + 2 * index, address.host.charCodeAt(index));
    }
    return sipHash24(this.#secret, input);
  }
}

/**
 * Whether two challenges are the same one. A Server issues an address a
 * different challenge every millisecond, so a different one from an address
 * means a new attempt to connect rather than a repeated echo.
 */
export function sameChallenge(a: Uint8Array, b: Uint8Array): boolean {
  return equalInConstantTime(a, b);
}

function millisecondsMod32(now: number): number {
  return Math.floor(now) >>> 0;
}

function equalInConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < a.byteLength; index++)
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}
