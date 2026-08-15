import { DefaultAgentStateProvider, type TurboFluxConfig } from '../kernel/tui'

export class CliStateProvider extends DefaultAgentStateProvider {
  constructor(config: TurboFluxConfig, workspacePath: string) {
    super(config, workspacePath, { conversationPrefix: 'cli' })
  }
}
