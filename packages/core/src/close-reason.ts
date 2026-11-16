/** Why a Connection closed, or why it never opened. */
export type CloseReason =
  /** Nothing arrived from the other side for longer than the timeout. */
  | { readonly kind: "timeout" }
  | { readonly kind: "versionMismatch" }
  /** The Server's authentication callback refused the Client, with the game's code. */
  | { readonly kind: "denied"; readonly code: number }
  /** The Server already had its maximum number of Connections. */
  | { readonly kind: "serverFull" }
  /** The Client left on purpose. */
  | { readonly kind: "closedByClient" }
  /** The Server closed the Connection, or stopped, with the game's code. */
  | { readonly kind: "closedByServer"; readonly code: number };

/** The largest code a game can attach to a denial or a close; codes travel as 16-bit integers. */
export const MAX_CLOSE_CODE = 0xffff;

/** Throws a RangeError, naming `what` the code is for, unless it is an integer from 0 to MAX_CLOSE_CODE. */
export function assertCloseCode(code: number, what: string): void {
  if (!Number.isInteger(code) || code < 0 || code > MAX_CLOSE_CODE)
    throw new RangeError(
      `A ${what} code must be an integer from 0 to ${MAX_CLOSE_CODE}, not ${code}`,
    );
}
