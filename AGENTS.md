# AGENTS.md

TurboFlux is an open-source local agent workbench: a shared kernel, a terminal TUI, and an Electron desktop app. Read this file before changing anything; it defines the repository contract.

## Repository layout

```
src/                    Shared kernel source (compiled into @turboflux/agent-core and the TUI)
  kernel/               Public composition roots (contracts, runtime, renderer, tui, workbench)
  core/                 Agent runtime: agents, providers, MCP, skills, runtime, tools
  application/          UI-independent services: flow, conversations, projects, automations, artifacts
  cli/                  Ink TUI surface (components, commands, state)
  shared/               Shared contracts and types
  state/                State types
  tools/                Tool execution and memory
packages/
  agent-core/           Versioned kernel package @turboflux/agent-core (builds from src/ subset)
apps/
  desktop/              Electron desktop workbench (main process, browser/computer control, renderer)
bin/                    CLI entrypoints (turboflux, tf)
scripts/                Build, dev, and verification scripts
```

## Working rules

- Keep TUI rendering and terminal interaction in `src/cli/`; keep shared assistant behavior in `src/core/`, `src/tools/`, `src/shared/`, or `src/state/`.
- The desktop app consumes the kernel through `@turboflux/agent-core` exports (`workbench`, `contracts`, `runtime`, `renderer`, `extensions`, `tui`) — never deep imports into `src/`.
- The desktop renderer is a presentation adapter: it never imports Node or Electron APIs and never becomes the source of truth for runtime state.
- Never add account, billing, cloud services, or commercial telemetry to this repository.
- Keep provider credentials in local configuration or environment files, never in committed source.

## Development

```bash
npm install              # installs all workspaces
npm run type-check       # kernel + TUI type check
npm test                 # kernel + TUI tests
npm run type-check:desktop
npm run test:desktop
npm run dev:cli          # TUI dev mode
npm run dev:desktop      # Electron dev mode (requires agent-core build)
```

## Quality gates

- Every behavior change ships with tests.
- Type checks must pass for both the kernel and the desktop app.
- The desktop boundary must stay clean: desktop-only concerns never leak into `src/`.
- Keep the public `@turboflux/agent-core` export surface controlled.

## Contributing

TurboFlux is developed by the core team; external pull requests are not accepted at this time. Report issues and ideas through GitHub Issues. See [CONTRIBUTING.md](CONTRIBUTING.md).
