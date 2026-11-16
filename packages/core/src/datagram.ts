import { CHALLENGE_SIZE } from "./challenge";
import type { CloseReason } from "./close-reason";
import type { DeliveryMode } from "./message";

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

/** The Auth token's length, before the token itself in a challenge response. */
const AUTH_TOKEN_LENGTH_SIZE = 2;

/** The largest Auth token that fits in a challenge response, after the challenge. */
export const MAX_AUTH_TOKEN_SIZE =
  CLIENT_HANDSHAKE_SIZE - HEADER_SIZE - CHALLENGE_SIZE - AUTH_TOKEN_LENGTH_SIZE;

const KIND_CONNECT_REQUEST = 1;
const KIND_CHALLENGE = 2;
const KIND_CHALLENGE_RESPONSE = 3;
const KIND_ACCEPTED = 4;
const KIND_REFUSED = 5;
const KIND_CONNECTED = 6;
const KIND_CLOSE = 7;

/**
 * A connected Datagram, sent either way on an open Connection: after the
 * common header, the sender's Tick number (32 bits), then Message entries up
 * to the end. Acknowledgement data is meant to join this header. One with no
 * entry at all is a keepalive.
 */
const CONNECTED_HEADER_SIZE = HEADER_SIZE + 4;

/**
 * Each Message entry is a type byte, the Message id (16 bits), the body length
 * (16 bits), then the body. The type byte leaves room for Sequenced, Reliable
 * and Fragment entries with headers of their own.
 */
const ENTRY_UNRELIABLE = 1;
const ENTRY_HEADER_SIZE = 5;

/** The largest Message body that fits in one Datagram. */
export const MAX_DATAGRAM_MESSAGE_SIZE =
  MAX_DATAGRAM_SIZE - CONNECTED_HEADER_SIZE - ENTRY_HEADER_SIZE;

/** The reasons a Server can refuse a Client for, before any Connection exists. */
type RefusalReason = Extract<
  CloseReason,
  { kind: "versionMismatch" | "denied" | "serverFull" }
>;

const REFUSED_VERSION_MISMATCH = 1;
const REFUSED_DENIED = 2;
const REFUSED_SERVER_FULL = 3;

/** A refusal is its reason byte, followed by the game's 16-bit code for a denial. */
const REFUSED_SIZE = HEADER_SIZE + 1;
const REFUSED_DENIED_SIZE = REFUSED_SIZE + 2;

/** The reasons one side of an open Connection can tell the other it closed it for. */
type CloseNoticeReason = Extract<
  CloseReason,
  { kind: "closedByClient" | "closedByServer" }
>;

const CLOSED_BY_CLIENT = 1;
const CLOSED_BY_SERVER = 2;

/** A close notice is its reason byte, followed by the game's 16-bit code when the Server closed. */
const CLOSED_BY_CLIENT_SIZE = HEADER_SIZE + 1;
const CLOSED_BY_SERVER_SIZE = CLOSED_BY_CLIENT_SIZE + 2;

export interface MessageEntry {
  readonly delivery: DeliveryMode;
  readonly id: number;
  readonly body: Uint8Array;
}

export type Datagram =
  | { readonly kind: "connectRequest" }
  | { readonly kind: "challenge"; readonly challenge: Uint8Array }
  | {
      readonly kind: "challengeResponse";
      readonly challenge: Uint8Array;
      readonly authToken: Uint8Array;
    }
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | {
      readonly kind: "connected";
      readonly tick: number;
      readonly messages: readonly MessageEntry[];
    }
  /** Tells the other side of an open Connection that it is over. */
  | { readonly kind: "close"; readonly reason: CloseNoticeReason };

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
    case "challengeResponse": {
      const { challenge, authToken } = datagram;
      const body = new Uint8Array(
        CHALLENGE_SIZE + AUTH_TOKEN_LENGTH_SIZE + authToken.byteLength,
      );
      body.set(challenge);
      new DataView(body.buffer).setUint16(CHALLENGE_SIZE, authToken.byteLength);
      body.set(authToken, CHALLENGE_SIZE + AUTH_TOKEN_LENGTH_SIZE);
      return withHeader(KIND_CHALLENGE_RESPONSE, CLIENT_HANDSHAKE_SIZE, body);
    }
    case "accepted":
      return withHeader(KIND_ACCEPTED, HEADER_SIZE);
    case "refused":
      return encodeRefused(datagram.reason);
    case "connected":
      return encodeConnected(datagram.tick, datagram.messages);
    case "close":
      return datagram.reason.kind === "closedByClient"
        ? withHeader(
            KIND_CLOSE,
            CLOSED_BY_CLIENT_SIZE,
            Uint8Array.of(CLOSED_BY_CLIENT),
          )
        : withHeader(
            KIND_CLOSE,
            CLOSED_BY_SERVER_SIZE,
            Uint8Array.of(
              CLOSED_BY_SERVER,
              datagram.reason.code >>> 8,
              datagram.reason.code & 0xff,
            ),
          );
  }
}

function decodeClose(data: Uint8Array): Datagram | undefined {
  const reason = data[HEADER_SIZE];
  if (data.byteLength === CLOSED_BY_CLIENT_SIZE && reason === CLOSED_BY_CLIENT)
    return { kind: "close", reason: { kind: "closedByClient" } };
  if (
    data.byteLength === CLOSED_BY_SERVER_SIZE &&
    reason === CLOSED_BY_SERVER
  ) {
    const code =
      ((data[HEADER_SIZE + 1] ?? 0) << 8) | (data[HEADER_SIZE + 2] ?? 0);
    return { kind: "close", reason: { kind: "closedByServer", code } };
  }
  return undefined;
}

