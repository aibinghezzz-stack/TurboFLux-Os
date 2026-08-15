# TurboFlux

**English** | [中文](README.zh.md)

TurboFlux 是一个开源的本地 Agent 工作台——在终端里、在桌面上，把「交代任务」变成「拿到成果」。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-20242a?logo=node.js)](https://nodejs.org)
[![macOS](https://img.shields.io/badge/macOS-13%2B-brightgreen)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-20242a?logo=typescript)](https://www.typescriptlang.org)

---

## 为什么是 TurboFlux

Agent 工具很多，但 TurboFlux 关心的只有一件事：**任务从描述到完成，全程可信、可控、可追溯**。

- 🗂️ **任务工作台** — 任务以语义阶段推进：正在做什么、已取得什么进展、是否需要你介入、最终交付了什么。不是一堆工具调用的日志，而是清晰的工作状态。
- 🌐 **浏览器操控** — 让 Agent 打开网页、填写表单、走完流程、验证结果、下载产物。真机操作，不是模拟。
- 🖥️ **电脑操控** — 基于 macOS 辅助功能，Agent 可以直接操作你的原生应用：Keynote、浏览器、终端……
- 🧩 **能力扩展** — Skills、Plugins、MCP 服务器、自动化任务、Work Packs，全部本机安装、本机运行。
- 🔑 **模型自由** — 自带密钥，接入 OpenAI、Anthropic、DeepSeek、Kimi、GLM、OpenRouter 或任意 OpenAI 兼容端点，随时切换。

## 快速开始

### 终端 TUI

```sh
# 安装 Node.js 后，一行命令启动
npx turboflux
```

首次使用先运行 `turboflux setup` 配置你的模型服务。

### 桌面应用

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run dev:desktop
```

### 从源码构建

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run build
npm run dev
```

## 它能做什么

| 场景 | 效果 |
| --- | --- |
| 「调研一下 X 领域的最新进展，整理成报告」 | 搜索、阅读、交叉验证、输出带引用的报告 |
| 「帮我把这个想法做成一个可运行的网页」 | 编码、预览、迭代，直接看到成果 |
| 「整理这个文件夹，把重复文件归类」 | 分析、移动、生成清单 |
| 「每天 9 点检查我的项目依赖更新」 | 定时自动化，产出变更摘要 |

## 架构

```
        ┌─────────────────────────────────────────┐
        │              TurboFlux Desktop          │  Electron
        └───────────────────┬─────────────────────┘
                            │ 通过受控导出面消费
        ┌───────────────────▼─────────────────────┐
        │           @turboflux/agent-core         │  共享内核
        │   agent runtime · tools · skills · mcp  │
        └───────────────────┬─────────────────────┘
                            │ 同一内核
        ┌───────────────────▼─────────────────────┐
        │              TurboFlux TUI              │  终端
        └─────────────────────────────────────────┘
```

| 组件 | 说明 |
| --- | --- |
| [`@turboflux/agent-core`](packages/agent-core) | 版本化共享内核：Agent 运行时、工具、Skills、MCP、Work Packs |
| [`apps/desktop`](apps/desktop) | 原生 Electron 桌面工作台，支持浏览器与电脑操控 |
| 终端 TUI | 基于 Ink 的终端界面（`turboflux` / `tf`） |

桌面端与终端共享同一内核，通过受控导出面（workbench / runtime / contracts / extensions）消费，互不侵入。

## 模型配置

支持任意 OpenAI 兼容 API，在你的本机配置：

```sh
turboflux setup api        # 配置 API 连接
turboflux setup persona    # 配置回复风格
turboflux setup approval   # 配置审批策略
```

## 开发

```bash
npm run dev:cli          # 终端 TUI 开发模式
npm run dev:desktop      # 桌面应用开发模式
npm run type-check       # 内核 + TUI 类型检查
npm test                 # 内核 + TUI 测试
npm run type-check:desktop
npm run test:desktop
```

## 社区与支持

- 通过 [Issues](https://github.com/aibinghezzz-stack/TurboFLux-Os/issues) 提交反馈与问题
- 创建插件或 Work Pack，与社区分享

## 贡献

TurboFlux 由核心技术团队开发，暂不接受外部 Pull Request；欢迎通过 Issue 与我们交流。

- [CONTRIBUTING.md](CONTRIBUTING.md)（English）
- [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)（中文）

## 许可

[MIT](LICENSE) © TurboFlux
