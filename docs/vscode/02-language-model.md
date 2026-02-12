# 语言模型 API (Language Model API)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/language-model](https://code.visualstudio.com/api/extension-guides/ai/language-model)

## 基本介绍
本文详细介绍了如何在 VS Code 扩展中使用语言模型 API（Language Model API）。该 API 允许开发者将 AI 驱动的功能和自然语言处理集成到扩展中，不仅限于聊天扩展，还可以用于编辑器重命名、调试器、自定义命令或任务等。文章涵盖了构建 Prompt、选择和发送请求到模型、以及处理流式响应的核心步骤，并提供了关于模型选择、频率限制和测试的最佳实践建议。

## 中文翻译

### VS Code 语言模型 API
VS Code 语言模型 API 允许创作者将“AI 驱动的功能和自然语言处理”集成到扩展中。开发人员使用 `LanguageModelChatMessage` 或 `prompt-tsx` 库来“构建他们的 Prompt”，尽管“语言模型 API 不支持使用系统消息”。

要执行请求，请使用 `selectChatModels` 通过“供应商 (vendor)、ID、家族 (family) 或版本 (version)”进行过滤。支持的选项包括 “gpt-4o、gpt-4o-mini、o1、o1-mini [以及] claude-3.5-sonnet”。`sendRequest` 方法提供“基于流式”的响应，允许通过异步迭代器“连续报告结果和进度”。模型对象包含 `maxInputTokens` 属性；例如，GPT-4o 目前有 “64K” 的限制。

扩展应捕获 `LanguageModelError` 以处理“配额限制”或缺失的“用户同意”。由于 AI 输出是“非确定性的”，开发人员应避免对模型本身进行“集成测试”。在发布之前，请确保符合“微软 AI 工具和实践指南”以及 Copilot 的“可接受开发和使用政策”。

### 关键步骤
1. **构建语言模型 Prompt**：使用 `LanguageModelChatMessage` 或 `prompt-tsx`。
2. **发送语言模型请求**：通过 `vscode.lm.selectChatModels` 选择模型，然后调用 `sendRequest`。
3. **解释响应**：处理 `LanguageModelChatResponse` 中的流式文本片段。

## 原文整理
# Language Model API

The VS Code Language Model API allows creators to "integrate AI-powered features and natural language processing" into extensions. Developers "craft their prompt" using `LanguageModelChatMessage` or the `prompt-tsx` library, though "the Language Model API doesn't support the use of system messages."

To execute a request, use `selectChatModels` to filter by "vendor, id, family, or version." Supported options include "gpt-4o, gpt-4o-mini, o1, o1-mini, [and] claude-3.5-sonnet." The `sendRequest` method provides a "streaming-based" response, allowing for "reporting results and progress continuously" via an async iterator. Model objects include a `maxInputTokens` attribute; for instance, GPT-4o currently has a "64K" limit.

Extensions should catch `LanguageModelError` to handle "quota limits" or missing "user consent." Because AI output is "nondeterministic," developers should avoid "integration tests" for the model itself. Before publishing, ensure compliance with "Microsoft AI tools and practices guidelines" and the "acceptable development and use policy" for Copilot.

## Build the language model prompt

To interact with a language model, extensions should first craft their prompt, and then send a request to the language model. You can use prompts to provide instructions to the language model on the broad task that you're using the model for. Prompts can also define the context in which user messages are interpreted.

The Language Model API supports two types of messages when building the language model prompt:

- **User** - used for providing instructions and the user's request
- **Assistant** - used for adding the history of previous language model responses as context to the prompt

> **Note**: Currently, the Language Model API doesn't support the use of system messages.

## Send the language model request

Once you've built the prompt for the language model, you first select the language model you want to use with the `selectChatModels` method. This method returns an array of language models that match the specified criteria. If you are implementing a chat participant, we recommend that you instead use the model that is passed as part of the `request` object in your chat request handler.

```typescript
try {
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
    const request = model.sendRequest(craftedPrompt, {}, token);
} catch (err) {
    if (err instanceof vscode.LanguageModelError) {
        console.log(err.message, err.code, err.cause);
    }
}
```

## Interpret the response

After you've sent the request, you have to process the response from the language model API. The response (`LanguageModelChatResponse`) from the Language Model API is streaming-based.

```typescript
try {
    for await (const fragment of chatResponse.text) {
        await textEditor.edit(edit => {
            const lastLine = textEditor.document.lineAt(textEditor.document.lineCount - 1);
            const position = new vscode.Position(lastLine.lineNumber, lastLine.text.length);
            edit.insert(position, fragment);
        });
    }
} catch (err) {
    // handle stream error
}
```
