# AI 扩展性概览 (AI extensibility in VS Code)

## 原始参考来源
[https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview](https://code.visualstudio.com/api/extension-guides/ai/ai-extensibility-overview)

## 基本介绍
本文介绍了 Visual Studio Code 中 AI 扩展的核心概念和多种实现方式。VS Code 提供了多种途径让开发者能够将 AI 能力集成到编辑器中，包括代码补全、代理模式（Agent mode）、聊天（Chat）和智能操作（Smart actions）。文章重点对比了语言模型工具（Language Model Tool）、MCP 工具、聊天参与者（Chat Participant）以及直接使用语言模型 API 的适用场景，帮助开发者选择最适合其需求的 AI 扩展方案。

## 中文翻译

### VS Code 中的 AI 扩展性
VS Code 包含了增强编码体验的强大 AI 功能：
- **代码补全**：在输入时提供行内代码建议。
- **代理模式 (Agent mode)**：使 AI 能够通过专用工具自主规划和执行开发任务。
- **聊天**：允许开发人员通过聊天界面，使用自然语言提出问题或在代码库中进行编辑。
- **智能操作**：在整个编辑器中集成针对常见开发任务的 AI 增强操作。

你可以扩展和自定义这些内置功能，以创建满足用户特定需求的量身定制的 AI 体验。

### 为什么在 VS Code 中扩展 AI？
为你的扩展添加 AI 能力可以为用户带来多重好处：
- **代理模式中的领域特定知识**：让代理模式访问公司的内部数据源和服务。
- **增强用户体验**：提供针对扩展领域的智能辅助。
- **领域专业化**：创建针对特定编程语言、框架或领域的 AI 功能。
- **扩展聊天能力**：在聊天界面添加专用工具或助手，实现更强大的交互。
- **提高开发效率**：使用 AI 能力增强常见的开发任务，如调试、代码审查或测试。

### 扩展聊天体验

#### 语言模型工具 (Language Model Tool)
语言模型工具允许你通过领域特定的能力扩展 VS Code 的代理模式。在代理模式下，这些工具会根据用户的聊天提示自动调用，以执行专门任务或从数据源/服务中获取信息。用户也可以在聊天提示中使用 `#-mention` 显式引用这些工具。

要实现语言模型工具，请在 VS Code 扩展中使用 **Language Model Tools API**。语言模型工具可以访问所有 VS Code 扩展 API，并与编辑器提供深度集成。

**核心优势**：
- 作为自主编码工作流的一部分，提供领域特定能力。
- 工具实现可以访问 VS Code API，因为它运行在扩展宿主进程中。
- 通过 Visual Studio Marketplace 轻松分发和部署。

#### MCP 工具
模型上下文协议 (MCP) 工具提供了一种使用标准协议将外部服务与语言模型集成的方法。在代理模式下，这些工具会根据用户的聊天提示自动调用。

MCP 工具运行在 VS Code 之外，可以是本地或远程服务。由于它们运行在 VS Code 之外，因此无法访问 VS Code 扩展 API。

#### 聊天参与者 (Chat Participant)
聊天参与者是专门的助手，允许用户通过领域专家扩展问答模式（ask mode）。用户可以通过 `@-mention` 调用参与者。

### 构建你自己的 AI 驱动功能
VS Code 允许你直接通过编程方式访问 AI 模型。通过 **Language Model API**，你可以将 AI 能力集成到任何扩展功能中，如代码操作、悬停提示、自定义视图等，而不必依赖聊天界面。

### 决定使用哪种方案
1. **选择语言模型工具 (Language Model Tool)**：如果你想扩展代理模式并需要访问 VS Code API，且希望通过 Marketplace 分发。
2. **选择 MCP 工具**：如果你希望工具能在不同环境（不仅是 VS Code）中使用，或者不需要集成 VS Code API。
3. **选择聊天参与者 (Chat Participant)**：如果你想扩展问答模式，并需要自定义完整的交互流程和响应行为。
4. **选择语言模型 API (Language Model API)**：如果你想在现有功能（如悬停、代码操作）中集成 AI，或构建聊天界面之外的 UI 体验。

## 原文整理
# AI extensibility in VS Code

This article provides an overview of AI extensibility options in Visual Studio Code, helping you choose the right approach for your extension.

VS Code includes powerful AI features that enhance the coding experience:

- **Code completion**: Offers inline code suggestions as you type
- **Agent mode**: Enables AI to autonomously plan and execute development tasks with specialized tools
- **Chat**: Lets developers use natural language to ask questions or make edits in codebase through chat interfaces
- **Smart actions**: Use AI-enhanced actions for common development tasks, integrated throughout the editor

You can extend and customize each of these built-in capabilities to create tailored AI experiences that meet the specific needs of your users.

## Why extend AI in VS Code?

Adding AI capabilities to your extension brings several benefits to your users:

- **Domain-specific knowledge in agent mode**: Let agent mode access your company's data sources and services
- **Enhanced user experience**: Provide intelligent assistance tailored to your extension's domain
- **Domain specialization**: Create AI features specific to a programming language, framework, or domain
- **Extend chat capabilities**: Add specialized tools or assistants to the chat interface for more powerful interactions
- **Improved developer productivity**: Enhance common developer tasks, like debugging, code reviewing or testing, with AI capabilities

## Extend the chat experience

### Language model tool

Language model tools enable you to extend agent mode in VS Code with domain-specific capabilities. In agent mode, these tools are automatically invoked based on the user's chat prompt to perform specialized tasks or retrieve information from a data source or service. Users can also reference these tools explicitly in their chat prompt by #-mentioning the tool.

To implement a language model tool, use the [Language Model Tools API](https://code.visualstudio.com/api/extension-guides/ai/tools) within your VS Code extension. A language model tool can access all VS Code extension APIs and provide deep integration with the editor.

**Key benefits**:

- Domain-specific capabilities as part of an autonomous coding workflow
- Your tool implementation can use VS Code APIs since it runs in the extension host process
- Easy distribution and deployment via the Visual Studio Marketplace

**Key considerations**:

- Remote deployment requires the extension to implement the client-server communication
- Reuse across different tools requires modular design and implementation

### MCP tool

Model Context Protocol (MCP) tools provide a way to integrate external services with language models by using a standardized protocol. In agent mode, these tools are automatically invoked based on the user's chat prompt to perform specialized tasks or retrieve information from external data sources.

MCP tools run outside of VS Code, either locally on the user's machine or as a remote service. Users can add MCP tools through JSON configuration or VS Code extension can configure them programmatically. You can implement MCP tools through various language SDKs and deployment options.

As MCP tools run outside of VS Code, they do not have access to the VS Code extension APIs.

**Key benefits**:

- Add domain-specific capabilities as part of an autonomous coding workflow
- Local and remote deployment options
- Reuse MCP servers in other MCP clients

**Key considerations**:

- No access to VS Code extension APIs
- Distribution and deployment require users to set up the MCP server

### Chat participant

Chat participants are specialized assistants that enable users to extend ask mode with domain-specific experts. In chat, users can invoke a chat participant by @-mentioning it and passing in a natural language prompt about a particular topic or domain. The chat participant is responsible for handling the entire chat interaction.

To implement a chat participant, use the [Chat API](https://code.visualstudio.com/api/extension-guides/ai/chat) within your VS Code extension. A chat participant can access all VS Code extension APIs and provide deep integration with the editor.

**Key benefits**:

- Control the end-to-end interaction flow
- Running in the extension host process allows access to VS Code extension APIs
- Easy distribution and deployment via the Visual Studio Marketplace

**Key considerations**:

- Remote deployment requires the extension to implement the client-server communication
- Reuse across different tools requires modular design and implementation

## Build your own AI-powered features

VS Code gives you direct programmatic access to AI models for creating custom AI-powered features in your extensions. This approach enables you to build editor-specific interactions that use AI capabilities without relying on the chat interface.

To use language models directly, use the [Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model) within your VS Code extension. You can incorporate these AI capabilities into any extension feature, such as code actions, hover providers, custom views, and more.

**Key benefits**:

- Integrate AI capabilities into existing extension features or build new ones
- Running in the extension host process allows access to VS Code extension APIs
- Easy distribution and deployment via the Visual Studio Marketplace

**Key considerations**:

- Reuse across different experiences requires modular design and implementation

## Decide which option to use

When choosing the right approach for extending AI in your VS Code extension, consider the following guidelines:

1. **Choose Language Model Tool when**:
    - You want to extend chat in VS Code with specialized capabilities
    - You want automatic invocation based on user intent in agent mode
    - You want access to VS Code APIs for deep integration in VS Code
    - You want to distribute your tool through the VS Code Marketplace

1. **Choose MCP Tool when**:
    - You want to extend chat in VS Code with specialized capabilities
    - You want automatic invocation based on user intent in agent mode
    - You don't need to integrate with VS Code APIs
    - Your tool needs to work across different environments (not just VS Code)
    - Your tool should run remotely or locally

1. **Choose Chat Participant when**:
    - You want to extend ask mode with a specialized assistant with domain expertise
    - You need to customize the entire interaction flow and response behavior
    - You want access to VS Code APIs for deep integration in VS Code
    - You want to distribute your tool through the VS Code Marketplace

1. **Choose Language Model API when**:
    - You want to integrate AI capabilities into existing extension features
    - You're building UI experiences outside the chat interface
    - You need direct programmatic control over AI model requests
