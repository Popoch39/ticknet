import { expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "@ticknet/server";

test("server speaks the protocol version of core", () => {
  expect(PROTOCOL_VERSION).toBe(1);
});
