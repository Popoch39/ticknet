import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ticknet/client";

test("client speaks the protocol version of core", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
