# 语言模型聊天提供者 (Language Model Chat Provider)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## 基本介绍
本文介绍了如何通过 `LanguageModelChatProvider` API 将自定义语言模型接入 VS Code。这允许开发者贡献自己的模型，使其出现在 VS Code 的聊天模型选择列表中。此 API 自 `@types/vscode@1.110.0` 起已成为稳定 API。文章详细说明了提供者的职责，包括发现和准备模型元数据、处理聊天请求、流式传输响应（支持文本、工具调用、数据部分等）以及实现令牌计数功能。这对于希望集成企业内部模型或第三方 AI 服务的开发者至关重要。

## 中文翻译

### 语言模型聊天提供者 API
该 API “使你能够将自己的语言模型贡献给 Visual Studio Code 中的聊天”。此 API 现已稳定（`@types/vscode@1.110.0`+），不再需要 proposed API 激活。

**提供者的职责**
- **发现和准备模型**：通过 `provideLanguageModelChatInformation` 返回 `LanguageModelChatInformation` 对象，声明模型元数据（如 ID、名称、能力、最大输出 token、上下文限制等）。
- **处理请求**：实现 `provideLanguageModelChatResponse` 以接收 `LanguageModelChatRequestMessage` 数组并流式返回 `LanguageModelResponsePart` 响应。
- **令牌计数**：实现 `provideTokenCount` 为模型提供准确的 token 估算。

**实现流程**
1. **注册提供者**：在 `package.json` 的 `contributes.languageModelChatProviders` 中定义 `vendor` 和 `displayName`。
2. **激活扩展**：调用 `vscode.lm.registerLanguageModelChatProvider` 注册提供者实例。
3. **实现接口**：
    - `provideLanguageModelChatInformation`：返回 `LanguageModelChatInformation`，定义模型的能力（`imageInput`、`toolCalling`）、`maxOutputTokens` 等。
    - `provideLanguageModelChatResponse`：将 `LanguageModelChatRequestMessage`（含 `DataPart`）转换为目标 API 格式，并使用 `progress.report` 返回 `LanguageModelResponsePart` 片段。
    - `provideTokenCount`：返回文本的 token 数量。

## 原文整理
# Language Model Chat Provider

The Language Model Chat Provider API enables you to contribute your own language models to chat in Visual Studio Code. This API is now stable as of `@types/vscode@1.110.0`.

### LanguageModelChatInformation 接口 (稳定)

```typescript
interface LanguageModelChatInformation {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: LanguageModelChatCapabilities;
}
```

### LanguageModelChatCapabilities 接口

```typescript
interface LanguageModelChatCapabilities {
    readonly imageInput?: boolean;
    readonly toolCalling?: boolean | number;
}
```

- `imageInput`: 声明模型是否支持图片输入（通过 `LanguageModelDataPart.image()`）
- `toolCalling`: 声明模型是否支持工具调用；`number` 类型时表示支持的最大并行工具调用数量

### LanguageModelChatRequestMessage 接口

提供者在 `provideLanguageModelChatResponse` 中接收到的请求消息类型：

```typescript
interface LanguageModelChatRequestMessage {
    readonly role: LanguageModelChatMessageRole;
    readonly content: ReadonlyArray<LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart>;
    readonly name?: string;
}
```

- `content` 数组现在包含 `LanguageModelDataPart`（稳定），支持图片等多模态输入

### Register the provider

In `package.json`:
```json
"contributes": {
    "languageModelChatProviders": [
        {
            "vendor": "my-provider",
            "displayName": "My Provider"
        }
    ]
}
```

In `extension.ts`:
```typescript
export function activate(context: vscode.ExtensionContext) {
    vscode.lm.registerLanguageModelChatProvider('my-provider', new SampleChatModelProvider());
}
```

### Handle chat requests

```typescript
async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: readonly LanguageModelChatRequestMessage[],
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken
): Promise<void> {
    // Convert LanguageModelChatRequestMessage to your API format
    // LanguageModelChatRequestMessage.content contains:
    //   LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart | LanguageModelDataPart
    progress.report(new LanguageModelTextPart("Response content..."));
}
```
走向管理界面：
```json
"managementCommand": "my-provider.manage"
```
允许用户配置 API 密钥或其他设置。
