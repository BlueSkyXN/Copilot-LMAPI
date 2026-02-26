/**
 * @module ModelCapabilities
 * @description 动态模型能力与发现系统的类型定义 - 模型管理的核心类型层。
 *
 * 本模块定义了模型能力描述、性能指标、模型池管理、发现配置、
 * 动态配置和模型事件等完整的类型体系，是 ModelDiscoveryService
 * 和 FunctionCallService 的类型基础。
 *
 * 架构位置：
 *   types/ModelCapabilities.ts --> ModelDiscoveryService（模型发现）
 *                              --> FunctionCallService（工具调用）
 *                              --> RequestHandler（请求处理）
 *
 * 关键依赖：
 *   - vscode：LanguageModelChat 类型（模型原始引用）
 *   - types/OpenAI：OpenAIMessage / OpenAIToolCall 类型（复用避免重复定义）
 *
 * 设计要点：
 *   1. 动态能力描述 - ModelCapabilities 不预设固定值，所有能力在运行时探测
 *   2. 分级模型池 - ModelPool 按能力将模型分为 primary/secondary/fallback/unhealthy
 *   3. 性能指标独立 - ModelMetrics 与能力描述分离，支持运行时独立更新
 *   4. 事件驱动通知 - ModelEvent 联合类型覆盖发现、健康变化、池刷新等事件
 *   5. 类型复用 - EnhancedMessage 和 ToolCall 直接复用 OpenAI 类型，避免重复定义
 *
 * 类型分组：
 *   - 核心能力：ModelCapabilities
 *   - 函数/工具：FunctionDefinition, ToolCall, EnhancedMessage
 *   - 性能指标：ModelMetrics
 *   - 发现配置：ModelDiscoveryConfig
 *   - 池管理：ModelPool
 *   - 请求上下文：EnhancedRequestContext
 *   - 动态配置：DynamicModelConfig
 *   - 事件类型：ModelEvent
 *
 * 接口/类型清单：
 *
 *   1. ModelCapabilities（接口）
 *      - 功能：模型能力描述，所有字段在运行时通过 ModelDiscoveryService 动态探测填充
 *      - 关键字段：id (string), family (string), vendor (string),
 *                 maxInputTokens (number), supportsVision (boolean),
 *                 supportsTools (boolean), supportsStreaming (boolean),
 *                 vsCodeModel? (vscode.LanguageModelChat)
 *
 *   2. EnhancedMessage（类型别名）
 *      - 功能：增强消息类型，直接复用 OpenAIMessage
 *      - 等价于：OpenAIMessage
 *
 *   3. ToolCall（类型别名）
 *      - 功能：工具调用类型，直接复用 OpenAIToolCall
 *      - 等价于：OpenAIToolCall
 *
 *   4. FunctionDefinition（接口）
 *      - 功能：函数定义，用于工具注册和转换
 *      - 关键字段：name (string), description (string), parameters (object — JSON Schema)
 *
 *   5. ModelMetrics（接口）
 *      - 功能：模型性能指标，与能力描述分离，支持运行时独立更新
 *      - 关键字段：requestCount (number), averageResponseTime (number),
 *                 errorCount (number), lastUsed (Date | null), currentLoad (number)
 *
 *   6. ModelDiscoveryConfig（接口）
 *      - 功能：模型发现配置
 *      - 关键字段：refreshInterval (number — 刷新间隔 ms),
 *                 healthCheckInterval (number — 健康检查间隔 ms),
 *                 cacheTimeout (number — 缓存超时 ms)
 *
 *   7. ModelPool（接口）
 *      - 功能：分级模型池，按能力评分将模型分为四级
 *      - 关键字段：primary (ModelCapabilities[]), secondary (ModelCapabilities[]),
 *                 fallback (ModelCapabilities[]), unhealthy (ModelCapabilities[])
 *
 *   8. EnhancedRequestContext（接口）
 *      - 功能：增强请求上下文，携带请求 ID、模型信息、工具配置等
 *      - 关键字段：requestId (string), model (ModelCapabilities),
 *                 messages (EnhancedMessage[]), tools? (FunctionDefinition[])
 *
 *   9. DynamicModelConfig（接口）
 *      - 功能：动态配置，运行时可修改的模型参数
 *      - 关键字段：temperature? (number), maxTokens? (number), timeout? (number)
 *
 *   10. ModelEvent（联合类型）
 *       - 功能：模型事件类型，覆盖模型生命周期中的关键事件
 *       - 取值：{ type: 'discovered', models: ModelCapabilities[] }
 *              | { type: 'healthChanged', modelId: string, healthy: boolean }
 *              | { type: 'poolRefreshed', pool: ModelPool }
 */

import * as vscode from 'vscode';
import type { OpenAIMessage, OpenAIToolCall } from './OpenAI';

