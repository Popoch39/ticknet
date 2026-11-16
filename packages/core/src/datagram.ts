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

const KIND_CONNECT_REQUEST = 1;
const KIND_CHALLENGE = 2;
const KIND_CHALLENGE_RESPONSE = 3;
const KIND_ACCEPTED = 4;
const KIND_REFUSED = 5;
const KIND_CONNECTED = 6;

/**
 * A connected Datagram, sent either way on an open Connection: after the
 * common header, the sender's Tick number (32 bits), its sequence number
 * (32 bits), then Message entries up to the end. Acknowledgement data is
 * meant to join this header.
 */
const CONNECTED_HEADER_SIZE = HEADER_SIZE + 4 + 4;

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
type RefusalReason = Extract<CloseReason, { kind: "versionMismatch" }>;

export interface MessageEntry {
  readonly delivery: DeliveryMode;
  readonly id: number;
  readonly body: Uint8Array;
}

export type Datagram =
  | { readonly kind: "connectRequest" }
  | { readonly kind: "challenge"; readonly challenge: Uint8Array }
  | { readonly kind: "challengeResponse"; readonly challenge: Uint8Array }
  | { readonly kind: "accepted" }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | {
      readonly kind: "connected";
      readonly tick: number;
      /** Counts the connected Datagrams one side sent on one Connection, from 0, so that a copy is recognized. */
      readonly sequence: number;
      readonly messages: readonly MessageEntry[];
    };

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
    case "connected":
      return encodeConnected(datagram);
  }
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

function encodeConnected({
  tick,
  sequence,
  messages,
}: Extract<Datagram, { kind: "connected" }>): Uint8Array {
  const size = messages.reduce(
    (total, message) => total + entrySize(message),
    CONNECTED_HEADER_SIZE,
  );
  const data = withHeader(KIND_CONNECTED, size);
  const view = new DataView(data.buffer);
  view.setUint32(HEADER_SIZE, tick);
  view.setUint32(HEADER_SIZE + 4, sequence);
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
  return {
    kind: "connected",
    tick: view.getUint32(HEADER_SIZE),
    sequence: view.getUint32(HEADER_SIZE + 4),
    messages,
  };
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
    case KIND_CONNECTED:
      return decodeConnected(data);
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
