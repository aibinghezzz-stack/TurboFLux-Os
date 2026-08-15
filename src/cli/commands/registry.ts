import type { Command, CommandContext, CommandResult } from './types'
import { SharedCommandRegistry, type SkillRuntime } from '../../kernel/tui'
import { createTranslator } from '../i18n/translator'

const DEFAULT_TRANSLATOR = createTranslator('en')

class CommandRegistry extends SharedCommandRegistry<Command> {
  getProgress(input: string): { name: string; args: string } | null {
    const parsed = this.parse(input)
    if (!parsed) return null
    const command = this.get(parsed.name)
    if (!command) return null
    const enabled = typeof command.showsProgress === 'function'
      ? command.showsProgress(parsed.args)
      : command.showsProgress === true
    return enabled ? { name: command.name, args: parsed.args } : null
  }

  execute(input: string, ctx: CommandContext): CommandResult {
    const commandContext = typeof ctx.t === 'function' ? ctx : { ...ctx, t: DEFAULT_TRANSLATOR }
    const parsed = this.parse(input)
    if (!parsed) return { type: 'none' }

    const command = this.get(parsed.name)
    if (!command) {
      return { type: 'text', text: commandContext.t('command.unknown', { command: parsed.name }) }
    }

    switch (command.type) {
      case 'local': {
        const result = command.execute(parsed.args, commandContext)
        if (result) return { type: 'text', text: result }
        return { type: 'none' }
      }
      case 'local-jsx': {
        const jsx = command.execute(parsed.args, commandContext)
        return { type: 'jsx', jsx }
      }
      case 'prompt': {
        const prompt = command.getPrompt(parsed.args, commandContext)
        return { type: 'prompt', prompt }
      }
    }
  }

  async executeAsync(input: string, ctx: CommandContext): Promise<CommandResult> {
    const commandContext = typeof ctx.t === 'function' ? ctx : { ...ctx, t: DEFAULT_TRANSLATOR }
    const parsed = this.parse(input)
    if (!parsed) return { type: 'none' }

    const command = this.get(parsed.name)
    if (!command) {
      return { type: 'text', text: commandContext.t('command.unknown', { command: parsed.name }) }
    }
    if (command.type !== 'local' || !command.executeAsync) return this.execute(input, commandContext)

    const result = await command.executeAsync(parsed.args, commandContext)
    return result ? { type: 'text', text: result } : { type: 'none' }
  }

  registerSkills(skillRuntime: SkillRuntime): void {
    for (const skill of skillRuntime.getAll()) {
      const cmdName = skill.command.replace(/^\//, '')
      if (this.has(cmdName)) continue
      this.register({
        name: cmdName,
        description: skill.description || skill.name,
        type: 'prompt',
        getPrompt: (args, ctx) => {
          const prompt = ctx.skillRuntime?.getSkillPrompt(skill.id) || `Run skill: ${skill.name}`
          return args ? `${prompt}\n\nArguments: ${args}` : prompt
        },
      })
    }
  }
}

export const commandRegistry = new CommandRegistry()
