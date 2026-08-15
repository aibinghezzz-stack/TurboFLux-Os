# TurboFlux

**English** | [中文](README.zh.md)

TurboFlux is an open-source local agent workbench — in your terminal, on your desktop, taking a task from description to done.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-20242a?logo=node.js)](https://nodejs.org)
[![macOS](https://img.shields.io/badge/macOS-13%2B-brightgreen)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-20242a?logo=typescript)](https://www.typescriptlang.org)

---

## Why TurboFlux

There are plenty of agent tools. TurboFlux cares about one thing: **tasks that go from description to done — trustworthy, controllable, and traceable.**

- 🗂️ **Task-first workbench** — Tasks progress through semantic stages: what's happening, what's been achieved, whether you need to step in, and what was finally delivered. Not a log of tool calls — a clear picture of work in flight.
- 🌐 **Browser control** — The agent opens pages, fills forms, walks through flows, verifies results, and downloads artifacts. Real browser, not a simulation.
- 🖥️ **Computer control** — Built on macOS accessibility, the agent operates your native apps: Keynote, browsers, terminals…
- 🧩 **Extensible by design** — Skills, Plugins, MCP servers, automations, and Work Packs — installed and run locally.
- 🔑 **Bring your own model** — OpenAI, Anthropic, DeepSeek, Kimi, GLM, OpenRouter, or any OpenAI-compatible endpoint. Switch anytime.

## Quick start

### Terminal TUI

```sh
# Install Node.js, then run one command
npx turboflux
```

Run `turboflux setup` first to configure your model provider.

### Desktop app

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run dev:desktop
```

### From source

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run build
npm run dev
```

## What it can do

| Scenario | Outcome |
| --- | --- |
| "Research the latest in X and write a report" | Search, read, cross-check, deliver a cited report |
| "Turn this idea into a working webpage" | Code, preview, iterate, see the result |
| "Organize this folder and group duplicate files" | Analyze, move, generate a manifest |
| "Check my project dependencies at 9am daily" | Scheduled automation with a change summary |

## Architecture

```
        ┌─────────────────────────────────────────┐
        │              TurboFlux Desktop          │  Electron
        └───────────────────┬─────────────────────┘
                            │ consumes via controlled exports
        ┌───────────────────▼─────────────────────┐
        │           @turboflux/agent-core         │  shared kernel
        │   agent runtime · tools · skills · mcp  │
        └───────────────────┬─────────────────────┘
                            │ same kernel
        ┌───────────────────▼─────────────────────┐
        │              TurboFlux TUI              │  terminal
        └─────────────────────────────────────────┘
```

| Component | Description |
| --- | --- |
| [`@turboflux/agent-core`](packages/agent-core) | Versioned shared kernel: agent runtime, tools, Skills, MCP, Work Packs |
| [`apps/desktop`](apps/desktop) | Native Electron workbench with browser and computer control |
| Terminal TUI | Ink-based terminal interface (`turboflux` / `tf`) |

The desktop app and the terminal TUI share the same kernel through its controlled export surface (workbench / runtime / contracts / extensions) — no deep imports, no duplicated logic.

## Model configuration

Any OpenAI-compatible API, configured on your machine:

```sh
turboflux setup api        # configure an API connection
turboflux setup persona    # configure response style
turboflux setup approval   # configure approval policy
```

## Development

```bash
npm run dev:cli          # terminal TUI dev mode
npm run dev:desktop      # desktop app dev mode
npm run type-check       # kernel + TUI type checks
npm test                 # kernel + TUI tests
npm run type-check:desktop
npm run test:desktop
```

## Community and support

- Report bugs and share ideas through [Issues](https://github.com/aibinghezzz-stack/TurboFLux-Os/issues)
- Create a plugin or Work Pack and share it with the community

## Contributing

TurboFlux is developed by the core team; external pull requests are not accepted at this time. We welcome issues and discussions.

- [CONTRIBUTING.md](CONTRIBUTING.md)（English）
- [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)（中文）

## License

[MIT](LICENSE) © TurboFlux
