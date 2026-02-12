# 语言模型 API 教程 (Language Model API Tutorial)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/language-model-tutorial](https://code.visualstudio.com/api/extension-guides/ai/language-model-tutorial)

## 基本介绍
本教程演示了如何使用 VS Code 的语言模型 (LM) API 构建一个 AI 驱动的 "Code Tutor" 扩展。该扩展不仅能生成改进建议，还能通过 VS Code 扩展 API 将其无缝集成到编辑器中，作为行内注释显示，并在悬停时提供详细信息。教程涵盖了获取当前编辑器的代码、编写结构化 JSON 输出的 Prompt、解析模型响应片段以及使用装饰器 (Decorations) 在 UI 中显示建议的完整技术路径。

## 中文翻译

### AI 驱动的代码导师教程
你将学习如何“创建一个 VS Code 扩展来构建 AI 驱动的代码导师”。

**核心步骤**
1. **项目脚手架**：使用 Yeoman 生成扩展项目。
2. **定义命令**：在 `package.json` 中添加 `code-tutor.annotate` 命令，用于触发代码评估。
3. **实现“批注”命令**：
    - **第一步：获取带行号的代码**：使用 `vscode.commands.registerTextEditorCommand` 获取当前可见区域的代码，并为每行添加行号前缀。
    - **第二步：发送代码和 Prompt**：选择 `gpt-4o` 模型，编写 Prompt 要求模型以 JSON 格式输出改进建议（如 `{ "line": 1, "suggestion": "..." }`）。
    - **第三步：解析响应并显示**：由于响应是流式的，通过检测 `}` 来判断一个完整的 JSON 对象是否接收完毕，然后解析并应用。
4. **应用装饰器 (Decorations)**：使用 `vscode.window.createTextEditorDecorationType` 在行尾显示灰色简短建议，并在悬停时显示完整 Markdown 文本。
5. **添加标题栏按钮**：在编辑器标题栏（右侧导航栏）添加一个气泡图标，方便用户点击触发。

## 原文整理
# Language Model API Tutorial

In this tutorial, You'll learn how to create a VS Code extension to build an AI-powered Code Tutor.

### Step 1: Get the code with line numbers

```typescript
function getVisibleCodeWithLineNumbers(textEditor: vscode.TextEditor) {
  let currentLine = textEditor.visibleRanges[0].start.line;
  const endLine = textEditor.visibleRanges[0].end.line;
  let code = '';
  while (currentLine < endLine) {
    code += `${currentLine + 1}: ${textEditor.document.lineAt(currentLine).text} \n`;
    currentLine++;
  }
  return code;
}
```

### Step 2: Send code and prompt to language model API

```typescript
const [model] = await vscode.lm.selectChatModels({
  vendor: 'copilot',
  family: 'gpt-4o',
});

const messages = [
  vscode.LanguageModelChatMessage.User(ANNOTATION_PROMPT),
  vscode.LanguageModelChatMessage.User(codeWithLineNumbers),
];

if (model) {
  let chatResponse = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
  await parseChatResponse(chatResponse, textEditor);
}
```

### Step 3: Parse and apply decorations

```typescript
async function parseChatResponse(chatResponse: vscode.LanguageModelChatResponse, textEditor: vscode.TextEditor) {
  let accumulatedResponse = "";
  for await (const fragment of chatResponse.text) {
    accumulatedResponse += fragment;
    if (fragment.includes("}")) {
      try {
        const annotation = JSON.parse(accumulatedResponse);
        applyDecoration(textEditor, annotation.line, annotation.suggestion);
        accumulatedResponse = "";
      } catch (e) { }
    }
  }
}
```
走向编辑器界面：
```json
"contributes": {
  "menus": {
    "editor/title": [
      {
        "command": "code-tutor.annotate",
        "group": "navigation"
      }
    ]
  }
}
```
