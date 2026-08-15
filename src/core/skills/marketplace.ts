import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import {
  SkillMarketplaceRequestController,
  type SkillMarketplaceCircuitSnapshot,
  type SkillMarketplaceRetryNotice,
  type SkillMarketplaceTransport,
} from './marketplaceNetwork'

export type SkillMarketplaceCategory = '设计' | '文档' | '研究' | '评审' | '自动化'
export type SkillMarketplaceInstallState = 'not-installed' | 'installed' | 'update-available' | 'modified' | 'broken' | 'local'

export interface SkillMarketplaceSource {
  id: string
  name: string
  description: string
  repositoryUrl: string
  kind: 'official' | 'community'
}

export interface SkillMarketplaceEntry {
  id: string
  skillId: string
  name: string
  description: string
  category: SkillMarketplaceCategory
  icon: string
  author: string
  sourceId: string
  repository: string
  repositoryUrl: string
  ref: string
  path: string
  license: string
  requirement?: string
  promptTemplate: string
  featured: boolean
  version?: string
  updatedAt?: string
  tags?: string[]
  capabilities?: string[]
  installed?: boolean
  installState?: SkillMarketplaceInstallState
  installedAt?: string
  installedVersion?: string
  fileCount?: number
  sizeBytes?: number
  canUninstall?: boolean
}

export interface SkillMarketplaceInstallOptions {
  targetRoot?: string
  allowOverwrite?: boolean
  signal?: AbortSignal
  requestController?: SkillMarketplaceRequestController
  onProgress?: (progress: SkillMarketplaceInstallProgress) => void
}

export type SkillMarketplaceInstallPhase = 'resolving' | 'downloading' | 'verifying' | 'replacing' | 'completed'

export interface SkillMarketplaceResourceAssessment {
  fileCount: number
  totalBytes: number
  largestFileBytes: number
  requiredDiskBytes: number
  availableDiskBytes: number
  remainingDiskBytes: number
  availableFileSlots?: number
  risk: 'normal' | 'elevated'
  notes: string[]
}

export interface SkillMarketplaceInstallProgress {
  phase: SkillMarketplaceInstallPhase
  filesCompleted: number
  filesTotal: number
  bytesCompleted: number
  bytesTotal: number
  currentFile?: string
  transport?: SkillMarketplaceTransport
  retry?: SkillMarketplaceRetryNotice
  assessment?: SkillMarketplaceResourceAssessment
  circuits?: SkillMarketplaceCircuitSnapshot[]
}

export interface SkillMarketplaceRecoveryResult {
  removedTemporaryDirectories: number
  restoredBackups: string[]
  removedBackups: number
  warnings: string[]
}

interface SkillMarketplaceInstallFile {
  path: string
  size: number
  sha256: string
}

interface SkillMarketplaceInstallManifest {
  schemaVersion: 2
  id: string
  skillId: string
  repository: string
  ref: string
  catalogVersion: string
  installedAt: string
  files: SkillMarketplaceInstallFile[]
}

interface GithubContentEntry {
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  path: string
  size?: number
  download_url?: string | null
}

const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000
const GITHUB_API_REQUEST_ATTEMPTS = 4
const GITHUB_RAW_REQUEST_ATTEMPTS = 3
const EMERGENCY_METADATA_ENTRY_LIMIT = 100_000
const DISK_RESERVE_FLOOR_BYTES = 256 * 1024 * 1024
const FILESYSTEM_ENTRY_OVERHEAD_BYTES = 8 * 1024
const DEFAULT_CATALOG_VERSION = '1.0.0'

const MARKETPLACE_DETAILS: Record<string, Pick<SkillMarketplaceEntry, 'version' | 'updatedAt' | 'tags' | 'capabilities'>> = {
  'anthropic-frontend-design': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['前端', '视觉设计', 'UI'], capabilities: ['读取项目', '编辑界面', '视觉验收'] },
  'github-anti-ui-slop': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['UI 评审', '去 AI 味', '产品设计'], capabilities: ['界面评审', '样式改进', '一致性检查'] },
  'anthropic-pptx': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['PPT', '演示文稿', '视觉'], capabilities: ['生成演示文稿', '渲染检查', '版式修订'] },
  'anthropic-docx': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['Word', 'DOCX', '排版'], capabilities: ['创建文档', '修订批注', '渲染验收'] },
  'anthropic-pdf': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['PDF', '表单', '提取'], capabilities: ['读取 PDF', '生成 PDF', '视觉验收'] },
  'anthropic-xlsx': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['Excel', '表格', '数据'], capabilities: ['表格分析', '公式编辑', '工作簿验收'] },
  'anthropic-brand-guidelines': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['品牌', '规范', '视觉'], capabilities: ['品牌提取', '视觉约束', '一致性检查'] },
  'anthropic-theme-factory': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['主题', '配色', '字体'], capabilities: ['主题生成', '视觉应用', '样式统一'] },
  'anthropic-canvas-design': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['海报', '画布', '平面设计'], capabilities: ['视觉构图', '图形创作', '成品导出'] },
  'anthropic-mcp-builder': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['MCP', '工具', '集成'], capabilities: ['服务设计', '工具建模', '联调验收'] },
  'anthropic-skill-creator': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['Skills', '工作流', '扩展'], capabilities: ['需求提炼', 'Skill 创建', '质量评审'] },
  'anthropic-doc-coauthoring': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['写作', '长文档', '协作'], capabilities: ['提纲规划', '受众校验', '逐段修订'] },
  'anthropic-internal-comms': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['公告', '周报', '复盘'], capabilities: ['结构化写作', '信息提炼', '语气适配'] },
  'github-autoresearch': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['调研', '证据', '决策'], capabilities: ['检索规划', '来源比较', '结论报告'] },
  'github-review-and-refactor': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['代码评审', '重构', '验收'], capabilities: ['证据评审', '风险排序', '回归验证'] },
  'github-security-review': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['安全', '权限', '依赖'], capabilities: ['威胁建模', '权限审计', '修复排序'] },
  'github-documentation-writer': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['文档', '示例', '教程'], capabilities: ['行为核对', '结构化文档', '示例编写'] },
  'anthropic-webapp-testing': { version: '1.0.0', updatedAt: '2026-07-31', tags: ['浏览器', '测试', '验收'], capabilities: ['页面操作', '异常验证', '验收报告'] },
  'github-chrome-devtools': { version: '1.0.0', updatedAt: '2026-08-02', tags: ['Chrome', '网络', '性能'], capabilities: ['页面诊断', '网络检查', '性能分析'] },
}

