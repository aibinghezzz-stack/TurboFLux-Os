# @turboflux/agent-core

The versioned TurboFlux Agent kernel shared by the open-source terminal product and private product shells.

The package owns Agent execution, conversations, task flow, tools, Skills, MCP contracts, Work Packs, and platform-neutral application services. It does not contain Electron, accounts, billing, cloud services, updates, product telemetry, or product UI.

Consumers must use the exported entrypoints instead of importing internal `dist/core`, `dist/application`, or `dist/shared` files.
