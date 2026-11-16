// Run as its own process by udp.test.ts: once the Client is closed and the
// Server stopped, nothing may keep the process alive.
import { connect } from "@ticknet/client";
import { startServer } from "@ticknet/server";

const server = await startServer({});
if (server.port === undefined) throw new Error("The Server has no UDP port");
const client = await connect({ host: "127.0.0.1", port: server.port });
client.close();
server.stop();