export const SKILL_MARKETPLACE_SOURCES: SkillMarketplaceSource[] = [
  {
    id: 'anthropic-skills',
    name: 'Anthropic Skills',
    description: '生产级文档、设计与工作流 Skill 示例。',
    repositoryUrl: 'https://github.com/anthropics/skills',
    kind: 'official',
  },
  {
    id: 'github-awesome-copilot',
    name: 'GitHub Awesome Copilot',
    description: 'GitHub 官方维护的 Agent Skills 与工作流集合。',
    repositoryUrl: 'https://github.com/github/awesome-copilot',
    kind: 'official',
  },
  {
    id: 'microsoft-agent-skills',
    name: 'Microsoft Agent Skills',
    description: 'Microsoft Learn 团队维护的专业 Agent Skills。',
    repositoryUrl: 'https://github.com/MicrosoftDocs/Agent-Skills',
    kind: 'official',
  },
  {
    id: 'voltagent-awesome-agent-skills',
    name: 'Awesome Agent Skills',
    description: '跨 Claude、Codex、Gemini 与 Cursor 的社区索引。',
    repositoryUrl: 'https://github.com/VoltAgent/awesome-agent-skills',
    kind: 'community',
  },
]

export const SKILL_MARKETPLACE: SkillMarketplaceEntry[] = [
  {
    id: 'anthropic-frontend-design',
    skillId: 'frontend-design',
    name: 'Frontend Design',
    description: '设计并实现有明确视觉方向、避免模板感的高质量前端界面。',
    category: '设计',
    icon: '◇',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
    ref: 'main',
    path: 'skills/frontend-design',
    license: 'Apache-2.0',
    promptTemplate: '请使用 Frontend Design Skill 完成这个界面。\n\n产品/页面：\n目标用户：\n核心操作：\n视觉参考：\n必须保留：\n希望避免：',
    featured: true,
  },
  {
    id: 'github-anti-ui-slop',
    skillId: 'anti-ui-slop',
    name: 'Anti UI Slop',
    description: '识别并消除廉价 AI 感、过度卡片化、臃肿排版与无意义装饰。',
    category: '设计',
    icon: '◒',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/anti-ui-slop',
    ref: 'main',
    path: 'skills/anti-ui-slop',
    license: 'MIT',
    promptTemplate: '请使用 Anti UI Slop Skill 审视当前界面并直接改进。\n\n界面位置：\n主要问题：\n参考产品：\n不能改变的交互：\n验收标准：',
    featured: true,
  },
  {
    id: 'anthropic-pptx',
    skillId: 'pptx',
    name: 'PPTX',
    description: '从内容结构、版式到可编辑文件，制作并检查完整演示文稿。',
    category: '文档',
    icon: '▣',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/pptx',
    ref: 'main',
    path: 'skills/pptx',
    license: 'Source-available',
    requirement: '需要本机具备文档渲染依赖',
    promptTemplate: '请使用 PPTX Skill 制作一份演示文稿。\n\n主题：\n目标受众：\n演讲时长：\n建议页数：\n视觉风格：\n已有资料：\n最终希望观众记住：',
    featured: true,
  },
  {
    id: 'anthropic-doc-coauthoring',
    skillId: 'doc-coauthoring',
    name: '文档共创',
    description: '通过提纲、受众验证和逐段迭代，共同完成清晰可靠的长文档。',
    category: '文档',
    icon: '✎',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring',
    ref: 'main',
    path: 'skills/doc-coauthoring',
    license: 'Apache-2.0',
    promptTemplate: '请使用文档共创 Skill 和我一起完成这份文档。\n\n文档类型：\n读者：\n目标：\n必须覆盖的信息：\n已有素材：\n语气与篇幅：',
    featured: false,
  },
  {
    id: 'anthropic-docx',
    skillId: 'docx',
    name: 'Word 文档',
    description: '创建、编辑和审阅可交付的 Word 文档，并通过渲染检查版式。',
    category: '文档',
    icon: '▤',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/docx',
    ref: 'main',
    path: 'skills/docx',
    license: 'Source-available',
    requirement: '需要本机具备文档渲染依赖',
    promptTemplate: '请使用 Word 文档 Skill 完成这份文档。\n\n文档用途：\n目标读者：\n已有素材：\n版式要求：\n是否需要批注或修订：\n交付格式：',
    featured: true,
  },
  {
    id: 'anthropic-pdf',
    skillId: 'pdf',
    name: 'PDF',
    description: '读取、生成、填写和检查 PDF，兼顾内容正确性与页面呈现。',
    category: '文档',
    icon: '▧',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    ref: 'main',
    path: 'skills/pdf',
    license: 'Source-available',
    requirement: '需要本机具备 PDF 渲染依赖',
    promptTemplate: '请使用 PDF Skill 处理这份文件。\n\n文件位置：\n需要完成的操作：\n页面或字段范围：\n视觉要求：\n最终交付：',
    featured: true,
  },
  {
    id: 'anthropic-xlsx',
    skillId: 'xlsx',
    name: 'Excel 表格',
    description: '创建、分析和校验工作簿，保留公式、格式与可继续编辑的结构。',
    category: '文档',
    icon: '▦',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/xlsx',
    ref: 'main',
    path: 'skills/xlsx',
    license: 'Source-available',
    requirement: '需要本机具备表格处理依赖',
    promptTemplate: '请使用 Excel 表格 Skill 处理这份工作簿。\n\n数据来源：\n分析目标：\n需要的公式或图表：\n格式要求：\n最终交付：',
    featured: true,
  },
  {
    id: 'anthropic-brand-guidelines',
    skillId: 'brand-guidelines',
    name: '品牌规范',
    description: '从品牌材料提炼可执行的视觉约束，并应用到后续产物。',
    category: '设计',
    icon: '◐',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/brand-guidelines',
    ref: 'main',
    path: 'skills/brand-guidelines',
    license: 'Apache-2.0',
    promptTemplate: '请使用品牌规范 Skill 统一这项工作的视觉表达。\n\n品牌资料：\n使用场景：\n目标受众：\n必须遵守：\n可以探索：\n交付物：',
    featured: false,
  },
  {
    id: 'anthropic-theme-factory',
    skillId: 'theme-factory',
    name: '主题工厂',
    description: '建立协调的颜色、字体和层级体系，并应用到文档或界面。',
    category: '设计',
    icon: '◑',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/theme-factory',
    ref: 'main',
    path: 'skills/theme-factory',
    license: 'Apache-2.0',
    promptTemplate: '请使用主题工厂 Skill 为这项工作建立完整主题。\n\n内容类型：\n品牌气质：\n偏好颜色：\n需要避免：\n应用范围：',
    featured: false,
  },
  {
    id: 'anthropic-canvas-design',
    skillId: 'canvas-design',
    name: '画布设计',
    description: '为海报、封面和静态视觉建立明确构图，并输出成品文件。',
    category: '设计',
    icon: '◩',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/canvas-design',
    ref: 'main',
    path: 'skills/canvas-design',
    license: 'Apache-2.0',
    promptTemplate: '请使用画布设计 Skill 创作这张视觉作品。\n\n用途：\n尺寸：\n核心信息：\n视觉方向：\n素材：\n输出格式：',
    featured: false,
  },
  {
    id: 'anthropic-mcp-builder',
    skillId: 'mcp-builder',
    name: 'MCP Builder',
    description: '把外部服务设计为清晰、安全、可验证的 MCP 工具与资源。',
    category: '自动化',
    icon: '⌘',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/mcp-builder',
    ref: 'main',
    path: 'skills/mcp-builder',
    license: 'Apache-2.0',
    requirement: '需要目标服务 API 或 SDK 资料',
    promptTemplate: '请使用 MCP Builder Skill 构建这项集成。\n\n目标服务：\n核心用户任务：\n认证方式：\n需要暴露的工具：\n安全边界：\n验收方式：',
    featured: true,
  },
  {
    id: 'anthropic-skill-creator',
    skillId: 'skill-creator',
    name: 'Skill Creator',
    description: '把重复工作提炼为边界清晰、可复用、可验证的 Agent Skill。',
    category: '自动化',
    icon: '✦',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
    ref: 'main',
    path: 'skills/skill-creator',
    license: 'Apache-2.0',
    promptTemplate: '请使用 Skill Creator 把这套工作流程沉淀成 Skill。\n\n适用任务：\n触发条件：\n必需步骤：\n可用工具：\n失败边界：\n验收样例：',
    featured: true,
  },
  {
    id: 'anthropic-internal-comms',
    skillId: 'internal-comms',
    name: '团队沟通写作',
    description: '撰写状态更新、公告、FAQ、事故复盘与团队同步材料。',
    category: '文档',
    icon: '⌁',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/internal-comms',
    ref: 'main',
    path: 'skills/internal-comms',
    license: 'Apache-2.0',
    promptTemplate: '请使用团队沟通写作 Skill 起草内容。\n\n类型（公告/周报/FAQ/复盘）：\n接收者：\n背景：\n需要传达的决定：\n下一步行动：\n语气：',
    featured: false,
  },
  {
    id: 'github-autoresearch',
    skillId: 'autoresearch',
    name: 'Auto Research',
    description: '把模糊问题拆成证据链，持续检索、比较来源并形成结论。',
    category: '研究',
    icon: '⌕',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/autoresearch',
    ref: 'main',
    path: 'skills/autoresearch',
    license: 'MIT',
    requirement: '需要联网检索能力',
    promptTemplate: '请使用 Auto Research Skill 调研这个问题。\n\n研究问题：\n决策用途：\n时间范围：\n优先来源：\n需要比较的对象：\n最终交付格式：',
    featured: true,
  },
  {
    id: 'github-review-and-refactor',
    skillId: 'review-and-refactor',
    name: 'Review & Refactor',
    description: '先用证据评审，再按风险与收益排序实施重构，并验证行为不回退。',
    category: '评审',
    icon: '✓',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/review-and-refactor',
    ref: 'main',
    path: 'skills/review-and-refactor',
    license: 'MIT',
    promptTemplate: '请使用 Review & Refactor Skill 评审并改进这部分工作。\n\n范围：\n主要担忧：\n不能改变的行为：\n性能/维护性目标：\n需要运行的验证：',
    featured: true,
  },
  {
    id: 'github-security-review',
    skillId: 'security-review',
    name: 'Security Review',
    description: '围绕信任边界、输入、权限、秘密与依赖进行可复现的安全评审。',
    category: '评审',
    icon: '◈',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/security-review',
    ref: 'main',
    path: 'skills/security-review',
    license: 'MIT',
    promptTemplate: '请使用 Security Review Skill 检查这个系统。\n\n评审范围：\n数据与秘密：\n外部入口：\n权限模型：\n最担心的攻击面：\n希望输出的修复优先级：',
    featured: false,
  },
  {
    id: 'github-documentation-writer',
    skillId: 'documentation-writer',
    name: 'Documentation Writer',
    description: '基于实际行为编写面向用户或开发者的结构化文档与示例。',
    category: '文档',
    icon: '≡',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/documentation-writer',
    ref: 'main',
    path: 'skills/documentation-writer',
    license: 'MIT',
    promptTemplate: '请使用 Documentation Writer Skill 编写文档。\n\n文档主题：\n目标读者：\n他们需要完成的任务：\n已有代码/资料：\n需要包含的示例：\n发布位置：',
    featured: false,
  },
  {
    id: 'anthropic-webapp-testing',
    skillId: 'webapp-testing',
    name: 'Web App Testing',
    description: '通过真实页面交互验证关键路径、视觉状态和常见失败场景。',
    category: '自动化',
    icon: '◎',
    author: 'Anthropic',
    sourceId: 'anthropic-skills',
    repository: 'anthropics/skills',
    repositoryUrl: 'https://github.com/anthropics/skills/tree/main/skills/webapp-testing',
    ref: 'main',
    path: 'skills/webapp-testing',
    license: 'Apache-2.0',
    requirement: '需要 Playwright 或兼容浏览器工具',
    promptTemplate: '请使用 Web App Testing Skill 验收这个页面。\n\n地址：\n核心用户路径：\n测试账号状态：\n重点设备/尺寸：\n必须验证的异常场景：\n期望的验收报告：',
    featured: true,
  },
  {
    id: 'github-chrome-devtools',
    skillId: 'chrome-devtools',
    name: 'Chrome DevTools',
    description: '使用浏览器开发者能力检查页面、网络、性能与交互问题。',
    category: '自动化',
    icon: '↗',
    author: 'GitHub',
    sourceId: 'github-awesome-copilot',
    repository: 'github/awesome-copilot',
    repositoryUrl: 'https://github.com/github/awesome-copilot/tree/main/skills/chrome-devtools',
    ref: 'main',
    path: 'skills/chrome-devtools',
    license: 'MIT',
    requirement: '需要 Chrome DevTools MCP 或兼容浏览器工具',
    promptTemplate: '请使用 Chrome DevTools Skill 操作并检查这个网页。\n\n地址：\n需要完成的操作：\n需要排查的问题：\n是否允许修改页面状态：\n完成标准：',
    featured: false,
  },
]