/**
 * 模型能力接口
 *
 * 完整描述一个语言模型的能力特征，包括基本信息、核心容量、
 * 功能支持、性能指标和高级功能。所有能力均在运行时通过
 * ModelDiscoveryService 动态探测，不依赖硬编码。
 */
export interface ModelCapabilities {
    /** 模型唯一标识符（对应 VS Code LM API 的 model.id） */
    id: string;
    /** 模型家族（如 'gpt-4o'、'claude-3.5-sonnet'） */
    family?: string;
    /** 模型提供商（如 'copilot'） */
    vendor?: string;
    /** 模型版本号 */
    version?: string;
    
    // -- 核心能力 --

    /** 最大输入令牌数 */
    maxInputTokens: number;
    /** 最大输出令牌数（由 inferAdvancedCapabilities 推断） */
    maxOutputTokens?: number;
    /** 上下文窗口大小（目前与 maxInputTokens 相同） */
    contextWindow: number;
    
    // -- 功能支持检测 --

    /** 是否支持视觉/图像输入 */
    supportsVision: boolean;
    /** 是否支持工具/函数调用（OpenAI tools/functions 格式） */
    supportsTools: boolean;
    /** 是否支持流式输出（VS Code 模型默认为 true） */
    supportsStreaming: boolean;
    /** 是否支持多模态输入（文本+图像混合） */
    supportsMultimodal: boolean;
    
    // -- 性能指标 --

    /** 最后一次能力测试的时间 */
    lastTestedAt?: Date;
    /** 能力分析的响应时间（毫秒） */
    responseTime?: number;
    /** 请求成功率（0-1），用于健康评分 */
    successRate?: number;
    /** 模型当前是否健康可用 */
    isHealthy: boolean;
    
    // -- 高级功能 --

    /** 支持的图片格式列表（如 ['jpeg', 'png', 'gif', 'webp']） */
    supportedImageFormats?: string[];
    /** 单张图片的最大字节数 */
    maxImageSize?: number;
    /** 单次请求允许的最大图片数量 */
    maxImagesPerRequest?: number;
    
    // -- VS Code 模型引用 --

    /** 原始的 VS Code 语言模型聊天对象引用 */
    vsCodeModel: vscode.LanguageModelChat;
}

/**
 * 增强消息类型
 *
 * 直接复用 OpenAIMessage 类型，避免重复定义。
 * 支持多模态内容（文本和图片 URL 的混合数组）。
 */
export type EnhancedMessage = OpenAIMessage;

/**
 * 工具调用类型
 *
 * 直接复用 OpenAIToolCall 类型，避免重复定义。
 * 包含工具调用 ID、类型和函数调用信息。
 */
export type ToolCall = OpenAIToolCall;

/**
 * 函数定义接口
 *
 * 描述可被模型调用的函数的完整定义，
 * 包含名称、描述和参数的 JSON Schema。
 * 用于 FunctionCallService 的工具注册和格式转换。
 */
export interface FunctionDefinition {
    /** 函数名称，模型在生成调用时引用此名称 */
    name: string;
    /** 函数功能的自然语言描述 */
    description?: string;
    /** 函数参数的 JSON Schema 定义 */
    parameters: {
        /** Schema 类型，固定为 'object' */
        type: 'object';
        /** 参数属性定义映射 */
        properties: Record<string, any>;
        /** 必需参数名称列表 */
        required?: string[];
    };
}

/**
 * 模型性能指标接口
 *
 * 记录单个模型在运行时的累计性能数据，
 * 由 ModelDiscoveryService 维护，用于健康评估和负载均衡。
 */
export interface ModelMetrics {
    /** 累计请求总数 */
    totalRequests: number;
    /** 成功请求数 */
    successfulRequests: number;
    /** 失败请求数 */
    failedRequests: number;
    /** 平均响应时间（毫秒） */
    averageResponseTime: number;
    /** 最后使用时间 */
    lastUsed: Date;
    /** 当前并发负载数 */
    currentLoad: number;
}

/**
 * 模型发现配置接口
 *
 * 控制 ModelDiscoveryService 的运行行为，包括缓存策略、
 * 健康检查频率、能力测试超时等参数。
 */
export interface ModelDiscoveryConfig {
    /** 是否启用模型缓存（启用后将定期刷新） */
    enableCaching: boolean;
    /** 缓存刷新间隔（毫秒，默认 300000 即 5 分钟） */
    cacheRefreshInterval: number;
    /** 健康检查间隔（毫秒，默认 600000 即 10 分钟） */
    healthCheckInterval: number;
    /** 单次能力测试的超时时间（毫秒，默认 5000） */
    capabilityTestTimeout: number;
    /** 是否启用性能指标追踪 */
    enablePerformanceTracking: boolean;
    /** 是否启用自动故障转移 */
    enableAutoFailover: boolean;
}

