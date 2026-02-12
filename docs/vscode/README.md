# VS Code AI 扩展文档索引

此目录包含针对 Visual Studio Code AI 扩展开发的整理文档。所有内容均同步自官方文档，并经过中文摘要与核心代码块的二次整理。

## 核心文档指南

| 编号 | 文档名称 | 简介 | 原始参考链接 |
| :--- | :--- | :--- | :--- |
| 01 | [AI 扩展性概览](./01-ai-extensibility-overview.md) | 了解 VS Code AI 扩展生态，对比 Chat、Tools、LM API 和 MCP。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview) |
| 02 | [语言模型 API](./02-language-model.md) | 学习如何在扩展中直接调用 Copilot 语言模型。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/language-model) |
| 03 | [VS Code API 引用 - lm](./03-vscode-api-lm.md) | `vscode.lm` 命名空间的 API 签名及核心接口参考。 | [Link](https://code.visualstudio.com/api/references/vscode-api#lm) |
| 04 | [语言模型工具 (Tools)](./04-tools.md) | 定义和注册可供 AI 代理自动调用的工具。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/tools) |
| 05 | [聊天参与者 (Chat Participants)](./05-chat.md) | 构建可被 `@` 调用的聊天机器人，自定义聊天交互流程。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/chat) |
| 06 | [聊天参与者教程](./06-chat-tutorial.md) | 手把手教你创建一个名为 "Code Tutor" 的聊天机器人。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial) |
| 07 | [语言模型 API 教程](./07-language-model-tutorial.md) | 实战演练：使用 LM API 为代码生成实时批注。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/language-model-tutorial) |
| 08 | [自定义聊天模型提供者](./08-language-model-chat-provider.md) | 如何将自建或第三方语言模型接入 VS Code 聊天界面。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) |
| 09 | [prompt-tsx 库使用指南](./09-prompt-tsx.md) | 使用 TSX 组件化构建高性能、高可维护性的提示词。 | [Link](https://code.visualstudio.com/api/extension-guides/ai/prompt-tsx) |

## 项目背景
本工程 **Copilot-LMAPI** 旨在桥接 VS Code 的 `Language Model API` 与 OpenAI 兼容的 HTTP 接口，使标准客户端能够利用 Copilot 的强大能力。上述文档为本项目的核心技术依赖和扩展实现提供了官方参考。
