# 聊天参与者 (Chat Participants)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/chat](https://code.visualstudio.com/api/extension-guides/ai/chat)

## 基本介绍
本文介绍了如何创建 VS Code 聊天参与者（Chat Participants）。聊天参与者是专门的助手，用户可以通过 `@-mention` 语法在聊天界面中调用他们。文章详细说明了参与者的工作机制，即接收用户 Prompt 并编排任务以返回响应。内容涵盖了在 `package.json` 中注册参与者、实现请求处理器、使用斜杠命令（Slash commands）、注册后续问题（Follow-ups）以及实现参与者自动检测等功能，并提供了关于命名规范和成功度衡量的指导。

## 中文翻译

### VS Code 聊天参与者
聊天参与者是“专门的助手，使用户能够通过领域专家扩展 VS Code 中的聊天”。用户通过“@-mentioning”调用他们，参与者负责处理用户的自然语言提示。

**创建聊天参与者**
1. **注册参与者**：在 `package.json` 的 `contributes.chatParticipants` 中定义 `id`、`name`、`fullName` 和 `description`。
2. **实现请求处理器 (Request Handler)**：使用 `vscode.chat.createChatParticipant` 创建参与者。处理器接收 `request`、`context` 和 `stream`。
3. **确定用户意图**：通过 `request.command`（斜杠命令）或使用语言模型分析 Prompt 文本。
4. **返回响应**：使用 `stream` 发送 Markdown、代码块、按钮、文件树或进度消息。

**关键功能**
- **斜杠命令 (Slash commands)**：通过 `/` 语法提供的功能快捷方式，如 `/explain` 或 `/fix`。
- **后续请求 (Follow-ups)**：在响应后提供建议的后续问题。
- **历史记录访问**：参与者可以访问当前会话中提及过它的消息历史。
- **工具调用**：参与者可以调用已注册的语言模型工具来执行具体任务。

## 原文整理
# Chat Participants

Chat participants are specialized assistants that enable users to extend chat in VS Code with domain-specific experts. Users invoke a chat participant by @-mentioning it, and the participant is then responsible for handling the user's natural language prompt.

### 1. Register the chat participant

Register it in your `package.json`:

```json
"contributes": {
    "chatParticipants": [
        {
            "id": "chat-sample.cat",
            "name": "cat",
            "fullName": "Cat",
            "description": "Meow! What can I teach you?",
            "isSticky": true,
            "commands": [
                {
                    "name": "teach",
                    "description": "Explain a computer science concept"
                }
            ]
        }
    ]
}
```

### 2. Implement a request handler

```typescript
export function activate(context: vscode.ExtensionContext) {
    const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
        if (request.command === 'teach') {
            stream.progress('Thinking...');
            stream.markdown('Here is a concept for you...');
            return { metadata: { command: 'teach' } };
        }

        // Use the model passed in the request
        const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
        // ... call model and stream response
    };

    const cat = vscode.chat.createChatParticipant('chat-sample.cat', handler);
    cat.iconPath = vscode.Uri.joinPath(context.extensionUri, 'cat.jpeg');
}
```

### Supported output types
- **Markdown**: `stream.markdown('text')`
- **Code block**: Use markdown syntax with backticks.
- **Button**: `stream.button({ command: 'id', title: 'label' })`
- **File tree**: `stream.filetree(tree, baseUri)`
- **Progress**: `stream.progress('message')`
- **Reference**: `stream.reference(uri)`
