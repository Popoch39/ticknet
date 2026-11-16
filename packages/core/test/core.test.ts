import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ticknet/core";

test("core exposes the protocol version", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
