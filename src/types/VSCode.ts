/**
 * @module VSCode
 * @description VS Code 语言模型 API 类型扩展 - 桥接 VS Code LM API 与内部服务的类型层。
 *
 * 本模块扩展了 VS Code 原生的语言模型 API 类型，定义了服务器运行所需的
 * 配置、状态、指标、日志等内部类型，以及 OpenAI 模型名称到 VS Code
 * 模型选择条件的映射关系。
 *
 * 架构位置：
 *   types/OpenAI.ts (外部 API 类型) --> types/VSCode.ts (内部桥接类型) --> VS Code LM API
 *
 * 关键依赖：
 *   - vscode：LanguageModelChatMessage / LanguageModelChatMessageRole 等原生类型
 *
 * 设计要点：
 *   1. 扩展消息类型 - ExtendedLanguageModelChatMessage 支持多部分内容（文本/工具结果/工具调用）
 *   2. 模型映射表 - MODEL_MAPPING 将常见 OpenAI 模型名映射到 VS Code 选择条件
 *   3. 降级模型列表 - DEFAULT_MODELS 在 LM API 不可用时提供后备模型信息
 *   4. 完整的服务器生命周期类型 - 涵盖配置、状态、指标、日志等
 *   5. 转换上下文 - ConversionContext 在 OpenAI 与 VS Code 格式转换过程中传递元数据
 *
 * 接口/类型清单：
 *
 *   1. ExtendedLanguageModelChatMessage（接口）
 *      - 功能：扩展的语言模型聊天消息，支持多部分内容
 *      - 关键字段：role (LanguageModelChatMessageRole), content (string),
 *                 parts? (Array<文本 | 工具结果 | 工具调用>)
 *
 *   2. ModelSelectionCriteria（接口）
 *      - 功能：模型选择条件，用于 vscode.lm.selectChatModels() 参数
 *      - 关键字段：vendor? (string), family? (string), version? (string), id? (string)
 *
 *   3. CopilotModelInfo（接口）
 *      - 功能：Copilot 模型基本信息
 *      - 关键字段：id (string), family (string), vendor (string), maxInputTokens (number)
 *
 *   4. ServerConfig（接口）
 *      - 功能：服务器配置
 *      - 关键字段：port (number, 默认 8001), host (string, 默认 '127.0.0.1'),
 *                 timeout (number, 默认 120s), maxConcurrent (number, 默认 10)
 *
 *   5. ServerState（接口）
 *      - 功能：服务器运行时状态
 *      - 关键字段：isRunning (boolean), startTime (Date | null), authToken (string),
 *                 activeRequests (number), totalRequests (number)
 *
 *   6. RequestMetrics（接口）
 *      - 功能：请求指标
 *      - 关键字段：requestId (string), startTime (number), model (string),
 *                 status? (number), duration? (number)
 *
 *   7. LogEntry（接口）
 *      - 功能：日志条目
 *      - 关键字段：timestamp (Date), level (string), message (string), requestId? (string)
 *
 *   8. MODEL_MAPPING（const 常量）
 *      - 功能：OpenAI 模型名到 VS Code 模型选择条件的映射表
 *      - 类型：Record<string, ModelSelectionCriteria>
 *
 *   9. DEFAULT_MODELS（const 常量）
 *      - 功能：降级模型列表，在 LM API 不可用时提供后备模型信息
 *      - 类型：CopilotModelInfo[]
 *
 *   10. VSCodeLMResponse（接口）
 *       - 功能：VS Code 语言模型 API 响应
 *       - 关键字段：text (AsyncIterable<string>), model (string)
 *
 *   11. ConversionContext（接口）
 *       - 功能：格式转换上下文，在 OpenAI 与 VS Code 格式转换过程中传递元数据
 *       - 关键字段：requestId (string), model (string), stream (boolean)
 */

import * as vscode from 'vscode';

/**
 * 扩展的语言模型聊天消息接口
 *
 * 在 VS Code 原生 LanguageModelChatMessage 基础上，明确 content 字段
 * 支持文本片段、工具调用结果和工具调用请求的混合数组。
 */
export interface ExtendedLanguageModelChatMessage extends vscode.LanguageModelChatMessage {
    /** 消息角色（User / Assistant） */
    role: vscode.LanguageModelChatMessageRole;
    /** 消息内容片段数组，支持文本、工具调用结果和工具调用请求 */
    content: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelToolCallPart)[];
}

/**
 * 模型选择条件接口
 *
 * 用于 vscode.lm.selectChatModels() 的过滤条件，
 * 可按厂商、模型家族、版本或精确 ID 筛选模型。
 */
export interface ModelSelectionCriteria {
    /** 模型提供商（如 'copilot'） */
    vendor?: string;
    /** 模型家族（如 'gpt-4o'、'claude-3.5-sonnet'） */
    family?: string;
    /** 模型版本号 */
    version?: string;
    /** 模型精确 ID */
    id?: string;
}

/**
 * Copilot 模型基本信息接口
 *
 * 用于 DEFAULT_MODELS 降级列表，描述模型的基本元数据。
 */
export interface CopilotModelInfo {
    /** 模型唯一标识符 */
    id: string;
    /** 模型家族 */
    family: string;
    /** 模型提供商 */
    vendor: string;
    /** 最大输入令牌数 */
    maxInputTokens: number;
    /** 模型是否可用 */
    available: boolean;
}

/**
 * 服务器配置接口
 *
 * 对应 VS Code 设置中 copilot-lmapi.* 的配置项，
 * 控制 HTTP 服务器的监听地址、并发限制和超时等参数。
 */
