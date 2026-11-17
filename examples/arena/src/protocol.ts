// The Messages the arena Server and its Clients exchange, shared by both
// sides. Each one is sent with the Delivery mode that suits it:
//
// - positions (`position`, `world`) are Sequenced: only the newest matters,
//   and a late one must not move a character back;
// - effects (`blast`, `effect`) are Unreliable: a lost flash is not worth
//   sending again;
// - chat (`say`, `chat`) and the greeting (`welcome`) are Reliable: every line
//   must arrive, once and in order.
import { defineMessages, type CloseReason } from "@ticknet/core";

/** Size of the arena in cells; positions are 0-based. */
export const WIDTH = 48;
export const HEIGHT = 18;

/** Longest name, in characters, a Client may join with. */
export const MAX_NAME_LENGTH = 16;
/** Longest chat line, in characters. */
export const MAX_SAY_LENGTH = 120;
/**
 * Most Connections the arena accepts: every character's position travels in
 * one `world` Message, which must fit in one Datagram (5 bytes each).
 */
export const MAX_CHARACTERS = 200;

/** The Server's denial code for a name it refuses. */
export const DENIED_NAME = 1;

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Character extends Position {
  readonly id: number;
  /** The character drawn on the map, one printable ASCII character. */
  readonly glyph: string;
}

export interface World {
  /** The Server Tick this snapshot was taken at. */
  readonly tick: number;
  readonly characters: readonly Character[];
}

export interface Effect extends Position {
  /** Counts every effect the Server sent, so that Clients can count those lost. */
  readonly serial: number;
}

export interface ChatLine {
  /** Counts every chat line the Server sent, so that Clients can check none was lost. */
  readonly serial: number;
  readonly text: string;
}

const text = new TextEncoder();
const fromText = new TextDecoder();

export const messages = defineMessages({
  /** Server to Client, Reliable: which character is yours, and where it starts. */
  welcome: {
    id: 1,
    encode: ({ id, x, y, glyph }: Character) =>
      Uint8Array.of(id >> 8, id & 0xff, x, y, glyphCode(glyph)),
    decode: (data: Uint8Array): Character => ({
      id: u16(data, 0),
      x: byte(data, 2),
      y: byte(data, 3),
      glyph: String.fromCharCode(byte(data, 4)),
    }),
  },
  /** Client to Server, Sequenced: where my character is now. */
  position: {
    id: 2,
    encode: ({ x, y }: Position) => Uint8Array.of(x, y),
    decode: (data: Uint8Array): Position => ({
      x: byte(data, 0),
      y: byte(data, 1),
    }),
  },
  /** Server to every Client, Sequenced, once per Tick: where everyone is. */
  world: {
    id: 3,
    encode: ({ tick, characters }: World) => {
      const data = new Uint8Array(4 + characters.length * 5);
      const view = new DataView(data.buffer);
      view.setUint32(0, tick);
      characters.forEach(({ id, x, y, glyph }, index) => {
        const at = 4 + index * 5;
        view.setUint16(at, id);
        data.set([x, y, glyphCode(glyph)], at + 2);
      });
      return data;
    },
    decode: (data: Uint8Array): World => {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const characters: Character[] = [];
      for (let at = 4; at + 5 <= data.length; at += 5)
        characters.push({
          id: view.getUint16(at),
          x: byte(data, at + 2),
          y: byte(data, at + 3),
          glyph: String.fromCharCode(byte(data, at + 4)),
        });
      return { tick: view.getUint32(0), characters };
    },
  },
  /** Client to Server, Unreliable: my character lets off a blast. */
  blast: {
    id: 4,
    encode: () => new Uint8Array(0),
    decode: () => undefined,
  },
  /** Server to every Client, Unreliable: a blast went off there. */
  effect: {
    id: 5,
    encode: ({ serial, x, y }: Effect) => {
      const data = new Uint8Array(6);
      new DataView(data.buffer).setUint32(0, serial);
      data.set([x, y], 4);
      return data;
    },
    decode: (data: Uint8Array): Effect => ({
      serial: new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getUint32(0),
      x: byte(data, 4),
      y: byte(data, 5),
    }),
  },
  /** Client to Server, Reliable: a chat line. */
  say: {
    id: 6,
    encode: (line: string) => text.encode(line.slice(0, MAX_SAY_LENGTH)),
    decode: (data: Uint8Array) => fromText.decode(data),
  },
  /** Server to every Client, Reliable: a chat line, or news of a join or a leave. */
  chat: {
    id: 7,
    encode: ({ serial, text: line }: ChatLine) => {
      const body = text.encode(line);
      const data = new Uint8Array(4 + body.length);
      new DataView(data.buffer).setUint32(0, serial);
      data.set(body, 4);
      return data;
    },
    decode: (data: Uint8Array): ChatLine => ({
      serial: new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      ).getUint32(0),
      text: fromText.decode(data.subarray(4)),
    }),
  },
});

/** The name a Client joins with travels as its Auth token. */
export const encodeName = (name: string): Uint8Array => text.encode(name);

/**
 * The name in an Auth token, trimmed, or undefined when it is empty, too long
 * or not printable.
 */
export function decodeName(authToken: Uint8Array): string | undefined {
  const name = fromText.decode(authToken).trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
  // Control characters would garble every terminal showing the name.
  if (/\p{Cc}/u.test(name)) return undefined;
  return name;
}

/** Why a Connection ended, in a few words. */
export function describeClose(reason: CloseReason): string {
  switch (reason.kind) {
    case "timeout":
      return "timed out";
    case "closedByClient":
      return "quit";
    case "closedByServer":
      return "closed by the Server";
    case "denied":
      return reason.code === DENIED_NAME
        ? "denied: that name is not allowed"
        : `denied, code ${reason.code}`;
    case "serverFull":
      return "the arena is full";
    case "versionMismatch":
      return "another ticknet version";
    case "reliableBacklogOverflow":
      return "too many Reliable Messages waiting";
  }
}

/** Keeps a position inside the arena. */
export function clamp({ x, y }: Position): Position {
  return {
    x: Math.min(WIDTH - 1, Math.max(0, x)),
    y: Math.min(HEIGHT - 1, Math.max(0, y)),
  };
}

/** A printable ASCII code for a glyph, `?` for anything else. */
function glyphCode(glyph: string): number {
  const code = glyph.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e ? code : 0x3f;
}

/** A byte the sender always writes; 0 if a malformed body lacks it. */
const byte = (data: Uint8Array, at: number): number => data[at] ?? 0;

const u16 = (data: Uint8Array, at: number): number =>
  (byte(data, at) << 8) | byte(data, at + 1);
