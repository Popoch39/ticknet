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

/**
 * A sender's timeout in whole milliseconds, which each side tells the other
 * during the Handshake (the Client in its challenge response, the Server in
 * its acceptance) so that each keeps the other's timeout from running out.
 */
const TIMEOUT_SIZE = 4;

/** The largest timeout the wire can tell; a longer one is sent as this. */
const MAX_TOLD_TIMEOUT = 0xffffffff;

/** The Auth token's length, before the token itself in a challenge response. */
const AUTH_TOKEN_LENGTH_SIZE = 2;

/** The largest Auth token that fits in a challenge response, after the challenge and the Client's timeout. */
export const MAX_AUTH_TOKEN_SIZE =
  CLIENT_HANDSHAKE_SIZE -
  HEADER_SIZE -
  CHALLENGE_SIZE -
  TIMEOUT_SIZE -
  AUTH_TOKEN_LENGTH_SIZE;

/** The acceptance is its header, followed by the Server's timeout. */
const ACCEPTED_SIZE = HEADER_SIZE + TIMEOUT_SIZE;

const KIND_CONNECT_REQUEST = 1;
const KIND_CHALLENGE = 2;
const KIND_CHALLENGE_RESPONSE = 3;
const KIND_ACCEPTED = 4;
const KIND_REFUSED = 5;
const KIND_CONNECTED = 6;
const KIND_CLOSE = 7;

/**
 * A connected Datagram, sent either way on an open Connection: after the
 * common header, the sender's Tick number (32 bits), its sequence number
 * (32 bits), its acknowledgement (newest sequence number received, 32 bits;
 * received mask, 32 bits; delay in milliseconds, 16 bits), then Message
 * entries up to the end. One with no entry at all is a keepalive or an
 * acknowledgement on its own.
 */
const CONNECTED_HEADER_SIZE = HEADER_SIZE + 4 + 4 + 4 + 4 + 2;

/** The longest acknowledgement delay the wire can tell; a longer one is sent as this. */
const MAX_ACKNOWLEDGEMENT_DELAY = 0xffff;

/**
 * Each Message entry is a type byte, the Message id (16 bits), the type's own
 * fields, the body length (16 bits), then the body. An Unreliable entry has no
 * fields of its own; a Sequenced or a Reliable entry has its sequence number
 * (16 bits). A Fragment entry carries one piece of a Reliable Message too
 * large for one Datagram: its Reliable sequence number, then the piece's
 * index and the Message's Fragment count (16 bits each).
 */
const ENTRY_UNRELIABLE = 1;
const ENTRY_SEQUENCED = 2;
const ENTRY_RELIABLE = 3;
const ENTRY_FRAGMENT = 4;
const UNRELIABLE_HEADER_SIZE = 5;
const SEQUENCED_HEADER_SIZE = 7;
const FRAGMENT_HEADER_SIZE = 11;

/**
 * Sequenced sequence numbers count modulo 2^16, per Message type, so a
 * long-running Connection wraps them: they are compared with `isNewer`.
 */
export const SEQUENCED_SEQUENCE_MASK = 0xffff;

/** Reliable sequence numbers count modulo 2^16 too, over every Reliable Message of one side of a Connection. */
export const RELIABLE_SEQUENCE_MASK = 0xffff;

/**
 * The largest Message body that fits in one Datagram, whatever its Delivery
 * mode, so that the limit does not depend on how a Message is sent.
 */
export const MAX_DATAGRAM_MESSAGE_SIZE =
  MAX_DATAGRAM_SIZE - CONNECTED_HEADER_SIZE - SEQUENCED_HEADER_SIZE;

/** The largest piece of a Reliable Message one Fragment carries, so that a Fragment fills a Datagram on its own. */
export const MAX_FRAGMENT_BODY_SIZE =
  MAX_DATAGRAM_SIZE - CONNECTED_HEADER_SIZE - FRAGMENT_HEADER_SIZE;

/**
 * The largest Reliable Message, 256 KiB once encoded: one larger is refused
 * when sent. Its 225 Fragments, each taking a Reliable sequence number, stay
 * well under MAX_RELIABLE_BACKLOG, so that a Message this large leaves room
 * in the Reliable stream for the Messages around it.
 */
export const MAX_RELIABLE_MESSAGE_SIZE = 256 * 1024;

/** The most Fragments a Reliable Message is split into; a Fragment claiming more is dropped. */
export const MAX_FRAGMENT_COUNT = Math.ceil(
  MAX_RELIABLE_MESSAGE_SIZE / MAX_FRAGMENT_BODY_SIZE,
);

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
export type CloseNoticeReason = Extract<
  CloseReason,
  { kind: "closedByClient" | "closedByServer" | "reliableBacklogOverflow" }
