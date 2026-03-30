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
- `static User(content: string | Array<LanguageModelInputPart>, name?: string): LanguageModelChatMessage`
- `static Assistant(content: string | Array<LanguageModelInputPart>, name?: string): LanguageModelChatMessage`
- `content` 属性类型为 `Array<LanguageModelInputPart>`，即 `LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart` 的联合类型。

#### `LanguageModelDataPart` (稳定 — @types/vscode@1.110.0+)
- 用于在消息中传递结构化数据（图片、JSON、文本文件等）。
- 工厂方法:
  - `static image(data: Uint8Array, mimeType: string): LanguageModelDataPart` — 从原始字节创建图片数据部分
  - `static json(value: unknown, mimeType?: string): LanguageModelDataPart` — 创建 JSON 数据部分
  - `static text(value: string, mimeType: string): LanguageModelDataPart` — 创建文本数据部分
- 属性: `data: Uint8Array`, `mimeType: string`

#### 类型别名 (新增 — @types/vscode@1.110.0+)
- **`LanguageModelInputPart`**: `LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart` — 可作为消息输入内容的所有 part 类型联合
- **`LanguageModelResponsePart`**: `LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelDataPart` — 流式响应中可能返回的所有 part 类型联合（现在包含 `DataPart`）

#### `LanguageModelChatResponse`
- `stream` 异步迭代器现在产出 `LanguageModelResponsePart`（即 `LanguageModelTextPart | LanguageModelToolCallPart | LanguageModelDataPart`），流式响应中可能收到 `DataPart`。

#### `LanguageModelError`
- Error codes: `Blocked`, `NoPermissions`, `NotFound`.
- Use `err.code` to determine specific failure causes.

### 模型提供者 API (稳定 — @types/vscode@1.110.0+)

#### `lm.registerLanguageModelChatProvider`
- Signature: `registerLanguageModelChatProvider(id: string, provider: LanguageModelChatProvider): Disposable`
- 注册自定义语言模型提供者，使其出现在 VS Code 聊天模型选择列表中。此 API 现已稳定。

#### `LanguageModelChatInformation`
- 提供者通过此接口声明模型元数据:
  - `id: string`, `name: string`, `family: string`, `version: string`
  - `maxInputTokens: number`, `maxOutputTokens: number`
  - `capabilities: LanguageModelChatCapabilities`

#### `LanguageModelChatCapabilities`
- `imageInput?: boolean` — 模型是否支持图片输入
- `toolCalling?: boolean | number` — 模型是否支持工具调用（`number` 表示支持的最大并行工具调用数）

### MCP 服务器 API (新增 — @types/vscode@1.110.0+)

#### `lm.registerMcpServerDefinitionProvider`
- Signature: `registerMcpServerDefinitionProvider(provider: McpServerDefinitionProvider): Disposable`
- 注册 MCP (Model Context Protocol) 服务器定义提供者，允许扩展动态提供 MCP 服务器定义。

#### `McpStdioServerDefinition`
- 通过 stdio 通信的 MCP 服务器定义。属性包括 `command`, `args`, `env`, `cwd` 等。

#### `McpHttpServerDefinition`
- 通过 HTTP (Streamable HTTP / SSE) 通信的 MCP 服务器定义。属性包括 `uri`, `headers` 等。
