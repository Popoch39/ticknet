# Security policy

## Supported versions

ticknet is pre-1.0. Only the latest released version receives fixes.

| Version        | Supported |
| -------------- | --------- |
| latest `0.0.x` | Yes       |
| older          | No        |

## What is not a vulnerability

ticknet v1 sends **plaintext Datagrams**: nothing is encrypted or signed, and the Auth token is opaque bytes the game checks itself. This is documented in the [README](README.md#limits-of-v1). Reports that only restate it (eavesdropping, tampering on the path) are known limits, not vulnerabilities.

In scope, for example: a Datagram that crashes or hangs a Server or Client, a way to bypass address proof in the Handshake, to exhaust a Server's memory or CPU with little traffic, or to make the Server amplify traffic toward a spoofed address.

## Reporting a vulnerability

Please do **not** open a public issue.

Report it privately through GitHub: [Report a vulnerability](https://github.com/Popoch39/ticknet/security/advisories/new). Include the affected version, a description of the impact and, if you can, a reproduction (the simulated network in `@ticknet/core/testing` is ideal for that).

You can expect an acknowledgement within a week. Once a fix is released, the advisory is published with credit to the reporter, unless you prefer otherwise.