/**
 * 模型池管理接口
 *
 * 将所有已发现的模型按能力和健康状态分为四个优先级层：
 * - primary：能力最全的模型（视觉+工具调用），最高优先
 * - secondary：具备工具调用或大上下文窗口的模型
 * - fallback：基础可用模型
 * - unhealthy：健康检查未通过的模型，暂不参与调度
 */
export interface ModelPool {
    /** 主要模型池 - 同时支持视觉和工具调用的高能力模型 */
    primary: ModelCapabilities[];
    /** 次要模型池 - 支持工具调用或上下文窗口超过 64K 的模型 */
    secondary: ModelCapabilities[];
    /** 后备模型池 - 其他健康的基础模型 */
    fallback: ModelCapabilities[];
    /** 不健康模型池 - 健康检查未通过，暂时排除 */
    unhealthy: ModelCapabilities[];
    /** 模型池最后更新时间 */
    lastUpdated: Date;
}

/**
 * 增强请求上下文接口
 *
 * 在基础转换上下文（ConversionContext）之上扩展了请求能力需求分析，
 * 用于 RequestHandler 在处理请求时记录请求特征并选择合适的模型。
 */
export interface EnhancedRequestContext {
    /** 请求唯一标识符 */
    requestId: string;
    /** 请求的目标模型 */
    model: string;
    /** 是否为流式请求 */
    isStream: boolean;
    /** 请求开始时间 */
    startTime: Date;
    /** 客户端 IP 地址 */
    clientIP?: string;
    /** 客户端 User-Agent */
    userAgent?: string;
    
    // -- 请求能力需求分析 --

    /** 请求中是否包含图片内容 */
    hasImages: boolean;
    /** 请求中是否包含函数/工具定义 */
    hasFunctions: boolean;
    /** 请求所需的能力列表（如 ['vision', 'tools']） */
    requiredCapabilities: string[];
    /** 请求的预估令牌消耗 */
    estimatedTokens: number;
    /** 最终选定的模型（在模型选择完成后赋值） */
    selectedModel?: ModelCapabilities;
}

/**
 * 动态配置接口
 *
 * 控制模型管理系统的全局行为策略，包括模型选择、负载均衡、
 * 功能开关和软性限制等。所有配置项均为软性约束，不做硬编码限制。
 */
export interface DynamicModelConfig {
    // -- 模型访问策略 --

    /** 是否允许使用所有动态发现的模型（不设白名单限制） */
    allowAllModels: boolean;
    
    // -- 智能模型选择 --

    /** 是否启用智能模型选择（根据请求需求自动匹配最优模型） */
    enableSmartSelection: boolean;
    /** 是否启用跨模型负载均衡 */
    enableLoadBalancing: boolean;
    /** 是否启用自动故障转移（模型不可用时切换备选） */
    enableAutoFailover: boolean;
    
    // -- 性能优化 --

    /** 是否启用模型信息缓存 */
    enableModelCaching: boolean;
    /** 是否启用运行时能力测试 */
    enableCapabilityTesting: boolean;
    /** 是否启用性能指标监控 */
    enablePerformanceMonitoring: boolean;
    
    // -- 功能门控 --

    /** 是否启用视觉/图像输入支持 */
    enableVisionSupport: boolean;
    /** 是否启用函数/工具调用支持 */
    enableFunctionCalling: boolean;
    /** 是否启用多模态请求支持 */
    enableMultimodalRequests: boolean;
    
    // -- 软性限制 --

    /** 偏好的最大令牌数（软性上限，非强制） */
    preferredMaxTokens?: number;
    /** 紧急后备模型标识符（所有模型不可用时的最终降级选择） */
    emergencyFallbackModel?: string;
}

/**
 * 模型事件联合类型
 *
 * 定义 ModelDiscoveryService 通过 EventEmitter 发布的所有事件类型。
 * 使用可辨识联合（Discriminated Union）模式，通过 type 字段区分事件种类。
 *
 * 事件类型：
 * - model_discovered：新模型被发现并分析完成
 * - model_health_changed：模型健康状态发生变化
 * - capability_updated：模型能力信息被更新
 * - pool_refreshed：模型池整体刷新完成
 * - failover_triggered：触发了模型故障转移
 */
export type ModelEvent = 
    | { type: 'model_discovered'; model: ModelCapabilities }
    | { type: 'model_health_changed'; modelId: string; isHealthy: boolean }
    | { type: 'capability_updated'; modelId: string; capabilities: Partial<ModelCapabilities> }
    | { type: 'pool_refreshed'; pool: ModelPool }
    | { type: 'failover_triggered'; from: string; to: string; reason: string };

/** 重新导出 vscode 命名空间，方便下游模块使用 */
export {
    vscode
};
