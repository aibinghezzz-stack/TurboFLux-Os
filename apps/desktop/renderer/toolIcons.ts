// 工具图标：原创线性风格 SVG，不包含任何第三方图形资产。
export type ToolIconKind = 'api' | 'browse' | 'checklist' | 'edit' | 'globe' | 'question' | 'search' | 'sparkle' | 'think'

const ICONS: Record<ToolIconKind, string> = {
  api: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.5 6.5 9.5 9.5M9.5 6.5l-3 3"/></svg>',
  browse: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 2.7 3.4 2.7 5.5S9.8 11.9 8 13.5C6.2 11.9 5.3 10.1 5.3 8S6.2 4.1 8 2.5Z"/></svg>',
  checklist: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 5.5 11 13 3.5"/><path d="M5 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V8"/></svg>',
  edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m11.2 2.3 2.5 2.5L5.5 13l-3.2.7.7-3.2 8.2-8.2Z"/><path d="M9.8 3.7 12.3 6.2"/></svg>',
  globe: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.8 1.6 2.7 3.4 2.7 5.5S9.8 11.9 8 13.5C6.2 11.9 5.3 10.1 5.3 8S6.2 4.1 8 2.5Z"/></svg>',
  question: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M6.3 6.2a1.8 1.8 0 0 1 3.4.9c0 1.2-1.7 1.4-1.7 2.4M8 11.4h.01"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/></svg>',
  sparkle: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7 2.5c.3 2.6 1.9 4.2 4.5 4.5-2.6.3-4.2 1.9-4.5 4.5-.3-2.6-1.9-4.2-4.5-4.5 2.6-.3 4.2-1.9 4.5-4.5ZM12.5 8c.2 1.6 1.2 2.6 2.8 2.8-1.6.2-2.6 1.2-2.8 2.8-.2-1.6-1.2-2.6-2.8-2.8 1.6-.2 2.6-1.2 2.8-2.8Z"/></svg>',
  think: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><path d="M6.3 10.5h3.4M6.8 5.2h.01M9.2 5.2h.01M5.8 7.8h4.4"/></svg>',
}

export function toolIcon(kind: ToolIconKind): string {
  return ICONS[kind]
}
