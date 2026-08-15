export type SharedCommandName = 'plan' | 'vibe' | 'git' | 'compact' | 'context' | 'mcp' | 'skills' | 'flow'
export type SharedDesktopCommandId = 'mode.vibe' | 'mode.plan' | 'context.open' | 'context.compact' | 'git.open' | 'mcp.open' | 'skills.open' | 'activity.open'

export interface SharedCommandCatalogItem {
  name: SharedCommandName
  aliases?: string[]
  argumentHint?: string
  showsProgress?: boolean | ((args: string) => boolean)
  desktopId: SharedDesktopCommandId
  desktopTitle: string
  desktopDetail: string
  desktopGroup: '运行' | '工作区' | '能力' | '工具' | '会话'
  keywords: string[]
}

export const SHARED_COMMAND_CATALOG: readonly SharedCommandCatalogItem[] = [
  { name: 'vibe', aliases: ['code'], showsProgress: true, desktopId: 'mode.vibe', desktopTitle: '切换到 Vibe', desktopDetail: '直接执行任务并持续推进', desktopGroup: '运行', keywords: ['执行'] },
  { name: 'plan', showsProgress: true, desktopId: 'mode.plan', desktopTitle: '切换到 Plan', desktopDetail: '先分析并制定计划', desktopGroup: '运行', keywords: ['规划', '计划'] },
  { name: 'context', desktopId: 'context.open', desktopTitle: '查看上下文', desktopDetail: '查看 Token、上下文段与压缩状态', desktopGroup: '工作区', keywords: ['上下文'] },
  { name: 'compact', showsProgress: true, desktopId: 'context.compact', desktopTitle: '压缩上下文', desktopDetail: '手动生成连续工作摘要', desktopGroup: '工作区', keywords: ['压缩'] },
  { name: 'git', argumentHint: '[on|off|refresh]', showsProgress: args => Boolean(args.trim()), desktopId: 'git.open', desktopTitle: '查看 Git 状态', desktopDetail: '查看分支、变更、冲突与同步状态', desktopGroup: '工作区', keywords: ['分支', '变更'] },
  { name: 'mcp', argumentHint: '[status|tools]', desktopId: 'mcp.open', desktopTitle: '管理 MCP', desktopDetail: '连接、工具与错误状态', desktopGroup: '能力', keywords: ['连接器', '工具'] },
  { name: 'skills', desktopId: 'skills.open', desktopTitle: '管理 Work Packs', desktopDetail: '安装工作流、工具与集成', desktopGroup: '能力', keywords: ['work pack', 'skill', 'plugin', '技能', '插件'] },
  { name: 'flow', argumentHint: '[status|retry|export [path]]', showsProgress: args => /^(retry|export)(?:\s|$)/i.test(args.trim()), desktopId: 'activity.open', desktopTitle: '查看 Flow 状态', desktopDetail: '查看队列、后台工作、结果与恢复状态', desktopGroup: '工作区', keywords: ['队列', '后台', '结果'] },
]

export function getSharedCommand(name: SharedCommandName): SharedCommandCatalogItem {
  const command = SHARED_COMMAND_CATALOG.find(item => item.name === name)
  if (!command) throw new Error(`Shared command is not registered: ${name}`)
  return command
}

export function sharedCommandRegistration(name: SharedCommandName) {
  const command = getSharedCommand(name)
  return {
    name: command.name,
    aliases: command.aliases ? [...command.aliases] : undefined,
    argumentHint: command.argumentHint,
    showsProgress: command.showsProgress,
  }
}
