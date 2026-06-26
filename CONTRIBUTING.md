# Contributing to njs-modbus

We welcome contributions from the community.

## Getting Started

1. Fork the repository.
2. Create a new branch for your change.
3. Make your changes and add or update tests as needed.
4. Run the validation commands from the repo root:

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run lint
pnpm test
```

5. Submit a pull request with a clear description of the change.

## Contributor License Agreement

By contributing to `njs-modbus`, you agree that your contributions are licensed
under the [Contributor License Agreement](.github/CLA.md), which grants the
project maintainer the right to license your contributions under the Business
Source License 1.1 and any future Change License.

## Code Style

- Use strict TypeScript.
- Follow the existing code style and naming conventions.
- Add TSDoc comments for all exported constructs.
- Keep hot-path code strictly inline and allocation-free where applicable.

## Reporting Issues

Please open an issue on GitHub with a clear description, reproduction steps,
and environment details.