export function skillMarketplaceRoot(targetRoot?: string): string {
  return targetRoot || join(homedir(), '.turboflux', 'skills')
}

function installDirectory(entry: SkillMarketplaceEntry, targetRoot?: string): string {
  return join(skillMarketplaceRoot(targetRoot), entry.skillId)
}

function installManifestPath(entry: SkillMarketplaceEntry, targetRoot?: string): string {
  return join(installDirectory(entry, targetRoot), '.turboflux-market.json')
}

function enrichedEntry(entry: SkillMarketplaceEntry): SkillMarketplaceEntry {
  return { ...entry, ...MARKETPLACE_DETAILS[entry.id], version: MARKETPLACE_DETAILS[entry.id]?.version || DEFAULT_CATALOG_VERSION }
}

function readInstallManifestAt(entry: SkillMarketplaceEntry, directory: string): SkillMarketplaceInstallManifest | null {
  const markerPath = join(directory, '.turboflux-market.json')
  if (!existsSync(markerPath)) return null
  try {
    const value = JSON.parse(readFileSync(markerPath, 'utf8')) as Partial<SkillMarketplaceInstallManifest>
    if (
      value.schemaVersion !== 2
      || value.id !== entry.id
      || value.skillId !== entry.skillId
      || value.repository !== entry.repository
      || value.ref !== entry.ref
      || typeof value.catalogVersion !== 'string'
      || typeof value.installedAt !== 'string'
      || !Array.isArray(value.files)
    ) return null
    if (value.files.some(file => (
      !file
      || typeof file.path !== 'string'
      || !file.path
      || typeof file.size !== 'number'
      || typeof file.sha256 !== 'string'
    ))) return null
    return value as SkillMarketplaceInstallManifest
  } catch {
    return null
  }
}

