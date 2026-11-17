// The command-line options shared by the terminal Client and the bots: where
// the arena is, and the network conditions to put on each Client's link.
import type { ClientOptions } from "@ticknet/client";
import { withNetworkConditions } from "@ticknet/core/testing";

/** Options for `parseArgs`, shared by the Client and the bots. */
export const linkOptions = {
  host: { type: "string", default: "127.0.0.1" },
  port: { type: "string", default: "4000" },
  loss: { type: "string", default: "0" },
  latency: { type: "string", default: "0" },
  jitter: { type: "string", default: "0" },
  seed: { type: "string" },
} as const;

export interface LinkSettings {
  readonly host: string;
  readonly port: number;
  /** Share of Datagrams lost, in each direction, from 0 to 1. */
  readonly loss: number;
  /** Milliseconds added in each direction. */
  readonly latency: number;
  /** Up to this many more milliseconds, at random, in each direction. */
  readonly jitter: number;
  readonly seed: number;
}

/** Reads and checks the values `parseArgs` returned for `linkOptions`. */
export function linkSettings(values: {
  host: string;
  port: string;
  loss: string;
  latency: string;
  jitter: string;
  seed?: string;
}): LinkSettings {
  return {
    host: values.host,
    port: integer("port", values.port),
    loss: number("loss", values.loss),
    latency: number("latency", values.latency),
    jitter: number("jitter", values.jitter),
    // A random seed by default, printed so that a run can be replayed.
    seed:
      values.seed === undefined
        ? Math.floor(Math.random() * 2 ** 31)
        : integer("seed", values.seed),
  };
}

/** Whether the settings degrade the link at all. */
export const isDegraded = ({ loss, latency, jitter }: LinkSettings): boolean =>
  loss > 0 || latency > 0 || jitter > 0;

/** The settings in a few words, for a status line. */
export function describeLink(settings: LinkSettings): string {
  if (!isDegraded(settings)) return "perfect link";
  const { loss, latency, jitter, seed } = settings;
  return `link: ${Math.round(loss * 100)}% loss, ${latency}+${jitter} ms each way, seed ${seed}`;
}

/**
 * The Client options that put the settings on a Client's own UDP socket,
 * through the network-condition wrapper of `@ticknet/core/testing`. `offset`
 * gives each bot its own seed.
 */
export function connectOptions(
  settings: LinkSettings,
  offset = 0,
): Pick<ClientOptions, "host" | "port" | "wrapTransport"> {
  const { host, port } = settings;
  if (!isDegraded(settings)) return { host, port };
  const conditions = {
    loss: settings.loss,
    latency: settings.latency,
    jitter: settings.jitter,
  };
  return {
    host,
    port,
    wrapTransport: (transport, clock) =>
      withNetworkConditions(transport, {
        clock,
        seed: settings.seed + offset,
        send: conditions,
        receive: conditions,
      }),
  };
}

function number(name: string, value: string): number {
  const parsed = Number(value);
  if (value.trim() === "" || !Number.isFinite(parsed) || parsed < 0)
    throw new Error(`--${name} must be a number of at least 0, not ${value}`);
  return parsed;
}

/** A command-line value that must be a whole number of at least 0. */
export function integer(name: string, value: string): number {
  const parsed = number(name, value);
  if (!Number.isInteger(parsed))
    throw new Error(`--${name} must be a whole number, not ${value}`);
  return parsed;
}
