# TurboFlux

English | [中文](README.zh.md)

TurboFlux (`tf`) is an open-source local agent workbench: a terminal TUI, a desktop app, and a shared kernel for getting real work done — research, writing, development, browser automation and more — with your own model keys.

## Components

| Package | Description |
| --- | --- |
| [`@turboflux/agent-core`](packages/agent-core) | Versioned shared kernel: agent runtime, tools, Skills, MCP, Work Packs |
| [`apps/desktop`](apps/desktop) | Native Electron desktop workbench with browser and computer control |
| Terminal TUI | Ink-based terminal interface (`turboflux` / `tf`) |

## Run

### Run the TUI

Install `Node.js`, then run:

```sh
npx turboflux
```

The command starts the terminal UI in the current directory. Run `turboflux setup` to configure a model provider first.

### Run the Desktop app

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run dev:desktop
```

### Run from source

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run build
npm run dev
```

## Models

TurboFlux works with any OpenAI-compatible API — OpenAI, Anthropic, DeepSeek, Kimi, GLM, OpenRouter, or your own endpoint. Configure your provider and API key locally; everything runs on your machine.

## Community and support

- Feel free to submit feedback or bug reports through [Issues](https://github.com/aibinghezzz-stack/TurboFLux-Os/issues).
- Create a plugin or Work Pack and share it with the community.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

- Terminal TUI: `npm run dev:cli`
- Desktop: `npm run dev:desktop`
- Tests: `npm test`
- Type checks: `npm run type-check`

## License

[MIT](LICENSE)