function readInstallManifest(entry: SkillMarketplaceEntry, targetRoot?: string): SkillMarketplaceInstallManifest | null {
  return readInstallManifestAt(entry, installDirectory(entry, targetRoot))
}

function inspectInstall(entry: SkillMarketplaceEntry, installed: Set<string>, targetRoot?: string): Pick<SkillMarketplaceEntry,
  'installed' | 'installState' | 'installedAt' | 'installedVersion' | 'fileCount' | 'sizeBytes' | 'canUninstall'> {
  const directory = installDirectory(entry, targetRoot)
  const isLoaded = installed.has(entry.skillId)
  if (!existsSync(directory)) {
    return { installed: isLoaded, installState: isLoaded ? 'local' : 'not-installed', canUninstall: false }
  }
  const manifest = readInstallManifest(entry, targetRoot)
  if (!manifest) {
    const markerExists = existsSync(installManifestPath(entry, targetRoot))
    return { installed: isLoaded || markerExists, installState: markerExists || !existsSync(join(directory, 'SKILL.md')) ? 'broken' : 'local', canUninstall: false }
  }
  const metadata = {
    installed: true,
    installedAt: manifest.installedAt,
    installedVersion: manifest.catalogVersion,
    fileCount: manifest.files.length,
    sizeBytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
    canUninstall: true,
  }
  if (!existsSync(join(directory, 'SKILL.md'))) return { ...metadata, installState: 'broken' }
  let modified = false
  for (const file of manifest.files) {
    let targetPath: string
    try {
      targetPath = safeTargetPath(directory, file.path)
    } catch {
      return { ...metadata, installState: 'broken' }
    }
    if (!existsSync(targetPath)) return { ...metadata, installState: 'broken' }
    try {
      const bytes = readFileSync(targetPath)
      if (bytes.byteLength !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) modified = true
    } catch {
      return { ...metadata, installState: 'broken' }
    }
  }
  if (modified) return { ...metadata, installState: 'modified' }
  if (manifest.catalogVersion !== (MARKETPLACE_DETAILS[entry.id]?.version || DEFAULT_CATALOG_VERSION)) {
    return { ...metadata, installState: 'update-available' }
  }
  return { ...metadata, installState: 'installed' }
}

