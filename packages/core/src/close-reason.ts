/** Why a Connection closed, or why it never opened. */
export type CloseReason =
  | { readonly kind: "timeout" }
  | { readonly kind: "versionMismatch" }
  /** The Server's authentication callback refused the Client, with the game's code. */
  | { readonly kind: "denied"; readonly code: number }
  /** The Server already had its maximum number of Connections. */
  | { readonly kind: "serverFull" };

/** The largest code a game can attach to a denial; codes travel as 16-bit integers. */
export const MAX_CLOSE_CODE = 0xffff;