function encodeRefused(reason: RefusalReason): Uint8Array {
  switch (reason.kind) {
    case "versionMismatch":
      return withHeader(
        KIND_REFUSED,
        REFUSED_SIZE,
        Uint8Array.of(REFUSED_VERSION_MISMATCH),
      );
    case "serverFull":
      return withHeader(
        KIND_REFUSED,
        REFUSED_SIZE,
        Uint8Array.of(REFUSED_SERVER_FULL),
      );
    case "denied":
      return withHeader(
        KIND_REFUSED,
        REFUSED_DENIED_SIZE,
        Uint8Array.of(REFUSED_DENIED, reason.code >>> 8, reason.code & 0xff),
      );
  }
}

function decodeRefused(data: Uint8Array): Datagram | undefined {
  const refusal = data[HEADER_SIZE];
  if (data.byteLength === REFUSED_SIZE) {
    if (refusal === REFUSED_VERSION_MISMATCH)
      return { kind: "refused", reason: { kind: "versionMismatch" } };
    if (refusal === REFUSED_SERVER_FULL)
      return { kind: "refused", reason: { kind: "serverFull" } };
  }
  if (data.byteLength === REFUSED_DENIED_SIZE && refusal === REFUSED_DENIED) {
    const code =
      ((data[HEADER_SIZE + 1] ?? 0) << 8) | (data[HEADER_SIZE + 2] ?? 0);
    return { kind: "refused", reason: { kind: "denied", code } };
  }
  return undefined;
}

/** The bytes `message` takes in a connected Datagram. */
function entrySize(message: MessageEntry): number {
  return ENTRY_HEADER_SIZE + message.body.byteLength;
}

/**
 * Splits Messages, in order, into the groups that each fit in one connected
 * Datagram, filling each group before starting the next. Every body must be
 * at most MAX_DATAGRAM_MESSAGE_SIZE bytes.
 */
export function packMessages(
  messages: readonly MessageEntry[],
): MessageEntry[][] {
  const groups: MessageEntry[][] = [];
  let group: MessageEntry[] = [];
  let size = CONNECTED_HEADER_SIZE;
  for (const message of messages) {
    if (size + entrySize(message) > MAX_DATAGRAM_SIZE) {
      groups.push(group);
      group = [];
      size = CONNECTED_HEADER_SIZE;
    }
    group.push(message);
    size += entrySize(message);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function encodeConnected(
  tick: number,
  messages: readonly MessageEntry[],
): Uint8Array {
  const size = messages.reduce(
    (total, message) => total + entrySize(message),
    CONNECTED_HEADER_SIZE,
  );
  const data = withHeader(KIND_CONNECTED, size);
  const view = new DataView(data.buffer);
  view.setUint32(HEADER_SIZE, tick);
  let offset = CONNECTED_HEADER_SIZE;
  for (const message of messages) {
    view.setUint8(offset, ENTRY_UNRELIABLE);
    view.setUint16(offset + 1, message.id);
    view.setUint16(offset + 3, message.body.byteLength);
    data.set(message.body, offset + ENTRY_HEADER_SIZE);
    offset += entrySize(message);
  }
  return data;
}

function decodeConnected(data: Uint8Array): Datagram | undefined {
  if (data.byteLength < CONNECTED_HEADER_SIZE) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const messages: MessageEntry[] = [];
  let offset = CONNECTED_HEADER_SIZE;
  while (offset < data.byteLength) {
    if (offset + ENTRY_HEADER_SIZE > data.byteLength) return undefined;
    if (view.getUint8(offset) !== ENTRY_UNRELIABLE) return undefined;
    const bodyStart = offset + ENTRY_HEADER_SIZE;
    const bodyEnd = bodyStart + view.getUint16(offset + 3);
    if (bodyEnd > data.byteLength) return undefined;
    messages.push({
      delivery: "unreliable",
      id: view.getUint16(offset + 1),
      body: data.slice(bodyStart, bodyEnd),
    });
    offset = bodyEnd;
  }
  return { kind: "connected", tick: view.getUint32(HEADER_SIZE), messages };
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
        ? decodeChallengeResponse(data)
        : undefined;
    case KIND_ACCEPTED:
      return data.byteLength === HEADER_SIZE ? { kind: "accepted" } : undefined;
    case KIND_REFUSED:
      return decodeRefused(data);
    case KIND_CONNECTED:
      return decodeConnected(data);
    case KIND_CLOSE:
      return decodeClose(data);
  }
  return undefined;
}

function decodeChallengeResponse(data: Uint8Array): Datagram | undefined {
  const tokenStart = HEADER_SIZE + CHALLENGE_SIZE + AUTH_TOKEN_LENGTH_SIZE;
  const tokenSize = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint16(HEADER_SIZE + CHALLENGE_SIZE);
  if (tokenSize > MAX_AUTH_TOKEN_SIZE) return undefined;
  return {
    kind: "challengeResponse",
    challenge: data.slice(HEADER_SIZE, HEADER_SIZE + CHALLENGE_SIZE),
    authToken: data.slice(tokenStart, tokenStart + tokenSize),
  };
}

/** A zero-filled Datagram of `size` bytes with its header written and `body` right after it. */
function withHeader(kind: number, size: number, body?: Uint8Array): Uint8Array {
  const data = new Uint8Array(size);
  data[0] = PROTOCOL_VERSION;
  data[1] = kind;
  if (body) data.set(body, HEADER_SIZE);
  return data;
}
