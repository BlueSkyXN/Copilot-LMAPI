# prompt-tsx 库 (prompt-tsx)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/prompt-tsx](https://code.visualstudio.com/api/extension-guides/ai/prompt-tsx)

## 基本介绍
本文介绍了 `@vscode/prompt-tsx` 库，这是一个用于构建语言模型 Prompt 的 TSX 组件库。通过 TSX 语法，开发者可以像编写 UI 组件一样声明式地构建复杂的 Prompt。该库的核心优势在于提供了基于优先级的自动修剪（Priority-based pruning）和灵活的 Token 管理（如 `flexGrow`、`flexReserve`），确保 Prompt 在不同模型的上下文窗口限制下，始终保留最重要的信息（如基础指令和当前用户查询），并能根据剩余配额动态扩展次要信息（如历史记录或文件内容）。

## 中文翻译

### 使用 TSX 构建提示词
你可以通过字符串拼接来构建提示词，但很难组合功能并确保提示词保持在模型的上下文窗口内。为了克服这些限制，你可以使用 `@vscode/prompt-tsx` 库。

**核心特性**
- **基于 TSX 的渲染**：使用 TSX 组件编写提示词，使其更具可读性和可维护性。
- **基于优先级的修剪**：自动删除提示词中较不重要的部分，以适应模型的上下文窗口。
- **灵活的 Token 管理**：使用 `flexGrow`、`flexReserve` 和 `flexBasis` 等属性协作使用 Token 预算。
- **工具集成**：与 VS Code 的语言模型工具 API 集成。

**最佳实践：管理对话历史优先级**
通常建议的优先级顺序为：
1. 基础指令 (Base instructions)
2. 当前用户查询 (Current user query)
3. 最近几轮聊天历史
4. 辅助数据 (Supporting data)
5. 尽可能多的剩余历史记录

在库中，每个 TSX 节点都有一个优先级（类似于 `zIndex`），数值越高优先级越高。例如，可以将基础指令设为 `priority={100}`，而将较旧的历史记录设为 `priority={0}`。

## 原文整理
# prompt-tsx

You can build language model prompts by using string concatenation, but it's hard to compose features and make sure your prompts stay within the context window of language models. To overcome these limitations, you can use the `@vscode/prompt-tsx` library.

### Key Features
- **TSX-based prompt rendering**: Compose prompts using TSX components.
- **Priority-based pruning**: Automatically prune less important parts of prompts.
- **Flexible token management**: Use `flexGrow`, `flexReserve`, and `flexBasis`.

### Example: HistoryMessages component

```tsx
import { UserMessage, AssistantMessage, PromptElement, PrioritizedList } from '@vscode/prompt-tsx';

export class HistoryMessages extends PromptElement<IHistoryMessagesProps> {
    render(): PromptPiece {
        const history: (UserMessage | AssistantMessage)[] = [];
        for (const turn of this.props.history) {
            if (turn instanceof ChatRequestTurn) {
                history.push(<UserMessage>{turn.prompt}</UserMessage>);
            } else if (turn instanceof ChatResponseTurn) {
                history.push(<AssistantMessage>{chatResponseToMarkdown(turn)}</AssistantMessage>);
            }
        }
        return (
            <PrioritizedList priority={0} descending={false}>
                {history}
            </PrioritizedList>
        );
    }
}
```

### Example: Using priorities and flex behavior

```tsx
export class MyPrompt extends PromptElement<IMyPromptProps> {
    render() {
        return (
            <>
                <UserMessage priority={100}>Base instructions...</UserMessage>
                <History
                    history={this.props.history}
                    passPriority
                    older={0}
                    newer={80}
                    flexGrow={2}
                    flexReserve="/5"
                />
                <UserMessage priority={90}>{this.props.userQuery}</UserMessage>
                <FileContext priority={70} flexGrow={1} files={this.props.files} />
            </>
        );
    }
}
```
In this example:
- `priority={100}` ensures base instructions are kept first.
- `flexGrow={1}` on `FileContext` allows it to take up unused token budget.
- `flexReserve="/5"` on `History` reserves 20% of the total budget for history.
