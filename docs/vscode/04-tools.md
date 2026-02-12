# 语言模型工具 (Language Model Tools)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/tools](https://code.visualstudio.com/api/extension-guides/ai/tools)

## 基本介绍
本文介绍了如何在 VS Code 中创建和使用语言模型工具（Language Model Tools）。这些工具允许扩展为 LLM 提供特定领域的能力，使 AI 代理能够自主调用这些工具来执行任务。文章详细讲解了在 `package.json` 中定义工具的静态配置，以及在代码中实现 `vscode.LanguageModelTool` 接口的流程，包括确认消息的处理、参数验证和错误处理的最佳实践。

## 中文翻译

### VS Code 语言模型工具
VS Code 扩展通过提供“领域特定能力”来“扩展大语言模型 (LLM) 的功能”。

**配置 (Configuration)**
首先，“在 manifest 的 `contributes.languageModelTools` 部分为你的工具添加一个条目”。基本的元数据包括“唯一的名称 (unique name)”、“用于提供 LLM 上下文的模型描述 (modelDescription)”以及“输入参数的模式 (inputSchema)”。例如，一个“选项卡计数 (Tab Count)”工具的模式可以将 `tabGroup` 属性定义为 `number`。

**实现 (Implementation)**
程序员必须“使用 `vscode.lm.registerTool` 注册工具”，并构建一个实现 `LanguageModelTool<>` 接口的类。该类使用 `prepareInvocation` 提供“确认消息”，并使用 `invoke` 方法执行具体操作。

**最佳实践**
“命名”应遵循 `{verb}_{noun}` 格式，并提供“详细描述”，以便模型知道“何时应该以及不应该使用它”。

### 核心步骤
1. **package.json 配置**：定义工具名称、显示名称、模型描述和输入模式。
2. **工具注册**：在扩展激活时使用 `vscode.lm.registerTool`。
3. **实现接口**：
    - `prepareInvocation`：显示用户确认对话框。
    - `invoke`：执行工具逻辑并返回结果。

## 原文整理
# Language Model Tools

VS Code extensions "extend the functionality of a large language model (LLM)" by offering "domain-specific capabilities."

**Configuration**
First, "Add an entry for your tool in the contributes.languageModelTools section" of the manifest. Essential metadata includes a "unique name," a "modelDescription" for LLM context, and an "inputSchema" for parameters. An example schema for a "Tab Count" tool defines a "tabGroup" property as a "number."

**Implementation**
Programmers must "register the tool with vscode.lm.registerTool" and build a class fulfilling the "LanguageModelTool<>" interface. This class uses "prepareInvocation" to provide "confirmation messages" and an "invoke" method for execution.

**Best Practices**
Follow the "{verb}_{noun}" format for "Naming" and provide "detailed descriptions" so the model knows "when it should and shouldn't be used."

### 1. Static configuration in `package.json`

```json
"contributes": {
    "languageModelTools": [
        {
            "name": "chat-tools-sample_tabCount",
            "toolReferenceName": "tabCount",
            "displayName": "Tab Count",
            "modelDescription": "The number of active tabs in a tab group in VS Code.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tabGroup": {
                        "type": "number",
                        "description": "The index of the tab group to check.",
                        "default": 0
                    }
                }
            }
        }
    ]
}
```

### 2. Tool implementation

```typescript
export function registerChatTools(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.lm.registerTool('chat-tools-sample_tabCount', new TabCountTool()));
}

class TabCountTool implements vscode.LanguageModelTool<ITabCountParameters> {
    async prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ITabCountParameters>, token: vscode.CancellationToken) {
        return {
            invocationMessage: 'Counting the number of tabs',
            confirmationMessages: {
                title: 'Count tabs',
                message: 'Count the number of open tabs?'
            }
        };
    }

    async invoke(options: vscode.LanguageModelToolInvocationOptions<ITabCountParameters>, token: vscode.CancellationToken) {
        const group = vscode.window.tabGroups.activeTabGroup;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`There are ${group.tabs.length} tabs open.`)]);
    }
}
```