export function listSkillMarketplace(installedSkillIds: Iterable<string>, options: { targetRoot?: string } = {}): SkillMarketplaceEntry[] {
  const installed = new Set(installedSkillIds)
  return SKILL_MARKETPLACE.map(entry => ({
    ...enrichedEntry(entry),
    ...inspectInstall(entry, installed, options.targetRoot),
  }))
}

function catalogEntry(id: string): SkillMarketplaceEntry {
  const entry = SKILL_MARKETPLACE.find(candidate => candidate.id === id)
  if (!entry) throw new Error(`Skill 市场中不存在该项目：${id}`)
  return enrichedEntry(entry)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw Object.assign(new Error('下载已取消'), { name: 'AbortError', code: 'SKILL_INSTALL_CANCELED' })
}

function githubHeaders(): Record<string, string> {
  const token = process.env.TURBOFLUX_GITHUB_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TurboFlux-Skills-Marketplace',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function fetchGithubJson(
  url: string,
  controller: SkillMarketplaceRequestController,
  options: Pick<SkillMarketplaceInstallOptions, 'signal'> & { onRetry?: (notice: SkillMarketplaceRetryNotice) => void },
): Promise<unknown> {
  return controller.request(url, { headers: githubHeaders() }, {
    transport: 'github-api',
    attempts: GITHUB_API_REQUEST_ATTEMPTS,
    timeoutMs: GITHUB_API_REQUEST_TIMEOUT_MS,
    signal: options.signal,
    onRetry: options.onRetry,
    consume: response => response.json(),
  })
}

function rawRequestTimeout(expectedSize: number): number {
  const transferAllowance = expectedSize > 0 ? Math.ceil(expectedSize / (32 * 1024)) * 1_000 : 0
  return Math.min(10 * 60_000, Math.max(30_000, transferAllowance))
}

