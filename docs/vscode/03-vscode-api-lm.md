# VS Code API 引用 - 语言模型 (vscode.lm)

## 原始参考来源
[https://code.visualstudio.com/api/references/vscode-api#lm](https://code.visualstudio.com/api/references/vscode-api#lm)

## 基本介绍
本文提供了 `vscode.lm` 命名空间的 API 参考指南。`vscode.lm` 命名空间处理与语言模型相关的功能，包括获取可用模型、发送请求以及注册和调用语言模型工具。本文详细列出了核心方法、接口和枚举，是开发 AI 扩展时查询具体 API 签名和成员的参考手册。

## 中文翻译

### `vscode.lm` 命名空间
`vscode.lm` 命名空间处理“语言模型相关功能”。

#### 模型获取
要获取模型，请使用 `selectChatModels` 通过“选择器”选择聊天模型。这将返回 `LanguageModelChat` 实例，允许扩展调用 `sendRequest`。`onDidChangeChatModels` 事件在“可用聊天模型集合发生变化”时触发。

#### 聊天消息与错误
通信涉及“文本和 prompt-tsx 部分”。信息通过“用户消息传递给 LanguageModelChat”，或存储在 “ChatResult.metadata” 中。

### 核心成员
- **`selectChatModels`**: 获取匹配特定条件的可用语言模型。
- **`registerTool`**: 注册一个可供语言模型调用的工具。
- **`invokeTool`**: 手动调用已注册的工具。
- **`LanguageModelChat`**: 代表一个语言模型实例，包含 `sendRequest` 方法。
- **`LanguageModelError`**: 处理语言模型特定的错误，如 NotFound, NoPermissions, Blocked 等。

## 原文整理
# vscode.lm API Reference

The `vscode.lm` namespace handles "language model related functionality."

### Models
To acquire models, "select chat models by a [selector]" using `selectChatModels`. This returns `LanguageModelChat` instances, which allow extensions to "sendRequest." The `onDidChangeChatModels` event triggers "when the set of available chat models changes."

### Chat Messages and Errors
Communication involves "text- and prompt-tsx-parts." Information is "passed along to the LanguageModelChat via a user message" or stored in "ChatResult.metadata."

### Namespace `vscode.lm`

#### `lm.selectChatModels`
- Signature: `selectChatModels(selector?: LanguageModelChatSelector): Thenable<LanguageModelChat[]>`
- Get models that match specific criteria (vendor, id, family, version).

#### `lm.registerTool`
- Signature: `registerTool<T>(name: string, tool: LanguageModelTool<T>): Disposable`
- Registers a tool that can be used by the language model.

#### `lm.invokeTool`
- Signature: `invokeTool(name: string, options: LanguageModelToolInvocationOptions<object>, token?: CancellationToken): Thenable<LanguageModelToolResult>`

### Classes & Interfaces

#### `LanguageModelChat`
- `sendRequest(messages: LanguageModelChatMessage[], options?: LanguageModelChatRequestOptions, token?: CancellationToken): Thenable<LanguageModelChatResponse>`
- `countTokens(text: string | LanguageModelChatMessage, token?: CancellationToken): Thenable<number>`
- Properties: `family`, `id`, `maxInputTokens`, `name`, `vendor`, `version`.

#### `LanguageModelChatMessage`
- `static User(content: string | Array<...>, name?: string): LanguageModelChatMessage`
- `static Assistant(content: string | Array<...>, name?: string): LanguageModelChatMessage`

#### `LanguageModelError`
- Error codes: `Blocked`, `NoPermissions`, `NotFound`.
- Use `err.code` to determine specific failure causes.
