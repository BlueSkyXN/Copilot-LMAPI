# 语言模型聊天提供者 (Language Model Chat Provider)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)

## 基本介绍
本文介绍了如何通过 `LanguageModelChatProvider` API 将自定义语言模型接入 VS Code。这允许开发者贡献自己的模型，使其出现在 VS Code 的聊天模型选择列表中。文章详细说明了提供者的职责，包括发现和准备模型元数据、处理聊天请求、流式传输响应（支持文本、工具调用等）以及实现令牌计数功能。这对于希望集成企业内部模型或第三方 AI 服务的开发者至关重要。

## 中文翻译

### 语言模型聊天提供者 API
该 API “使你能够将自己的语言模型贡献给 Visual Studio Code 中的聊天”。目前该功能仅限 GitHub Copilot 个人版用户使用。

**提供者的职责**
- **发现和准备模型**：通过 `provideLanguageModelChatInformation` 返回模型元数据（如 ID、名称、能力、上下文限制等）。
- **处理请求**：实现 `provideLanguageModelChatResponse` 以接收消息并流式返回响应。
- **令牌计数**：实现 `provideTokenCount` 为模型提供准确的 token 估算。

**实现流程**
1. **注册提供者**：在 `package.json` 的 `contributes.languageModelChatProviders` 中定义 `vendor` 和 `displayName`。
2. **激活扩展**：调用 `vscode.lm.registerLanguageModelChatProvider` 注册提供者实例。
3. **实现接口**：
    - `provideLanguageModelChatInformation`：定义模型的能力（如是否支持图像、工具调用）。
    - `provideLanguageModelChatResponse`：将 `LanguageModelChatRequestMessage` 转换为目标 API 格式，并使用 `progress.report` 返回片段。
    - `provideTokenCount`：返回文本的 token 数量。

## 原文整理
# Language Model Chat Provider

The Language Model Chat Provider API enables you to contribute your own language models to chat in Visual Studio Code.

### Language model information

```typescript
interface LanguageModelChatInformation {
    readonly id: string;
    readonly name: string;
    readonly family: string;
    readonly version: string;
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
    readonly capabilities: {
        readonly imageInput?: boolean;
        readonly toolCalling?: boolean | number;
    };
}
```

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
    // Convert and send to your API
    progress.report(new LanguageModelTextPart("Response content..."));
}
```
走向管理界面：
```json
"managementCommand": "my-provider.manage"
```
允许用户配置 API 密钥或其他设置。
