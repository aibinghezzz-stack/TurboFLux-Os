import { getSharedCommand, type SharedCommandName } from '../commands/catalog'
import type { WorkbenchCommandDefinition } from './types'

function desktopCommand(name: SharedCommandName): WorkbenchCommandDefinition {
  const command = getSharedCommand(name)
  return {
    id: command.desktopId,
    slash: `/${command.name}`,
    title: command.desktopTitle,
    detail: command.desktopDetail,
    group: command.desktopGroup,
    keywords: [command.name, `/${command.name}`, ...(command.aliases || []), ...command.keywords],
  }
}

export const WORKBENCH_COMMANDS: WorkbenchCommandDefinition[] = [
  desktopCommand('vibe'),
  desktopCommand('plan'),
  { id: 'run.pause', title: '暂停当前任务', detail: '保留运行状态，稍后继续', group: '运行', keywords: ['pause', '暂停'] },
  { id: 'run.resume', title: '继续当前任务', detail: '从暂停位置继续运行', group: '运行', keywords: ['resume', '继续'] },
  { id: 'run.stop', title: '停止当前任务', detail: '中止当前 Agent 运行', group: '运行', keywords: ['stop', '停止'] },
  desktopCommand('context'),
  desktopCommand('compact'),
  desktopCommand('git'),
  { id: 'git.refresh', slash: '/git refresh', title: '刷新 Git 状态', detail: '重新读取当前仓库状态', group: '工作区', keywords: ['git refresh', '刷新'] },
  { id: 'activity.open', title: '查看任务活动', detail: '任务步骤、并行工作、队列与结果', group: '工作区', keywords: ['task', 'ps', 'flow', 'subagent', '任务'] },
  desktopCommand('mcp'),
  desktopCommand('skills'),
  { id: 'conversation.new', title: '新建任务', detail: '创建新的工作会话', group: '会话', keywords: ['new', '新建'], shortcut: '⌘ N' },
  desktopCommand('flow'),
  { id: 'flow.retry', slash: '/flow retry', title: '重试会话存储', detail: '恢复持久化并重新写入当前状态', group: '会话', keywords: ['flow retry', '恢复', '重试'] },
  { id: 'flow.export', slash: '/flow export', title: '导出恢复包', detail: '导出当前会话与未落盘数据', group: '会话', keywords: ['flow export', '导出恢复'] },
]

export function listWorkbenchCommands(): WorkbenchCommandDefinition[] {
  return WORKBENCH_COMMANDS.map(command => ({ ...command, keywords: [...command.keywords] }))
}
