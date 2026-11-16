import { expect, spyOn, test } from "bun:test";
import { connect } from "@ticknet/client";
import { ManualClock, SimulatedNetwork } from "@ticknet/core/testing";
import { startServer, type Connection } from "@ticknet/server";

const SERVER = { host: "10.0.0.1", port: 4000 };

async function setup() {
  const clock = new ManualClock();
  const network = new SimulatedNetwork({ clock });
  const server = await startServer({ transport: network.bind(SERVER), clock });
  const opened: Connection[] = [];
  server.on("connectionOpened", (connection) => opened.push(connection));
  const connectFrom = (address: { host: string; port: number }) =>
    connect({ ...SERVER, transport: network.bind(address), clock });
  return { clock, opened, connectFrom };
}

test("a Client connects to a Server, which is told a Connection opened", async () => {
  const { clock, opened, connectFrom } = await setup();

  const connecting = connectFrom({ host: "10.0.0.2", port: 50000 });
  // The simulated network delivers on the Clock: nothing arrives until time is advanced.
  clock.advance(0);

  expect(await connecting).toBeDefined();
  expect(opened.map((connection) => connection.address)).toEqual([
    { host: "10.0.0.2", port: 50000 },
  ]);
});

test("several Clients connect to the same Server, each with its own Connection", async () => {
  const { clock, opened, connectFrom } = await setup();
  const addresses = [
    { host: "10.0.0.2", port: 50000 },
    { host: "10.0.0.3", port: 50000 },
    { host: "10.0.0.2", port: 50001 },
  ];

  const connecting = addresses.map((address) => connectFrom(address));
  clock.advance(0);

  const clients = await Promise.all(connecting);
  expect(new Set(clients).size).toBe(3);
  expect(new Set(opened).size).toBe(3);
  expect(opened.map((connection) => connection.address)).toEqual(addresses);
});

test("time only moves when the test advances the manual Clock, and no real time or timer is used", async () => {
  const realTime = [
    spyOn(Date, "now"),
    spyOn(performance, "now"),
    spyOn(globalThis, "setTimeout"),
    spyOn(globalThis, "setInterval"),
  ];
  try {
    const { clock, opened, connectFrom } = await setup();
    let connected = false;
    const connecting = connectFrom({ host: "10.0.0.2", port: 50000 }).then(
      () => {
        connected = true;
      },
    );

    // Lets every pending promise callback and I/O callback run, without moving the Clock.
    await new Promise((resolve) => setImmediate(resolve));
    expect(connected).toBe(false);
    expect(opened).toEqual([]);

    clock.advance(0);
    await connecting;
    expect(opened).toHaveLength(1);
    for (const spy of realTime) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of realTime) spy.mockRestore();
  }
});