async function fetchSkillFileToPath(
  url: string,
  expectedSize: number,
  targetPath: string,
  controller: SkillMarketplaceRequestController,
  options: Pick<SkillMarketplaceInstallOptions, 'signal'> & {
    onRetry?: (notice: SkillMarketplaceRetryNotice) => void
    onFileProgress?: (bytes: number) => void
  },
): Promise<SkillMarketplaceInstallFile> {
  if (!url.startsWith('https://raw.githubusercontent.com/')) throw Object.assign(new Error('Skill 文件来源无效'), { retryable: false })
  return controller.request(url, { headers: { 'User-Agent': 'TurboFlux-Skills-Marketplace' } }, {
    transport: 'github-raw',
    attempts: GITHUB_RAW_REQUEST_ATTEMPTS,
    timeoutMs: rawRequestTimeout(expectedSize),
    signal: options.signal,
    onRetry: options.onRetry,
    consume: (response, signal) => writeResponseToPath(response, signal, expectedSize, targetPath, options),
  })
}

async function writeResponseToPath(
  response: Response,
  signal: AbortSignal,
  expectedSize: number,
  targetPath: string,
  options: Pick<SkillMarketplaceInstallOptions, 'signal'> & { onFileProgress?: (bytes: number) => void },
): Promise<SkillMarketplaceInstallFile> {
  if (!response.body) throw new Error('Skill 文件没有可读取的内容')
  const handle = await open(targetPath, 'w', 0o600)
  const hash = createHash('sha256')
  let size = 0
  try {
    const reader = response.body.getReader()
    while (true) {
      throwIfAborted(options.signal)
      if (signal.aborted) throw new Error('Skill 文件下载超时')
      const chunk = await reader.read()
      if (chunk.done) break
      await handle.write(chunk.value)
      hash.update(chunk.value)
      size += chunk.value.byteLength
      options.onFileProgress?.(size)
    }
  } finally {
    await handle.close()
  }
  if (expectedSize > 0 && size !== expectedSize) {
    throw Object.assign(new Error('Skill 文件大小与仓库记录不一致'), { retryable: true })
  }
  return { path: '', size, sha256: hash.digest('hex') }
}

async function fetchSkillFileFromGithubApiToPath(
  entry: SkillMarketplaceEntry,
  file: GithubContentEntry,
  targetPath: string,
  controller: SkillMarketplaceRequestController,
  options: Pick<SkillMarketplaceInstallOptions, 'signal'> & {
    onRetry?: (notice: SkillMarketplaceRetryNotice) => void
    onFileProgress?: (bytes: number) => void
  },
): Promise<SkillMarketplaceInstallFile> {
  const url = `https://api.github.com/repos/${entry.repository}/contents/${file.path}?ref=${encodeURIComponent(entry.ref)}`
  return controller.request(url, { headers: { ...githubHeaders(), Accept: 'application/vnd.github.raw+json' } }, {
    transport: 'github-api',
    attempts: GITHUB_API_REQUEST_ATTEMPTS,
    timeoutMs: rawRequestTimeout(file.size || 0),
    signal: options.signal,
    onRetry: options.onRetry,
    consume: (response, signal) => writeResponseToPath(response, signal, file.size || 0, targetPath, options),
  })
}

async function collectGithubFiles(
  entry: SkillMarketplaceEntry,
  controller: SkillMarketplaceRequestController,
  options: Pick<SkillMarketplaceInstallOptions, 'signal'> & { onRetry?: (notice: SkillMarketplaceRetryNotice) => void },
): Promise<GithubContentEntry[]> {
  const pending = [entry.path]
  const files: GithubContentEntry[] = []
  let metadataEntries = 0
  while (pending.length > 0) {
    throwIfAborted(options.signal)
    const path = pending.shift()!
    const url = `https://api.github.com/repos/${entry.repository}/contents/${path}?ref=${encodeURIComponent(entry.ref)}`
    const payload = await fetchGithubJson(url, controller, options)
    const rows = Array.isArray(payload) ? payload as GithubContentEntry[] : [payload as GithubContentEntry]
    for (const row of rows) {
      metadataEntries += 1
      if (metadataEntries > EMERGENCY_METADATA_ENTRY_LIMIT) throw new Error('远程目录异常庞大，已停止解析以保护本机资源')
      if (row.type === 'dir') pending.push(row.path)
      if (row.type === 'file') files.push(row)
    }
  }
  if (!files.some(file => file.path === `${entry.path}/SKILL.md`)) throw new Error('远程目录中没有 SKILL.md')
  return files
}

function safeTargetPath(root: string, path: string): string {
  const target = resolve(root, path)
  const relation = relative(root, target)
  if (!relation || relation.startsWith('..') || relation.includes(`..${sep}`)) throw new Error('Skill 文件路径无效')
  return target
}

