import type { MessageType } from "./message";

interface Route<Context> {
  readonly type: object;
  readonly name: string;
  readonly deliver: (body: Uint8Array, context: Context) => void;
}

/**
 * Hands each received Message to the game's handler for its type, decoded.
 * A Message whose id has no handler is ignored. A decode function or handler
 * that throws is reported instead of stopping the Messages after it.
 */
export class MessageRouter<Context> {
  readonly #routes = new Map<number, Route<Context>>();
  readonly #report: (error: Error) => void;

  constructor(report: (error: Error) => void) {
    this.#report = report;
  }

  on<T>(
    type: MessageType<T>,
    handler: (value: T, context: Context) => void,
  ): void {
    const taken = this.#routes.get(type.id);
    if (taken)
      throw new Error(
        taken.type === type
          ? `Message "${type.name}" already has a handler`
          : `Message "${type.name}" has id ${type.id}, which Message "${taken.name}" already uses`,
      );
    this.#routes.set(type.id, {
      type,
      name: type.name,
      deliver: (body, context) => {
        let value: T;
        try {
          value = type.decode(body);
        } catch (cause) {
          this.#report(
            new Error(
              `Could not decode Message "${type.name}" (id ${type.id})`,
              { cause },
            ),
          );
          return;
        }
        try {
          handler(value, context);
        } catch (cause) {
          this.#report(
            new Error(
              `The handler of Message "${type.name}" (id ${type.id}) threw`,
              { cause },
            ),
          );
        }
      },
    });
  }

  route(id: number, body: Uint8Array, context: Context): void {
    this.#routes.get(id)?.deliver(body, context);
  }
}
