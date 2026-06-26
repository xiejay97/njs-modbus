# Development Guidelines for njs-modbus

Strict architectural, performance, and documentation constraints. AI assistants MUST follow these without exception. Package manager: **pnpm** (Node `>=18.19`); run all commands from the repo root.

---

## Common Commands

### Make a change correct (run in order; every step must exit `0`)

```bash
pnpm run lint --fix # format + auto-fix. THIS is the formatting step.
pnpm run typecheck  # tsc --noEmit
pnpm run lint       # confirm no remaining (non-fixable) violations
pnpm test           # vitest run
```

- **Formatting = `pnpm run lint --fix`** (`eslint . --fix`). Prettier runs as an ESLint rule (`eslint-plugin-prettier`), so this applies Prettier **plus** every fixable ESLint rule (import order, TS style, ...). Do NOT use `pnpm run format` (`prettier --write .`) as the format step — it skips import ordering / TS-style rules and leaves `eslint` failing.
- Check without modifying: `pnpm run lint`, or `pnpm exec prettier --check .` (Prettier only).
- Targeted tests: `pnpm test <path>` · `pnpm test -t "name"` · `pnpm test src/layers/` · `pnpm exec vitest` (watch).
- Other: `pnpm run build` (tsdown → `dist/`) · `pnpm run dev` (watch) · `pnpm run test:coverage` (v8 coverage → `coverage/`, `src/**` excl. `*.test.ts`) · `pnpm run docs:build` (TypeDoc) · `pnpm run benchmark`|`:security`|`:fast`|`:test`|`:full` · `pnpm run release` (release-it, Conventional Commits).

---

## 1. Performance & Memory

### 1.1 Hot Paths (CPU-bound, synchronous: codec parsing, frame/CRC/LRC validation, tight bitwise loops)

- **Strictly inline.** Do NOT extract small math/lookup/bitwise ops into helper functions.
- **Zero allocation.** No new objects/arrays, no `Buffer.alloc()` / `Buffer.slice()`. Pass shared/pooled `Buffer` + explicit `offset`/`length`.
- **Prefer primitive types.** Favour `number` / `boolean` / literal scalars over objects or boxed wrappers — primitives live in registers/stack and aren't GC-tracked.

### 1.2 Control & I/O Paths (async: transport state machines, streams, pools, event routing)

- Prioritize modularity and readability over inlining; micro-abstraction cost is negligible vs. I/O latency.

---

## 2. TSDoc (`src/**/*.ts`)

- **2.1 Format/Language:** `/** */` blocks for all exported constructs (`class`/`interface`/`type`/`enum`/`function`/`const`). Never `//` for API surface. Public TSDoc MUST be English; inline `//` notes inside bodies match the file's existing language.
- **2.2 Tags:** `@template T` on every generic. `@param`/`@returns` on all methods, each `@param` stating **units** (`ms`/`byte`/`bit`), **inclusivity**, **endianness**, and exact **offsets**. `@throws` on any branch that can raise, stating the precise trigger (link breakdown, CRC failure, MBAP corruption, payload > 256 bytes, ...).
- **2.3 Tone/Preservation:** Calm, deterministic, expert — state exact industrial boundaries (e.g. "3.5 character-time silence window", "7-byte MBAP header"). For any Section 1.1 code, include `* @note Hot Path: Strictly Inline. Do not refactor into sub-routines.`
- **2.4 Retrofitting (Iron-Line):** Comment edits must alter **zero** runtime logic/naming/signatures/exports (compiled MD5 unchanged). Never elide with `// ... unchanged`. If an incremental `Edit` duplicates blocks, abort and recover via a full `Write`, then validate with `npx tsc --noEmit`.

---

## 3. Module Resolution & Import/Export Matrix

| Initiating | Allowed | Prohibited | Token Format |
| :--- | :--- | :--- | :--- |
| `src/` | internal only | `test/`, `examples/`, `benchmark/` | relative paths, `#test` |
| `test/` | package or alias | direct paths into `src/` | `#src` or `njs-modbus` (preferred) |
| `examples/` | package entry | `src/`, `test/` | `njs-modbus` |
| `benchmark/` | package alias | `src/`, `test/` | `#njs-modbus` |

- **No extensions** in import paths (no `.ts`/`.js`/`.json`).
- **No explicit index** — use `from './security'`, not `from './security/index'`.

---

## 4. Conventional Commits

Format: `<type>(<scope>): <description>`.

- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- **Scope:** mandatory for component-specific changes (e.g. `feat(codec):`, `perf(rtu):`, `fix(serial):`).
- **Grammar:** imperative, present tense (e.g. `fix(crc): inline LRC loop to avoid frame allocation`).
- **Breaking:** `!` after type/scope, or a `BREAKING CHANGE:` footer.