>;

const CLOSED_BY_CLIENT = 1;
const CLOSED_BY_SERVER = 2;
const CLOSED_FOR_RELIABLE_BACKLOG_OVERFLOW = 3;

/** A close notice is its reason byte, followed by the game's 16-bit code when the Server closed. */
const CLOSE_NOTICE_SIZE = HEADER_SIZE + 1;
const CLOSED_BY_SERVER_SIZE = CLOSE_NOTICE_SIZE + 2;

export type MessageEntry =
  | {
      readonly delivery: "unreliable";
      readonly id: number;
      readonly body: Uint8Array;
    }
  | {
      readonly delivery: "sequenced";
      readonly id: number;
      /** Counts the Sequenced Messages of this type one side sent on one Connection, wrapping at 2^16. */
      readonly sequence: number;
      readonly body: Uint8Array;
    }
  | {
      readonly delivery: "reliable";
      readonly id: number;
      /** Counts the Reliable Messages and Fragments, of every type, one side sent on one Connection, wrapping at 2^16. */
      readonly sequence: number;
      readonly body: Uint8Array;
      /** Present on a Fragment, whose body is one piece of the Message. */
      readonly fragment?: FragmentPosition;
    };

export type ReliableEntry = Extract<MessageEntry, { delivery: "reliable" }>;

/** Where a Fragment's piece sits in its Message: index from 0, out of `count` Fragments. */
export interface FragmentPosition {
  readonly index: number;
  readonly count: number;
}

/**
 * Whether Sequenced sequence number `a` was sent after `b`: it is, when it is
 * less than half the sequence space ahead of `b`, counting across the wrap.
 */
export function isNewer(a: number, b: number): boolean {
  const ahead = (a - b) & SEQUENCED_SEQUENCE_MASK;
  return ahead !== 0 && ahead <= SEQUENCED_SEQUENCE_MASK >>> 1;
}

/**
 * What one side of a Connection tells the other about the connected
 * Datagrams it received from it. Before anything is received, `received` is
 * 0, which acknowledges nothing.
 */
export interface Acknowledgement {
  /** The newest sequence number received. */
  readonly newest: number;
  /** Bit i (0 to 31) is set when sequence number `newest - i` was received. */
  readonly received: number;
  /**
   * Milliseconds between the arrival of `newest` and the sending of this
   * acknowledgement, so that the other side can leave it out of the
   * round-trip time.
   */
  readonly delay: number;
}

/** How many sequence numbers one acknowledgement covers, ending at its newest. */
export const ACKNOWLEDGEMENT_SPAN = 32;

/**
 * How many connected Datagrams after `b` the one numbered `a` was sent,
 * negative if before. Datagram sequence numbers count modulo 2^32, so this
 * takes the shorter way round the wrap.
 */
export function sequenceDistance(a: number, b: number): number {
  return (a - b) | 0;
}

export type Datagram =
  | { readonly kind: "connectRequest" }
  | { readonly kind: "challenge"; readonly challenge: Uint8Array }
  | {
      readonly kind: "challengeResponse";
      readonly challenge: Uint8Array;
      /** The Client's timeout, in milliseconds. */
      readonly timeout: number;
      readonly authToken: Uint8Array;
    }
  /** Carries the Server's timeout, in milliseconds. */
  | { readonly kind: "accepted"; readonly timeout: number }
  | { readonly kind: "refused"; readonly reason: RefusalReason }
  | {
      readonly kind: "connected";
      readonly tick: number;
      /** Counts the connected Datagrams one side sent on one Connection, from 0, so that a copy is recognized. */
      readonly sequence: number;
      readonly acknowledgement: Acknowledgement;
      readonly messages: readonly MessageEntry[];
    }
  /** Tells the other side of an open Connection that it is over. */
  | { readonly kind: "close"; readonly reason: CloseNoticeReason };

export type ConnectedDatagram = Extract<Datagram, { kind: "connected" }>;

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
      const { challenge, timeout, authToken } = datagram;
      const tokenStart = CHALLENGE_SIZE + TIMEOUT_SIZE + AUTH_TOKEN_LENGTH_SIZE;
      const body = new Uint8Array(tokenStart + authToken.byteLength);
      body.set(challenge);
      const view = new DataView(body.buffer);
      view.setUint32(CHALLENGE_SIZE, toldTimeout(timeout));
      view.setUint16(CHALLENGE_SIZE + TIMEOUT_SIZE, authToken.byteLength);
      body.set(authToken, tokenStart);
      return withHeader(KIND_CHALLENGE_RESPONSE, CLIENT_HANDSHAKE_SIZE, body);
    }
    case "accepted": {
      const data = withHeader(KIND_ACCEPTED, ACCEPTED_SIZE);
      new DataView(data.buffer).setUint32(
        HEADER_SIZE,
        toldTimeout(datagram.timeout),
      );
      return data;
    }
    case "refused":
      return encodeRefused(datagram.reason);
    case "connected":
      return encodeConnected(datagram);
    case "close":
      return encodeClose(datagram.reason);
  }
}