async function assessResources(files: GithubContentEntry[], targetRoot: string): Promise<SkillMarketplaceResourceAssessment> {
  const totalBytes = files.reduce((sum, file) => sum + Math.max(0, file.size || 0), 0)
  const largestFileBytes = files.reduce((largest, file) => Math.max(largest, Math.max(0, file.size || 0)), 0)
  const requiredDiskBytes = totalBytes + files.length * FILESYSTEM_ENTRY_OVERHEAD_BYTES + 1024 * 1024
  const notes: string[] = []
  let availableDiskBytes = Number.MAX_SAFE_INTEGER
  let availableFileSlots: number | undefined
  try {
    const stats = await statfs(targetRoot)
    availableDiskBytes = Number(stats.bavail) * Number(stats.bsize)
    availableFileSlots = Number(stats.ffree)
  } catch {
    notes.push('无法读取文件系统余量，将由系统写入错误作为最终保护')
  }
  const reserveBytes = availableDiskBytes === Number.MAX_SAFE_INTEGER
    ? 0
    : Math.max(DISK_RESERVE_FLOOR_BYTES, Math.floor(availableDiskBytes * 0.05))
  const remainingDiskBytes = Math.max(0, availableDiskBytes - requiredDiskBytes)
  if (availableDiskBytes !== Number.MAX_SAFE_INTEGER && requiredDiskBytes > Math.max(0, availableDiskBytes - reserveBytes)) {
    throw Object.assign(new Error('可用磁盘空间不足，安装会侵占系统保留空间'), {
      code: 'SKILL_INSTALL_INSUFFICIENT_DISK',
      requiredDiskBytes,
      availableDiskBytes,
    })
  }
  if (availableFileSlots !== undefined && files.length + 1_024 >= availableFileSlots) {
    throw Object.assign(new Error('文件系统可用条目不足，无法安全完成安装'), {
      code: 'SKILL_INSTALL_INSUFFICIENT_FILE_SLOTS',
      requiredFileSlots: files.length,
      availableFileSlots,
    })
  }
  const diskShare = availableDiskBytes === Number.MAX_SAFE_INTEGER ? 0 : requiredDiskBytes / Math.max(1, availableDiskBytes)
  const fileShare = availableFileSlots === undefined ? 0 : files.length / Math.max(1, availableFileSlots)
  const risk = diskShare >= 0.1 || fileShare >= 0.05 ? 'elevated' : 'normal'
  if (risk === 'elevated') notes.push('该 Skill 占用的本机资源比例较高，但仍处于可安全安装范围')
  return {
    fileCount: files.length,
    totalBytes,
    largestFileBytes,
    requiredDiskBytes,
    availableDiskBytes,
    remainingDiskBytes,
    availableFileSlots,
    risk,
    notes,
  }
}

export async function recoverSkillMarketplaceInstallations(targetRoot = skillMarketplaceRoot()): Promise<SkillMarketplaceRecoveryResult> {
  const result: SkillMarketplaceRecoveryResult = {
    removedTemporaryDirectories: 0,
    restoredBackups: [],
    removedBackups: 0,
    warnings: [],
  }
  await mkdir(targetRoot, { recursive: true })
  const entries = await readdir(targetRoot, { withFileTypes: true })
  for (const directory of entries.filter(entry => entry.isDirectory() && entry.name.startsWith('.install-'))) {
    await rm(join(targetRoot, directory.name), { recursive: true, force: true })
    result.removedTemporaryDirectories += 1
  }
  const refreshed = await readdir(targetRoot, { withFileTypes: true })
  for (const catalog of SKILL_MARKETPLACE.map(enrichedEntry)) {
    const backupPrefix = `.backup-${catalog.skillId}-`
    const backups = refreshed
      .filter(entry => entry.isDirectory() && entry.name.startsWith(backupPrefix))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left))
    if (backups.length === 0) continue
    const target = installDirectory(catalog, targetRoot)
    if (existsSync(target)) {
      for (const backup of backups) {
        await rm(join(targetRoot, backup), { recursive: true, force: true })
        result.removedBackups += 1
      }
      continue
    }
    const recoverable = backups.find(backup => {
      const directory = join(targetRoot, backup)
      return Boolean(readInstallManifestAt(catalog, directory) && existsSync(join(directory, 'SKILL.md')))
    })
    if (!recoverable) {
      result.warnings.push(`${catalog.name} 留有无法自动恢复的备份`)
      continue
    }
    await rename(join(targetRoot, recoverable), target)
    result.restoredBackups.push(catalog.skillId)
    for (const backup of backups.filter(name => name !== recoverable)) {
      await rm(join(targetRoot, backup), { recursive: true, force: true })
      result.removedBackups += 1
    }
  }
  return result
}