export interface ServerConfig {
    /** HTTP 服务器监听端口（默认 8001） */
    port: number;
    /** HTTP 服务器监听地址（默认 127.0.0.1） */
    host: string;
    /** 是否在扩展激活时自动启动服务器 */
    autoStart: boolean;
    /** 是否启用详细日志 */
    enableLogging: boolean;
    /** 最大并发请求数（默认 10） */
    maxConcurrentRequests: number;
    /** 单个请求的超时时间（毫秒，默认 120000） */
    requestTimeout: number;
}

/**
 * 服务器运行时状态接口
 *
 * 记录服务器的当前运行状态和累计统计信息。
 */
export interface ServerState {
    /** 服务器是否正在运行 */
    isRunning: boolean;
    /** 当前监听端口 */
    port?: number;
    /** 当前监听地址 */
    host?: string;
    /** 服务器启动时间 */
    startTime?: Date;
    /** 累计处理的请求总数 */
    requestCount: number;
    /** 累计错误次数 */
    errorCount: number;
    /** 当前活跃连接数 */
    activeConnections: number;
}

/**
 * 请求指标接口
 *
 * 记录单个 HTTP 请求的完整生命周期指标，用于性能监控和调试。
 */
export interface RequestMetrics {
    /** 请求唯一标识符 */
    id: string;
    /** HTTP 请求方法（GET / POST 等） */
    method: string;
    /** 请求 URL 路径 */
    url: string;
    /** 请求开始时间 */
    startTime: Date;
    /** 请求结束时间 */
    endTime?: Date;
    /** 请求处理耗时（毫秒） */
    duration?: number;
    /** HTTP 响应状态码 */
    statusCode?: number;
    /** 错误信息（若请求失败） */
    error?: string;
    /** 令牌消耗统计 */
    tokens?: {
        /** 输入令牌数 */
        input: number;
        /** 输出令牌数 */
        output: number;
    };
}

/**
 * 日志条目接口
 *
 * 结构化的日志记录，支持按级别、请求 ID 过滤和上下文追踪。
 */
export interface LogEntry {
    /** 日志级别 */
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
    /** 日志消息内容 */
    message: string;
    /** 日志产生的时间戳 */
    timestamp: Date;
    /** 附加上下文信息（键值对） */
    context?: Record<string, any>;
    /** 关联的请求标识符，用于请求级别的日志追踪 */
    requestId?: string;
}

/**
 * OpenAI 模型名称到 VS Code 模型选择条件的映射表
 *
 * 将常见的 OpenAI 模型名称映射为 VS Code LM API 的选择条件，
 * 使客户端可以使用熟悉的 OpenAI 模型名称来访问对应的 Copilot 模型。
 */
export const MODEL_MAPPING: Record<string, ModelSelectionCriteria> = {
    'gpt-4o': { vendor: 'copilot', family: 'gpt-4o' },
    'gpt-4o-mini': { vendor: 'copilot', family: 'gpt-4o-mini' },
    'gpt-4': { vendor: 'copilot', family: 'gpt-4' },
    'gpt-4-turbo': { vendor: 'copilot', family: 'gpt-4-turbo' },
    'gpt-3.5-turbo': { vendor: 'copilot', family: 'gpt-3.5-turbo' },
    'claude-3.5-sonnet': { vendor: 'copilot', family: 'claude-3.5-sonnet' },
    'claude-3-haiku': { vendor: 'copilot', family: 'claude-3-haiku' },
    'claude-3-sonnet': { vendor: 'copilot', family: 'claude-3-sonnet' },
    'claude-3-opus': { vendor: 'copilot', family: 'claude-3-opus' }
};

/**
 * 降级模型列表
 *
 * 当 VS Code LM API 不可用或查询失败时，提供基本的模型信息作为后备。
 * 包含最常用的 GPT-4o、GPT-4o-mini 和 Claude 3.5 Sonnet。
 */
export const DEFAULT_MODELS: CopilotModelInfo[] = [
    {
        id: 'gpt-4o',
        family: 'gpt-4o',
        vendor: 'copilot',
        maxInputTokens: 128000,
        available: true
    },
    {
        id: 'gpt-4o-mini',
        family: 'gpt-4o-mini',
        vendor: 'copilot',
        maxInputTokens: 128000,
        available: true
    },
    {
        id: 'claude-3.5-sonnet',
        family: 'claude-3.5-sonnet',
        vendor: 'copilot',
        maxInputTokens: 200000,
        available: true
    }
];

/**
 * VS Code 语言模型响应接口
 *
 * 封装 VS Code LM API 返回的异步文本流。
 */
export interface VSCodeLMResponse {
    /** 异步可迭代的文本流（主要使用） */
    text: AsyncIterable<string>;
    /** 备用流接口（可选） */
    stream?: AsyncIterable<string>;
}

/**
 * 格式转换上下文接口
 *
 * 在 OpenAI 格式与 VS Code 格式互转过程中传递的元数据上下文，
 * 用于 Converter 模块追踪请求来源和生成响应头信息。
 */
export interface ConversionContext {
    /** 请求唯一标识符 */
    requestId: string;
    /** 请求的目标模型 */
    model: string;
    /** 是否为流式请求 */
    isStream: boolean;
    /** 请求开始时间 */
    startTime: Date;
    /** 客户端 IP 地址（可选） */
    clientIP?: string;
    /** 客户端 User-Agent（可选） */
    userAgent?: string;
}