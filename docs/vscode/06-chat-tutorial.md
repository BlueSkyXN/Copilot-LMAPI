# 聊天参与者教程 (Chat Participant Tutorial)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial](https://code.visualstudio.com/api/extension-guides/ai/chat-tutorial)

## 基本介绍
本教程引导开发者创建一个名为 "Code Tutor" 的 VS Code 扩展。这个聊天参与者能够为编程概念提供解释和练习题。教程涵盖了从项目初始化、在 `package.json` 中注册参与者、编写高质量 Prompt、实现请求处理器到处理消息历史（以提供对话上下文）以及添加斜杠命令（如 `/exercise`）的完整流程。这是学习如何将 GitHub Copilot 聊天体验集成到自定义扩展中的最佳实践指南。

## 中文翻译

### 创建聊天参与者教程
本指南解释了如何“创建一个集成了 GitHub Copilot 聊天体验的 Visual Studio Code 扩展”。

**核心步骤**
1. **设置项目**：使用 `yo code` 生成 TypeScript 扩展项目。
2. **注册聊天参与者**：在 `package.json` 中添加 `chatParticipants` 贡献点。
3. **编写 Prompt**：在 `extension.ts` 中定义 `BASE_PROMPT`，规定参与者的角色（如：一个不直接给出答案，而是引导学生思考的导师）。
4. **实现请求处理器**：
    - 使用 `vscode.LanguageModelChatMessage.User` 初始化消息数组。
    - 将用户的 Prompt (`request.prompt`) 加入数组。
    - 调用 `request.model.sendRequest` 并流式返回响应。
5. **添加消息历史**：通过 `context.history` 获取之前的对话，将其转换为 `Assistant` 消息加入 Prompt，使对话具有连贯性。
6. **添加斜杠命令**：注册 `/exercise` 命令，当用户使用该命令时切换到专门的 `EXERCISES_PROMPT`。

## 原文整理
# Build a Chat Participant Tutorial

This guide explains how to "create a Visual Studio Code extension that integrates with the GitHub Copilot Chat experience."

### Step 2: Register a Chat participant

```json
"contributes": {
    "chatParticipants": [
        {
            "id": "chat-tutorial.code-tutor",
            "fullName": "Code Tutor",
            "name": "tutor",
            "description": "What can I teach you?",
            "isSticky": true
        }
    ]
}
```

### Step 4: Implement the request handler

```typescript
const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    const messages = [
        vscode.LanguageModelChatMessage.User(BASE_PROMPT),
        vscode.LanguageModelChatMessage.User(request.prompt)
    ];

    const chatResponse = await request.model.sendRequest(messages, {}, token);
    for await (const fragment of chatResponse.text) {
        stream.markdown(fragment);
    }
};
```

### Step 7: Add message history

```typescript
const previousMessages = context.history.filter(h => h instanceof vscode.ChatResponseTurn);
previousMessages.forEach((m) => {
    let fullMessage = '';
    m.response.forEach((r) => {
        const mdPart = r as vscode.ChatResponseMarkdownPart;
        fullMessage += mdPart.value.value;
    });
    messages.push(vscode.LanguageModelChatMessage.Assistant(fullMessage));
});
```

### Step 8: Add a command

```json
"commands": [
    {
        "name": "exercise",
        "description": "Provide exercises to practice a concept."
    }
]
```
