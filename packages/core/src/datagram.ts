import { CHALLENGE_SIZE } from "./challenge";
import type { CloseReason } from "./close-reason";

/**
 * Wire format. Every Datagram starts with the protocol version byte, then a
 * kind byte; the rest depends on the kind.
 *
 * Two rules hold across all versions, so that endpoints of different versions
 * refuse each other explicitly: the version byte comes first, and a Client's
 * Handshake Datagrams are exactly CLIENT_HANDSHAKE_SIZE bytes long.
 */

export const PROTOCOL_VERSION = 1;

/** No Datagram is larger, so that none is fragmented by IP on common paths. */
export const MAX_DATAGRAM_SIZE = 1200;

/**
 * The size of every Handshake Datagram a Client sends. Padding them to the
 * largest size lets the Server answer an address it has not proven yet
 * without ever sending more bytes than it received.
 */
export const CLIENT_HANDSHAKE_SIZE = MAX_DATAGRAM_SIZE;

const HEADER_SIZE = 2;

const KIND_CONNECT_REQUEST = 1;
const KIND_CHALLENGE = 2;
const KIND_CHALLENGE_RESPONSE = 3;
const KIND_ACCEPTED = 4;
const KIND_REFUSED = 5;

/** The reasons a Server can refuse a Client for, before any Connection exists. */
type RefusalReason = Extract<CloseReason, { kind: "versionMismatch" }>;

export type Datagram =
  | { readonly kind: "connectRequest" }
  | { readonly kind: "challenge"; readonly challenge: Uint8Array }
  | { readonly kind: "challengeResponse"; readonly challenge: Uint8Array }
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly reason: RefusalReason };

/** A Datagram from an endpoint of another protocol version, whose format is unknown. */
export type OtherVersion = { readonly kind: "otherVersion" };

export function encodeDatagram(datagram: Datagram): Uint8Array {
  switch (datagram.kind) {
    case "connectRequest":
      return withHeader(KIND_CONNECT_REQUEST, CLIENT_HANDSHAKE_SIZE);
    case "challenge":
      return withHeader(
        KIND_CHALLENGE,
        HEADER_SIZE + CHALLENGE_SIZE,
        datagram.challenge,
      );
    case "challengeResponse":
      return withHeader(
        KIND_CHALLENGE_RESPONSE,
        CLIENT_HANDSHAKE_SIZE,
        datagram.challenge,
      );
    case "accepted":
      return withHeader(KIND_ACCEPTED, HEADER_SIZE);
    case "refused":
      return withHeader(
        KIND_REFUSED,
        HEADER_SIZE + 1,
        Uint8Array.of(refusalCode(datagram.reason)),
      );
  }
}

function refusalCode(reason: RefusalReason): number {
  switch (reason.kind) {
    case "versionMismatch":
      return 1;
  }
}

/** Returns undefined for anything that is not a well-formed Datagram. */
export function decodeDatagram(
  data: Uint8Array,
): Datagram | OtherVersion | undefined {
  if (data.byteLength === 0 || data.byteLength > MAX_DATAGRAM_SIZE)
    return undefined;
  if (data[0] !== PROTOCOL_VERSION) return { kind: "otherVersion" };
  switch (data[1]) {
    case KIND_CONNECT_REQUEST:
      return data.byteLength === CLIENT_HANDSHAKE_SIZE
        ? { kind: "connectRequest" }
        : undefined;
    case KIND_CHALLENGE:
      return data.byteLength === HEADER_SIZE + CHALLENGE_SIZE
        ? { kind: "challenge", challenge: data.slice(HEADER_SIZE) }
        : undefined;
    case KIND_CHALLENGE_RESPONSE:
      return data.byteLength === CLIENT_HANDSHAKE_SIZE
        ? {
            kind: "challengeResponse",
            challenge: data.slice(HEADER_SIZE, HEADER_SIZE + CHALLENGE_SIZE),
          }
        : undefined;
    case KIND_ACCEPTED:
      return data.byteLength === HEADER_SIZE ? { kind: "accepted" } : undefined;
  }
  return undefined;
}

/** A zero-filled Datagram of `size` bytes with its header written and `body` right after it. */
function withHeader(kind: number, size: number, body?: Uint8Array): Uint8Array {
  const data = new Uint8Array(size);
  data[0] = PROTOCOL_VERSION;
  data[1] = kind;
  if (body) data.set(body, HEADER_SIZE);
  return data;
}
