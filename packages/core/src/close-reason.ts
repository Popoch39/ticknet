/** Why a Connection closed, or why it never opened. */
export type CloseReason =
  { readonly kind: "timeout" } | { readonly kind: "versionMismatch" };
