# Contributing to ticknet

Thanks for your interest. Bug reports, questions and pull requests are welcome.
By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

- **Bugs and ideas**: open an issue first, with the bug report or feature request template. For anything larger than a small fix, agree on the change in the issue before writing code.
- **Security issues**: never in a public issue. See [SECURITY.md](SECURITY.md).
- **Scope**: ticknet is a transport, not a netcode framework (see the [README](README.md)). State replication, interpolation, prediction, matchmaking or rooms belong in a layer on top, not in these packages.

## Setup

You need [Bun](https://bun.sh) 1.4.4, the version CI runs.

```sh
git clone https://github.com/Popoch39/ticknet.git
cd ticknet
bun install
```

The repository is a Bun workspace:

- `packages/core`: the sans-IO protocol core, with no Bun or Node API.
- `packages/server` and `packages/client`: the two sides, over `Bun.udpSocket`.
- `examples/arena`: the demo game.

## The gate

A pull request is merged only when the same gate as CI passes:

```sh
bun check            # type-check
bun fmt --check      # formatting (run `bun fmt` to fix)
bun test             # tests
bun run build        # the publishable build
```

Every bug fix comes with a test that fails without it. The simulated network and manual Clock in `@ticknet/core/testing` let a test reproduce loss, delay and reordering deterministically, from a seed.

## Conventions

- **English everywhere**: code, comments, tests, commits and docs.
- **The glossary's vocabulary**: [GLOSSARY.md](GLOSSARY.md) defines the domain terms (Message, Datagram, Delivery mode, Tick, Connection…). Use them as written, and add a term there before using a new one.
- **Decisions**: architectural decisions live in [docs/adr/](docs/adr/). A change that goes against one says so in its pull request.
- **Comments** explain why, not what.
- **No new runtime dependency** without discussing it in an issue first: the packages depend on nothing but each other.
- **Commits**: short, imperative subject lines that say what the change does (`Fix keepalives sent after shutdown`).

## Pull requests

Fork the repository, branch from `main`, and open the pull request against `main`. Fill in the template: what changes, why, and how it was tested. Keep one concern per pull request.
