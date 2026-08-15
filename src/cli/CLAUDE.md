# TUI Surface and Command Bootstrap

## Module Role

`src/cli/` contains TurboFlux's Ink TUI plus its command bootstrap and setup.
TurboFlux itself is a TUI workbench, not a conventional CLI. The command-facing
files should parse startup options; the TUI-facing files should own terminal
interaction, rendering, keyboard input, and adaptation of application flow to Ink.

## Entrypoints

| File | Responsibility |
|------|----------------|
| `src/cli/index.ts` | Commander bootstrap for the `turboflux` executable. |
| `src/cli/setup.ts` | Interactive startup configuration before the TUI launches. |
| `src/cli/repl.ts` | Starts the Ink REPL experience. |
| `src/cli/components/App.tsx` | Main terminal UI component. |
| `src/cli/commands/` | Slash command registry and handlers. |

## Boundaries

- Do not put desktop-specific code here.
- Do not make shared model config live here; use `src/core/config.ts`.
- Keep UI-independent orchestration and state projections in `src/application/`.
- Use `src/core/` for assistant runtime behavior and `src/tools/` for tool execution.
- Keep TUI-only state, theme, rendering, and keyboard interaction in this folder.
