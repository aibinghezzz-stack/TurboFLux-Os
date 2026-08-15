# TurboFlux

[English](README.md) | 中文

TurboFlux（`tf`）是一个开源的本地 Agent 工作台：终端 TUI、桌面应用与共享内核三位一体，用你自己的模型密钥完成真实工作——研究、写作、开发、浏览器自动化等等。

## 组件

| 包 | 说明 |
| --- | --- |
| [`@turboflux/agent-core`](packages/agent-core) | 版本化共享内核：Agent 运行时、工具、Skills、MCP、Work Packs |
| [`apps/desktop`](apps/desktop) | 原生 Electron 桌面工作台，支持浏览器与电脑操控 |
| 终端 TUI | 基于 Ink 的终端界面（`turboflux` / `tf`） |

## 运行

### 运行 TUI

安装 `Node.js` 后：

```sh
npx turboflux
```

在当前目录启动终端界面。首次使用先运行 `turboflux setup` 配置模型服务。

### 运行桌面应用

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run dev:desktop
```

### 从源码运行

```sh
git clone https://github.com/aibinghezzz-stack/TurboFLux-Os.git
cd TurboFLux-Os
npm install
npm run build
npm run dev
```

## 模型

TurboFlux 支持任意 OpenAI 兼容 API——OpenAI、Anthropic、DeepSeek、Kimi、GLM、OpenRouter 或你自己的端点。在本机配置服务商与 API Key，一切都在你的机器上运行。

## 社区与支持

- 欢迎通过 [Issues](https://github.com/aibinghezzz-stack/TurboFLux-Os/issues) 提交反馈与问题。
- 创建插件或 Work Pack 并与社区分享。

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发

- 终端 TUI：`npm run dev:cli`
- 桌面应用：`npm run dev:desktop`
- 测试：`npm test`
- 类型检查：`npm run type-check`

## 许可

[MIT](LICENSE)
