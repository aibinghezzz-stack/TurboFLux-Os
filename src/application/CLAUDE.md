# Application Layer

## Module Role

`src/application/` owns UI-independent orchestration and state projections shared by terminal and desktop surfaces.

## Boundaries

- Depend on contracts from `src/shared/`, `src/state/`, and runtime APIs from `src/core/`.
- Do not depend on Ink, terminal input, TUI rendering, or desktop framework implementations.
- Expose stable entrypoints for UI adapters instead of making surfaces import internal modules directly.
- Keep persistence formats and event schemas versioned when application state crosses process boundaries.

## Modules

- `flow/` owns UI-independent event reduction, stores, and selectors.
- `conversations/` owns durable conversation persistence, journaling, recovery, and interaction-state restoration.
- `workbench/` composes the shared agent runtime, Flow, conversations, Skills, MCP, approvals, and queue lifecycle for UI adapters.
