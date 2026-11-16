/** How a game turns one kind of Message into bytes and back, in a format of its choosing. */
export interface MessageCodec<T> {
  encode(value: T): Uint8Array;
  /** May throw on bytes it does not accept; the error is contained and reported. */
  decode(data: Uint8Array): T;
}

export interface MessageDefinition<T> extends MessageCodec<T> {
  /** Identifies the Message on the wire, from 0 to MAX_MESSAGE_ID. */
  readonly id: number;
}

/** One kind of Message, shared by the Server and the Client. */
export interface MessageType<T> extends MessageDefinition<T> {
  readonly name: string;
}

/**
 * The guarantee a send asks for. An Unreliable Message may be lost or arrive
 * out of order; a Sequenced one may be lost, and is dropped if it arrives
 * after a newer Message of its type. Reliable is not available yet.
 */
export type DeliveryMode = "unreliable" | "sequenced";

export const MAX_MESSAGE_ID = 0xffff;

/**
 * Defines the Messages a game exchanges, each from an id and a codec. The
 * result is shared by the Server and the Client, so that sends and handlers
 * are type-checked against one definition.
 */
export function defineMessages<
  Values extends Record<string, unknown>,
>(definitions: {
  readonly [Name in keyof Values]: MessageDefinition<Values[Name]>;
}): { readonly [Name in keyof Values]: MessageType<Values[Name]> } {
  const names = new Map<number, string>();
  const types: Record<string, MessageType<unknown>> = {};
  for (const [name, definition] of Object.entries<MessageDefinition<unknown>>(
    definitions,
  )) {
    const { id } = definition;
    if (!Number.isInteger(id) || id < 0 || id > MAX_MESSAGE_ID)
      throw new RangeError(
        `Message "${name}" has id ${id}, not an integer from 0 to ${MAX_MESSAGE_ID}`,
      );
    const other = names.get(id);
    if (other !== undefined)
      throw new Error(
        `Messages "${other}" and "${name}" are both defined with id ${id}`,
      );
    names.set(id, name);
    types[name] = Object.freeze({
      name,
      id,
      encode: definition.encode,
      decode: definition.decode,
    });
  }
  return Object.freeze(types) as {
    readonly [Name in keyof Values]: MessageType<Values[Name]>;
  };
}
