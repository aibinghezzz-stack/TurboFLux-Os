export const NEW_TASK_TITLE = '新任务'

export interface TaskConversationSummary {
  id: string
  title?: string
  updatedAt: number
  turnCount: number
  titleSource?: 'generated' | 'custom'
}

export function isPlaceholderTaskTitle(title?: string): boolean {
  const normalized = title?.trim().toLowerCase()
  return !normalized || normalized === 'untitled' || normalized === '未命名任务' || normalized === NEW_TASK_TITLE
}

export function taskDisplayTitle(conversation: Pick<TaskConversationSummary, 'title' | 'turnCount'>): string {
  return conversation.turnCount === 0 || isPlaceholderTaskTitle(conversation.title)
    ? NEW_TASK_TITLE
    : conversation.title!.trim()
}

export function reusableEmptyConversation<T extends TaskConversationSummary>(conversations: T[], currentId?: string): T | undefined {
  const empty = conversations
    .filter(conversation => conversation.turnCount === 0)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return empty.find(conversation => conversation.id === currentId) || empty[0]
}

export function visibleTaskConversations<T extends TaskConversationSummary>(
  conversations: T[],
  currentId?: string,
  activeConversationIds: ReadonlySet<string> = new Set(),
  limit = 18,
): T[] {
  const visible = conversations.filter(conversation => {
    if (conversation.id === currentId) return true
    if (conversation.turnCount === 0) return false
    return !(conversation.titleSource !== 'custom' && isPlaceholderTaskTitle(conversation.title))
  })
  visible.sort((left, right) => {
    if (left.id === currentId) return right.id === currentId ? 0 : -1
    if (right.id === currentId) return 1
    const leftActive = activeConversationIds.has(left.id)
    const rightActive = activeConversationIds.has(right.id)
    if (leftActive !== rightActive) return leftActive ? -1 : 1
    return right.updatedAt - left.updatedAt
  })
  return visible.slice(0, limit)
}

export function fallbackTaskTitle(prompt: string): string {
  const firstSentence = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^[#>*\-\d.、\s]+/g, '')
    .replace(/^(?:请|麻烦)?(?:你)?(?:帮我|帮忙|协助我|给我)?\s*/u, '')
    .replace(/^(?:我想|我需要|我们要|我们得|现在要|现在需要)\s*/u, '')
    .split(/[。！？!?\n]/u)[0]
    .replace(/\s+/g, ' ')
    .trim()
  if (!firstSentence) return NEW_TASK_TITLE
  return firstSentence.slice(0, 28).replace(/[，,；;：:。.!！?？\s]+$/u, '') || NEW_TASK_TITLE
}