function encodeClose(reason: CloseNoticeReason): Uint8Array {
  switch (reason.kind) {
    case "closedByClient":
      return withHeader(
        KIND_CLOSE,
        CLOSE_NOTICE_SIZE,
        Uint8Array.of(CLOSED_BY_CLIENT),
      );
    case "reliableBacklogOverflow":
      return withHeader(
        KIND_CLOSE,
        CLOSE_NOTICE_SIZE,
        Uint8Array.of(CLOSED_FOR_RELIABLE_BACKLOG_OVERFLOW),
      );
    case "closedByServer":
      return withHeader(
        KIND_CLOSE,
        CLOSED_BY_SERVER_SIZE,
        Uint8Array.of(CLOSED_BY_SERVER, reason.code >>> 8, reason.code & 0xff),
      );
  }
}

function decodeClose(data: Uint8Array): Datagram | undefined {
  const reason = data[HEADER_SIZE];
  if (data.byteLength === CLOSE_NOTICE_SIZE && reason === CLOSED_BY_CLIENT)
    return { kind: "close", reason: { kind: "closedByClient" } };
  if (
    data.byteLength === CLOSE_NOTICE_SIZE &&
    reason === CLOSED_FOR_RELIABLE_BACKLOG_OVERFLOW
  )
    return { kind: "close", reason: { kind: "reliableBacklogOverflow" } };
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
function entrySize(message: SizedEntry): number {
  return entryHeaderSize(message) + message.body.byteLength;
}

function entryHeaderSize(message: SizedEntry): number {
  if (message.delivery === "unreliable") return UNRELIABLE_HEADER_SIZE;
  if (message.delivery === "reliable" && message.fragment)
    return FRAGMENT_HEADER_SIZE;
  return SEQUENCED_HEADER_SIZE;
}

/** What the bytes of a Message entry depend on, which is known before the entry is numbered. */
type SizedEntry = Pick<MessageEntry, "delivery" | "body"> & {
  readonly fragment?: FragmentPosition;
};

/**
 * Splits Messages, in order, into the groups that each fit in one connected
 * Datagram, filling each group before starting the next. Every body must be
 * at most MAX_DATAGRAM_MESSAGE_SIZE bytes, or MAX_FRAGMENT_BODY_SIZE for a
 * Fragment.
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

/**
 * The bytes a run of Messages takes on the network once `packMessages` has
 * packed it, Datagram headers included, counted as Messages are added in
 * order.
 *
 * Packing two runs one after the other never takes more than packing each
 * on its own: the second fills the room the first left in its last Datagram,
 * and what spills over starts further along the run than it would alone, so
 * it needs no more Datagrams. Runs counted apart can therefore share a limit.
 */
export class PackedSize {
  #bytes = 0;
  /** The room left in the last Datagram; none before the first. */
  #room = 0;

  get bytes(): number {
    return this.#bytes;
  }

  /** What `bytes` would become with `message` added. */
  with(message: SizedEntry): number {
    const size = entrySize(message);
    return this.#bytes + size + (size > this.#room ? CONNECTED_HEADER_SIZE : 0);
  }

  add(message: SizedEntry): void {
    const size = entrySize(message);
    if (size > this.#room) {
      this.#bytes += CONNECTED_HEADER_SIZE;
      this.#room = MAX_DATAGRAM_SIZE - CONNECTED_HEADER_SIZE;
    }
    this.#bytes += size;
    this.#room -= size;
  }
}

function encodeConnected({
  tick,
  sequence,
  acknowledgement,
  messages,
}: ConnectedDatagram): Uint8Array {
  const size = messages.reduce(
    (total, message) => total + entrySize(message),
    CONNECTED_HEADER_SIZE,
  );
  const data = withHeader(KIND_CONNECTED, size);
  const view = new DataView(data.buffer);
  view.setUint32(HEADER_SIZE, tick);
  view.setUint32(HEADER_SIZE + 4, sequence);
  view.setUint32(HEADER_SIZE + 8, acknowledgement.newest);
  view.setUint32(HEADER_SIZE + 12, acknowledgement.received >>> 0);
  view.setUint16(
    HEADER_SIZE + 16,
    Math.min(
      MAX_ACKNOWLEDGEMENT_DELAY,
      Math.max(0, Math.round(acknowledgement.delay)),
    ),
  );
  let offset = CONNECTED_HEADER_SIZE;
  for (const message of messages) {
    const fragment =
      message.delivery === "reliable" ? message.fragment : undefined;
    view.setUint8(
      offset,
      message.delivery === "unreliable"
        ? ENTRY_UNRELIABLE
        : message.delivery === "sequenced"
          ? ENTRY_SEQUENCED
          : fragment
            ? ENTRY_FRAGMENT
            : ENTRY_RELIABLE,
    );
    view.setUint16(offset + 1, message.id);
    if (message.delivery !== "unreliable")
      view.setUint16(offset + 3, message.sequence);
    if (fragment) {
      view.setUint16(offset + 5, fragment.index);
      view.setUint16(offset + 7, fragment.count);
    }
    const bodyStart = offset + entryHeaderSize(message);
    view.setUint16(bodyStart - 2, message.body.byteLength);
    data.set(message.body, bodyStart);
    offset = bodyStart + message.body.byteLength;
  }
  return data;
}

function decodeConnected(data: Uint8Array): Datagram | undefined {
  if (data.byteLength < CONNECTED_HEADER_SIZE) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const messages: MessageEntry[] = [];
  let offset = CONNECTED_HEADER_SIZE;
  while (offset < data.byteLength) {
    const type = view.getUint8(offset);
    const headerSize =
      type === ENTRY_UNRELIABLE
        ? UNRELIABLE_HEADER_SIZE
        : type === ENTRY_SEQUENCED || type === ENTRY_RELIABLE
          ? SEQUENCED_HEADER_SIZE
          : type === ENTRY_FRAGMENT
            ? FRAGMENT_HEADER_SIZE
            : undefined;
    if (headerSize === undefined || offset + headerSize > data.byteLength)
      return undefined;
    const id = view.getUint16(offset + 1);
    const bodyStart = offset + headerSize;
    // The body length closes every entry header, whatever the entry type.
    const bodyEnd = bodyStart + view.getUint16(bodyStart - 2);
    if (bodyEnd > data.byteLength) return undefined;
    const body = data.slice(bodyStart, bodyEnd);
    if (type === ENTRY_UNRELIABLE) {
      messages.push({ delivery: "unreliable", id, body });
    } else if (type === ENTRY_FRAGMENT) {
      const index = view.getUint16(offset + 5);
      const count = view.getUint16(offset + 7);
      // A Message that fits in one Datagram is never fragmented, nor is one over MAX_RELIABLE_MESSAGE_SIZE.
      if (count < 2 || count > MAX_FRAGMENT_COUNT || index >= count)
        return undefined;
      messages.push({
        delivery: "reliable",
        id,
        sequence: view.getUint16(offset + 3),
        body,
        fragment: { index, count },
      });
    } else
      messages.push({
        delivery: type === ENTRY_SEQUENCED ? "sequenced" : "reliable",
        id,
        sequence: view.getUint16(offset + 3),
        body,
      });
    offset = bodyEnd;
  }
  return {
    kind: "connected",
    tick: view.getUint32(HEADER_SIZE),
    sequence: view.getUint32(HEADER_SIZE + 4),
    acknowledgement: {
      newest: view.getUint32(HEADER_SIZE + 8),
      received: view.getUint32(HEADER_SIZE + 12),
      delay: view.getUint16(HEADER_SIZE + 16),
    },
    messages,
  };
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
      return data.byteLength === ACCEPTED_SIZE
        ? {
            kind: "accepted",
            timeout: new DataView(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).getUint32(HEADER_SIZE),
          }
        : undefined;
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
  const timeoutStart = HEADER_SIZE + CHALLENGE_SIZE;
  const tokenStart = timeoutStart + TIMEOUT_SIZE + AUTH_TOKEN_LENGTH_SIZE;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tokenSize = view.getUint16(timeoutStart + TIMEOUT_SIZE);
  if (tokenSize > MAX_AUTH_TOKEN_SIZE) return undefined;
  return {
    kind: "challengeResponse",
    challenge: data.slice(HEADER_SIZE, timeoutStart),
    timeout: view.getUint32(timeoutStart),
    authToken: data.slice(tokenStart, tokenStart + tokenSize),
  };
}

/** `timeout` as the wire tells it: whole milliseconds, rounded up, up to MAX_TOLD_TIMEOUT. */
function toldTimeout(timeout: number): number {
  return Math.min(MAX_TOLD_TIMEOUT, Math.max(0, Math.ceil(timeout)));
}

/** A zero-filled Datagram of `size` bytes with its header written and `body` right after it. */
function withHeader(kind: number, size: number, body?: Uint8Array): Uint8Array {
  const data = new Uint8Array(size);
  data[0] = PROTOCOL_VERSION;
  data[1] = kind;
  if (body) data.set(body, HEADER_SIZE);
  return data;
}