export async function installMarketplaceSkill(id: string, options: SkillMarketplaceInstallOptions = {}): Promise<SkillMarketplaceEntry> {
  const entry = catalogEntry(id)
  const targetRoot = skillMarketplaceRoot(options.targetRoot)
  const targetDirectory = join(targetRoot, entry.skillId)
  const temporaryDirectory = join(targetRoot, `.install-${entry.skillId}-${Date.now().toString(36)}`)
  const backupDirectory = join(targetRoot, `.backup-${entry.skillId}-${Date.now().toString(36)}`)
  const requestController = options.requestController ?? new SkillMarketplaceRequestController()
  let filesCompleted = 0
  let bytesCompleted = 0
  let filesTotal = 0
  let bytesTotal = 0
  let assessment: SkillMarketplaceResourceAssessment | undefined
  let currentFile: string | undefined
  let transport: SkillMarketplaceTransport | undefined
  let retry: SkillMarketplaceRetryNotice | undefined
  const progress = (phase: SkillMarketplaceInstallPhase, override: Partial<SkillMarketplaceInstallProgress> = {}) => {
    options.onProgress?.({
      phase,
      filesCompleted,
      filesTotal,
      bytesCompleted,
      bytesTotal,
      currentFile,
      transport,
      retry,
      assessment,
      circuits: requestController.snapshots(),
      ...override,
    })
  }
  const onRetry = (notice: SkillMarketplaceRetryNotice) => {
    retry = notice
    transport = notice.transport
    progress(filesTotal > 0 ? 'downloading' : 'resolving')
  }
  throwIfAborted(options.signal)
  await mkdir(targetRoot, { recursive: true })
  if (existsSync(targetDirectory)) {
    const manifest = readInstallManifest(entry, targetRoot)
    if (!manifest) {
      if (!existsSync(installManifestPath(entry, targetRoot))) throw new Error('检测到同名本地 Skill，市场不会覆盖你的文件')
      if (!options.allowOverwrite) throw new Error('该 Skill 的安装记录异常，确认后才能修复')
    }
    const state = inspectInstall(entry, new Set([entry.skillId]), targetRoot).installState
    if ((state === 'modified' || state === 'broken') && !options.allowOverwrite) {
      throw new Error(state === 'modified' ? '该 Skill 已被本地修改，确认后才能重新安装' : '该 Skill 安装不完整，确认后才能修复')
    }
  }
  progress('resolving')
  const files = await collectGithubFiles(entry, requestController, { signal: options.signal, onRetry })
  filesTotal = files.length
  bytesTotal = files.reduce((sum, file) => sum + Math.max(0, file.size || 0), 0)
  assessment = await assessResources(files, targetRoot)
  progress('downloading')
  const installedFiles: SkillMarketplaceInstallFile[] = []
  let previousInstallMoved = false
  let useGithubApiDownloads = false
  try {
    for (const file of files) {
      throwIfAborted(options.signal)
      const relativePath = relative(entry.path, file.path)
      const targetPath = safeTargetPath(temporaryDirectory, relativePath)
      await mkdir(dirname(targetPath), { recursive: true })
      const downloadUrl = file.download_url || `https://raw.githubusercontent.com/${entry.repository}/${entry.ref}/${file.path}`
      currentFile = relativePath
      retry = undefined
      const completedBeforeFile = bytesCompleted
      let installedFile: SkillMarketplaceInstallFile | undefined
      if (!useGithubApiDownloads) {
        transport = 'github-raw'
        progress('downloading')
        try {
          installedFile = await fetchSkillFileToPath(downloadUrl, file.size || 0, targetPath, requestController, {
            signal: options.signal,
            onRetry,
            onFileProgress: size => {
              bytesCompleted = completedBeforeFile + size
              progress('downloading')
            },
          })
        } catch (error) {
          throwIfAborted(options.signal)
          useGithubApiDownloads = true
          bytesCompleted = completedBeforeFile
        }
      }
      if (!installedFile) {
        transport = 'github-api'
        retry = undefined
        progress('downloading')
        installedFile = await fetchSkillFileFromGithubApiToPath(entry, file, targetPath, requestController, {
          signal: options.signal,
          onRetry,
          onFileProgress: size => {
            bytesCompleted = completedBeforeFile + size
            progress('downloading')
          },
        })
        bytesCompleted = completedBeforeFile + installedFile.size
      }
      installedFiles.push({ ...installedFile, path: relativePath })
      filesCompleted += 1
      bytesCompleted = installedFiles.reduce((sum, installed) => sum + installed.size, 0)
      progress('downloading')
    }
    currentFile = undefined
    retry = undefined
    progress('verifying')
    if (!existsSync(join(temporaryDirectory, 'SKILL.md'))) throw new Error('下载结果缺少 SKILL.md')
    const installedAt = new Date().toISOString()
    const manifest: SkillMarketplaceInstallManifest = {
      schemaVersion: 2,
      id: entry.id,
      skillId: entry.skillId,
      repository: entry.repository,
      ref: entry.ref,
      catalogVersion: entry.version || DEFAULT_CATALOG_VERSION,
      installedAt,
      files: installedFiles,
    }
    await writeFile(join(temporaryDirectory, '.turboflux-market.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
    progress('replacing')
    if (existsSync(targetDirectory)) {
      await rename(targetDirectory, backupDirectory)
      previousInstallMoved = true
    }
    await rename(temporaryDirectory, targetDirectory)
    if (previousInstallMoved) await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined)
    progress('completed')
    return {
      ...entry,
      installed: true,
      installState: 'installed',
      installedAt,
      installedVersion: manifest.catalogVersion,
      fileCount: installedFiles.length,
      sizeBytes: installedFiles.reduce((sum, file) => sum + file.size, 0),
      canUninstall: true,
    }
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    if (previousInstallMoved && !existsSync(targetDirectory) && existsSync(backupDirectory)) {
      await rename(backupDirectory, targetDirectory)
    }
    throw error
  }
}

export async function uninstallMarketplaceSkill(id: string, options: { targetRoot?: string } = {}): Promise<SkillMarketplaceEntry> {
  const entry = catalogEntry(id)
  const targetRoot = skillMarketplaceRoot(options.targetRoot)
  const targetDirectory = installDirectory(entry, targetRoot)
  if (!existsSync(targetDirectory)) return { ...entry, installed: false, installState: 'not-installed', canUninstall: false }
  if (!readInstallManifest(entry, targetRoot)) throw new Error('这不是由 Skills 市场管理的安装，无法自动卸载')
  await rm(targetDirectory, { recursive: true, force: true })
  return { ...entry, installed: false, installState: 'not-installed', canUninstall: false }
}
