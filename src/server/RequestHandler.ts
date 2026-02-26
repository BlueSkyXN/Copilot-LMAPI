/**
 * @module RequestHandler
 * @description 请求处理器 - HTTP 请求的核心业务逻辑层
 *
 * 本模块负责处理所有经由 CopilotServer 路由分发后的 HTTP 请求，
 * 包括聊天补全、模型列表、健康检查和状态查询等端点。
 * 它是连接外部 OpenAI 兼容接口与内部 VS Code Language Model API 的桥梁。
 *
 * 在架构中的位置：
 *   CopilotServer (路由/限流/认证)
 *     -> RequestHandler (请求解析/验证/模型选择/响应处理)
 *       -> Converter (OpenAI <-> VS Code 格式转换)
 *       -> Validator (请求参数验证)
 *       -> ModelDiscoveryService (动态模型发现与缓存)
 *       -> FunctionCallService (工具/函数调用管理)
 *         -> vscode.lm API (实际的 Copilot 模型调用)
 *
 * 关键依赖：
 *   - Converter: 负责 OpenAI 格式与 VS Code LM API 格式之间的双向转换
 *   - Validator: 动态请求验证（无硬编码模型限制）
 *   - ModelDiscoveryService: 运行时动态发现所有可用 Copilot 模型
 *   - FunctionCallService: 工具/函数调用的生命周期管理
 *   - vscode.lm API: VS Code 提供的语言模型接口
 *
 * 设计要点：
 *   1. 严格模型路由：始终使用客户端请求的精确模型，不进行静默回退
 *   2. CancellationToken 链接：服务器停止、客户端断开、请求超时均会取消进行中的 LM 请求
 *   3. 工具降级重试：当 requiresToolCall=false 且遇到工具模式错误时，自动去除工具重试一次
 *   4. Copilot 访问缓存：成功结果缓存 60 秒，失败结果缓存 10 秒，避免频繁调用 API
 *   5. SSE 头部延迟发送：流式响应中直到收到第一个数据块才写入响应头
 *   6. 请求体超大时设置 Connection: close 头，提示客户端关闭连接
 *   7. 每个请求拥有唯一 requestId，贯穿整个处理链路用于日志追踪
 *
 * 函数/类清单：
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │ 类: RequestHandler                                                         │
 * │ 功能说明: HTTP 端点的核心业务逻辑处理器                                      │
 * │ 关键属性:                                                                   │
 * │   - modelDiscovery: ModelDiscoveryService — 动态模型发现服务                  │
 * │   - functionService: FunctionCallService — 工具/函数调用管理服务              │
 * │   - isInitialized: boolean — 是否已完成初始化（默认 false）                   │
 * │   - copilotAccessCache: {result, timestamp} | null — Copilot 可用性缓存      │
 * │ 关键常量:                                                                   │
 * │   - COPILOT_ACCESS_SUCCESS_CACHE_TTL = 60_000 (成功缓存 60 秒)              │
 * │   - COPILOT_ACCESS_FAILURE_CACHE_TTL = 10_000 (失败缓存 10 秒)              │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 *  1. constructor(modelDiscovery: ModelDiscoveryService)
 *     - 功能说明: 初始化请求处理器，创建 FunctionCallService
 *     - 输入参数: modelDiscovery: ModelDiscoveryService — 模型发现服务实例
 *     - 输出/返回值: RequestHandler 实例
 *
 *  2. initialize(): Promise<void>
 *     - 功能说明: 异步初始化，触发首次模型发现
 *     - 输入参数: 无
 *     - 输出/返回值: Promise<void>
 *
 *  3. handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse,
 *       requestId: string, serverCancellationToken?: vscode.CancellationToken): Promise<void>
 *     - 功能说明: 处理 POST /v1/chat/completions，含请求体读取、验证、模型选择、
 *       LM 调用、响应（流式/非流式）
 *     - 输入参数:
 *         req: http.IncomingMessage — HTTP 请求对象
 *         res: http.ServerResponse — HTTP 响应对象
 *         requestId: string — 请求唯一标识
 *         serverCancellationToken?: vscode.CancellationToken — 服务器级取消令牌
 *     - 输出/返回值: Promise<void>
 *     - 关键变量: body (请求体字符串), request (解析后对象), selectedModel (选中模型)
 *
 *  4. handleModels(req: http.IncomingMessage, res: http.ServerResponse,
 *       requestId: string): Promise<void>
 *     - 功能说明: 处理 GET /v1/models，返回可用模型列表
 *     - 输入参数: req, res, requestId — 同上
 *     - 输出/返回值: Promise<void>
 *
 *  5. handleHealth(req: http.IncomingMessage, res: http.ServerResponse,
 *       requestId: string): Promise<void>
 *     - 功能说明: 处理 GET /health，返回健康检查结果
 *     - 输入参数: req, res, requestId — 同上
 *     - 输出/返回值: Promise<void>
 *
 *  6. handleStatus(req: http.IncomingMessage, res: http.ServerResponse,
 *       requestId: string): Promise<void>
 *     - 功能说明: 处理 GET /status，返回详细服务器指标
 *     - 输入参数: req, res, requestId — 同上
 *     - 输出/返回值: Promise<void>
 *
 *  7. handleStreamingResponse(res: http.ServerResponse,
 *       response: vscode.LanguageModelChatResponse, requestId: string,
 *       model: string, context: object, request: object): Promise<void>
 *     - 功能说明: SSE 流式响应处理（延迟头部发送，直到收到第一个数据块）
 *     - 输入参数:
 *         res: http.ServerResponse — HTTP 响应对象
 *         response: vscode.LanguageModelChatResponse — LM 响应流
 *         requestId: string — 请求唯一标识
 *         model: string — 模型标识符
 *         context: object — 工具调用上下文
 *         request: object — 原始请求对象
 *     - 输出/返回值: Promise<void>
 *
 *  8. handleNonStreamingResponse(res: http.ServerResponse,
 *       response: vscode.LanguageModelChatResponse, requestId: string,
 *       model: string, context: object): Promise<void>
 *     - 功能说明: 非流式 JSON 响应处理
 *     - 输入参数:
 *         res: http.ServerResponse — HTTP 响应对象
 *         response: vscode.LanguageModelChatResponse — LM 响应流
 *         requestId: string — 请求唯一标识
 *         model: string — 模型标识符
 *         context: object — 工具调用上下文
 *     - 输出/返回值: Promise<void>
 *
 *  9. isRequiredToolMode(toolChoice?: any, functionCall?: any): boolean
 *     - 功能说明: 判断是否为必需工具调用模式（required 或指定函数名）
 *     - 输入参数:
 *         toolChoice?: any — 工具选择参数
 *         functionCall?: any — 旧版函数调用参数
 *     - 输出/返回值: boolean — true 表示必需工具调用模式
 *
 * 10. sendRequestWithToolFallback(messages: vscode.LanguageModelChatMessage[],
 *       model: vscode.LanguageModelChat, options: object,
 *       requiresToolCall: boolean, reqLogger: RequestLogger):
 *       Promise<vscode.LanguageModelChatResponse>
 *     - 功能说明: 发送 LM 请求，工具模式失败时自动降级（去除工具）重试
 *     - 输入参数:
 *         messages: vscode.LanguageModelChatMessage[] — 聊天消息数组
 *         model: vscode.LanguageModelChat — 选中的模型实例
 *         options: object — 发送选项（含 tools、justification、cancellationToken）
 *         requiresToolCall: boolean — 是否为必需工具模式
 *         reqLogger: RequestLogger — 请求级日志记录器
 *     - 输出/返回值: Promise<vscode.LanguageModelChatResponse>
 *
 * 11. isLikelyToolModeError(error: unknown): boolean
 *     - 功能说明: 判断错误是否为工具模式相关错误（基于错误消息关键词匹配）
 *     - 输入参数: error: unknown — 捕获的错误对象
 *     - 输出/返回值: boolean — true 表示可能是工具模式错误
 *
 * 12. stringifyError(error: unknown): string
 *     - 功能说明: 将 unknown 类型错误安全转为字符串
 *     - 输入参数: error: unknown — 任意错误对象
 *     - 输出/返回值: string — 错误描述字符串
 *
 * 13. checkCopilotAccess(): Promise<boolean>
 *     - 功能说明: 检查 Copilot 可用性（带缓存，成功 60s / 失败 10s）
 *     - 输入参数: 无
 *     - 输出/返回值: Promise<boolean> — true 表示 Copilot 可用
 *     - 关键变量: copilotAccessCache — 缓存对象 {result: boolean, timestamp: number}
 *
 * 14. getModelCount(): Promise<number>
 *     - 功能说明: 获取当前可用模型数量
 *     - 输入参数: 无
 *     - 输出/返回值: Promise<number> — 可用模型数
 *
 * 15. handleLanguageModelError(error: unknown, requestId: string,
 *       model: string): {statusCode: number, errorMessage: string, errorType: string}
 *     - 功能说明: 将 VS Code LanguageModelError 映射为 HTTP 错误码与消息
 *     - 输入参数:
 *         error: unknown — 捕获的错误
 *         requestId: string — 请求唯一标识
 *         model: string — 请求使用的模型名
 *     - 输出/返回值: {statusCode: number, errorMessage: string, errorType: string}
 *
 * 16. sendErrorResponse(res: http.ServerResponse, statusCode: number,
 *       message: string, type: string, requestId: string, param?: string): void
 *     - 功能说明: 发送 OpenAI 格式的 JSON 错误响应
 *     - 输入参数:
 *         res: http.ServerResponse — HTTP 响应对象
 *         statusCode: number — HTTP 状态码
 *         message: string — 错误消息
 *         type: string — 错误类型
 *         requestId: string — 请求唯一标识
 *         param?: string — 可选，出错的参数名
 *     - 输出/返回值: void
 *
 * 17. readRequestBody(req: http.IncomingMessage): Promise<string>
 *     - 功能说明: 读取并限制请求体大小（上限 10MB）
 *     - 输入参数: req: http.IncomingMessage — HTTP 请求对象
 *     - 输出/返回值: Promise<string> — 请求体字符串
 *     - 关键变量: MAX_BODY_SIZE = 10 * 1024 * 1024 (10MB)
 *
 * 18. getClientIP(req: http.IncomingMessage): string
 *     - 功能说明: 提取客户端 IP 地址（优先 x-forwarded-for，回退 socket.remoteAddress）
 *     - 输入参数: req: http.IncomingMessage — HTTP 请求对象
 *     - 输出/返回值: string — 客户端 IP 地址（默认 'unknown'）
 *
 * 19. dispose(): void
 *     - 功能说明: 释放资源，清理 FunctionCallService
 *     - 输入参数: 无
 *     - 输出/返回值: void
 */

import * as http from 'http';
import * as vscode from 'vscode';

import { logger, RequestLogger } from '../utils/Logger';
import { Converter } from '../utils/Converter';
import { Validator, ValidationError } from '../utils/Validator';
import { ModelDiscoveryService } from '../services/ModelDiscoveryService';
import { FunctionCallService } from '../services/FunctionCallService';

import {
    ModelCapabilities,
    EnhancedMessage,
    EnhancedRequestContext
} from '../types/ModelCapabilities';
import { OpenAITool, ValidatedRequest } from '../types/OpenAI';

import { ServerState } from '../types/VSCode';
import {
    LIMITS,
    HTTP_STATUS,
    CONTENT_TYPES,
    ERROR_CODES,
    NOTIFICATIONS,
    getSSEHeaders
} from '../constants/Config';

/**
 * 请求处理器类
 *
 * 封装了所有 HTTP 端点的业务处理逻辑，由 CopilotServer 在路由匹配后调用。
 * 本类不关心 HTTP 服务器生命周期、认证和限流（这些由 CopilotServer 负责），
 * 专注于请求解析、验证、模型调用和响应构造。
 */
export class RequestHandler {
    /** 模型发现服务，用于动态获取和缓存可用的 Copilot 模型 */
    private modelDiscovery: ModelDiscoveryService;
    /** 函数调用服务，管理工具/函数调用的准备和统计 */
    private functionService: FunctionCallService;
    /** 初始化标志，防止重复初始化 */
    private isInitialized: boolean = false;
    /** Copilot 访问权限缓存，包含检查结果和过期时间戳 */
    private copilotAccessCache: { result: boolean; expiry: number } | null = null;
    /** 访问检查成功时的缓存有效期（60 秒） */
    private static readonly COPILOT_ACCESS_SUCCESS_CACHE_TTL = 60_000; // 60 seconds
    /** 访问检查失败时的缓存有效期（10 秒），较短以便快速恢复 */
    private static readonly COPILOT_ACCESS_FAILURE_CACHE_TTL = 10_000; // 10 seconds

    /**
     * 创建请求处理器实例
     * @param modelDiscovery - 模型发现服务实例，由 CopilotServer 创建并注入
     */
    constructor(modelDiscovery: ModelDiscoveryService) {
        this.modelDiscovery = modelDiscovery;
        this.functionService = new FunctionCallService();
    }

    /**
     * 初始化处理器
     *
     * 由 CopilotServer.start() 在服务器启动时显式调用。
     * 使用 isInitialized 标志保证幂等性，重复调用不会产生副作用。
     *
     * @returns 初始化完成的 Promise；初始化失败时会抛出错误
     */
    public async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }
        try {
            logger.info('Initializing Request Handler...');
            this.isInitialized = true;
            logger.info('Request Handler initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize Request Handler:', error as Error);
            throw error;
        }
    }
    
    /**
     * 处理聊天补全请求（核心业务逻辑）
     *
     * 完整的请求处理流程：
     *   1. 读取并解析请求体（带 10MB 大小限制）
     *   2. JSON 解析与 Validator 验证
     *   3. 提取请求参数（模型、流式、工具等）
     *   4. 严格模型路由：查找请求的精确模型，找不到则重新发现，仍找不到则报错
     *   5. Copilot 访问权限检查（带 TTL 缓存）
     *   6. 上下文窗口令牌数限制验证
     *   7. 消息格式转换（OpenAI -> VS Code LM API）
     *   8. 工具/函数调用准备（同时支持现代 tools 和旧版 functions 格式）
     *   9. 发送 LM 请求（带 CancellationToken 链接和工具降级重试）
     *   10. 流式或非流式响应处理
     *
     * @param req - HTTP 请求对象，用于读取请求体和监听客户端断开
     * @param res - HTTP 响应对象，用于写入响应数据
     * @param requestId - 唯一请求标识符，用于日志追踪
     * @param serverCancellationToken - 可选的服务器级取消令牌，服务器停止时触发
     * @returns 处理完成的 Promise；错误在内部捕获，不会向上抛出
     */
    public async handleChatCompletions(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string,
        serverCancellationToken?: vscode.CancellationToken
    ): Promise<void> {
        const requestLogger = logger.createRequestLogger(requestId);
        const startTime = Date.now();
        
        try {
            requestLogger.info('Processing chat completion request');
            
            // 读取并解析请求体（带 10MB 大小限制），处理超大请求和客户端中断
            let body: string;
            try {
                body = await this.readRequestBody(req);
            } catch (bodyReadError) {
                if (bodyReadError instanceof Error && bodyReadError.message === 'Request body too large') {
                    requestLogger.warn('Request body exceeded configured limit');
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.PAYLOAD_TOO_LARGE,
                        'Request body too large',
                        ERROR_CODES.INVALID_REQUEST,
                        requestId
                    );
                    // 请求体超大时，继续消耗剩余数据后销毁连接，避免半开连接
                    if (!req.destroyed) {
                        req.resume();
                        req.once('end', () => {
                            if (!req.destroyed) {
                                req.destroy();
                            }
                        });
                    }
                    return;
                }

                if (bodyReadError instanceof Error && bodyReadError.message === 'Request aborted by client') {
                    requestLogger.warn('Client aborted request while reading body');
                    return;
                }

                throw bodyReadError;
            }
            
            // 解析 JSON 请求体，格式无效时直接返回 400 错误
            let rawRequestData: any;
            try {
                rawRequestData = JSON.parse(body);
            } catch (parseError) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.BAD_REQUEST,
                    'Invalid JSON in request body',
                    ERROR_CODES.INVALID_REQUEST,
                    requestId
                );
                return;
            }
            
            // 使用 Validator 对请求参数进行全面验证（模型、消息、工具等）
            let validatedRequest: ValidatedRequest;
            try {
                validatedRequest = Validator.validateChatCompletionRequest(
                    rawRequestData,
                    this.modelDiscovery.getAllModels()
                );
            } catch (validationError) {
                if (validationError instanceof ValidationError) {
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.BAD_REQUEST,
                        validationError.message,
                        validationError.code,
                        requestId,
                        validationError.param
                    );
                } else {
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.BAD_REQUEST,
                        'Request validation failed',
                        ERROR_CODES.INVALID_REQUEST,
                        requestId
                    );
                }
                return;
            }
            
            // 提取验证后的请求参数
            const requestData: ValidatedRequest = validatedRequest;
            
            // 从验证后的请求中解构关键参数
            const messages: EnhancedMessage[] = requestData.messages;
            const requestedModel = requestData.model;
            const isStream = requestData.stream || false;
            const functions = requestData.functions || [];
            const tools: OpenAITool[] = requestData.tools || [];
            const toolChoice = requestData.tool_choice;
            const functionCall = requestData.function_call;
            // 当只提供了旧版 functions 而未提供 tools 时，优先使用旧版函数调用格式响应
            const preferLegacyFunctionCall = functions.length > 0 && tools.length === 0;
            // 判断是否为强制工具调用模式（required 或指定具体工具），此模式下不允许自动降级
            const requiresToolCall = this.isRequiredToolMode(toolChoice, functionCall);
            // 记录触发强制模式的参数名称，用于错误响应中的 param 字段
            const requiredModeParam = toolChoice !== undefined ? 'tool_choice' : 'function_call';
            
            requestLogger.info('Request analysis:', {
                model: requestedModel,
                stream: isStream,
                messageCount: messages.length,
                hasImages: messages.some(m => Array.isArray(m.content) && 
                    m.content.some(p => p.type === 'image_url')),
                hasFunctions: functions.length > 0 || tools.length > 0
            });
            
            // 创建增强请求上下文，用于贯穿整个请求处理链路
            const context = Converter.createEnhancedContext(
                requestId,
                requestedModel,
                isStream,
                messages,
                undefined, // Will be set after model selection
                this.getClientIP(req),
                req.headers['user-agent']
            );
            
            // 严格模型路由：仅使用客户端请求的精确模型，不进行静默回退到其他模型
            let selectedModel: ModelCapabilities | null = this.modelDiscovery.getModel(requestedModel) || null;
            if (!selectedModel) {
                // 首次查找失败时触发模型重新发现，可能是模型列表尚未刷新
                await this.modelDiscovery.discoverAllModels();
                selectedModel = this.modelDiscovery.getModel(requestedModel) || null;
            }
            
            if (!selectedModel) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.SERVICE_UNAVAILABLE,
                    `Requested model '${requestedModel}' not found or unavailable`,
                    ERROR_CODES.API_ERROR,
                    requestId
                );
                return;
            }
            
            // 用所选模型更新请求上下文
            context.selectedModel = selectedModel;
            
            // 记录所选模型的详细信息，确认使用的是客户端请求的精确模型
            requestLogger.info('Model direct:', {
                model: requestedModel,
                vendor: selectedModel.vendor,
                family: selectedModel.family,
                maxTokens: selectedModel.maxInputTokens,
                supportsVision: selectedModel.supportsVision,
                supportsTools: selectedModel.supportsTools
            });
            
            // 检查 Copilot 访问权限（结果带 TTL 缓存，避免每次请求都调用 vscode.lm API）
            const hasAccess = await this.checkCopilotAccess();
            if (!hasAccess) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.UNAUTHORIZED,
                    NOTIFICATIONS.NO_COPILOT_ACCESS,
                    ERROR_CODES.AUTHENTICATION_ERROR,
                    requestId
                );
                return;
            }
            
            // 验证请求的预估令牌数是否超出所选模型的上下文窗口限制
            if (context.estimatedTokens > selectedModel.maxInputTokens) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.BAD_REQUEST,
                    `Request exceeds model context limit (${context.estimatedTokens} > ${selectedModel.maxInputTokens} tokens)`,
                    ERROR_CODES.INVALID_REQUEST,
                    requestId
                );
                return;
            }
            
            // 将 OpenAI 格式的消息转换为 VS Code LM API 格式（含多模态内容处理）
            const vsCodeMessages = await Converter.convertMessagesToVSCode(
                messages, 
                selectedModel
            );
            
            // 如果请求包含工具/函数定义，准备 VS Code 格式的工具配置
            // 同时支持现代 tools 数组和旧版 functions 数组
            let vsCodeTools: vscode.LanguageModelChatTool[] = [];
            let toolMode: vscode.LanguageModelChatToolMode | undefined;
            if (functions.length > 0 || tools.length > 0) {
                try {
                    const toolConfig = this.functionService.prepareToolsForRequest(
                        functions,
                        tools,
                        toolChoice,
                        functionCall
                    );
                    vsCodeTools = toolConfig.tools;
                    toolMode = toolConfig.toolMode;
                    requestLogger.info(`Prepared ${vsCodeTools.length} tools for LM request`, {
                        toolMode,
                        requestedTools: tools.length,
                        requestedFunctions: functions.length
                    });
                } catch (error) {
                    requestLogger.warn('Failed to prepare tools:', { error: String(error) });
                    // 工具准备失败时：如果是强制工具模式则报错，否则静默跳过工具配置
                    if (requiresToolCall) {
                        this.sendErrorResponse(
                            res,
                            HTTP_STATUS.BAD_REQUEST,
                            `Failed to prepare required tools: ${this.stringifyError(error)}`,
                            ERROR_CODES.INVALID_REQUEST,
                            requestId,
                            requiredModeParam
                        );
                        return;
                    }
                }
            }

            // 模型能力探测报告不支持工具，但仍尝试运行时调用（能力探测可能不准确）
            if (!selectedModel.supportsTools && vsCodeTools.length > 0) {
                requestLogger.warn('Model capability probe reports supportsTools=false, continuing with runtime attempt', {
                    model: selectedModel.id,
                    requiredToolMode: requiresToolCall,
                    tools: vsCodeTools.length
                });
            }
            
            // 向 VS Code LM API 发送请求，并处理响应
            try {
                requestLogger.info('Sending request to VS Code LM API...');
                
                // 构建请求选项：仅在有工具定义时才附加工具和工具模式
                const requestOptions: vscode.LanguageModelChatRequestOptions = {};
                if (vsCodeTools.length > 0) {
                    requestOptions.tools = vsCodeTools;
                }
                if (toolMode && vsCodeTools.length > 0) {
                    requestOptions.toolMode = toolMode;
                }
                // 创建请求级别的 CancellationTokenSource，用于链接多个取消来源
                const requestCancellation = new vscode.CancellationTokenSource();
                let serverCancellationSubscription: vscode.Disposable | undefined;
                // 统一的取消处理函数，确保只触发一次取消
                const cancelRequest = (reason: string) => {
                    if (!requestCancellation.token.isCancellationRequested) {
                        requestLogger.warn(reason);
                        requestCancellation.cancel();
                    }
                };
                // 客户端中断时取消 LM 请求
                const cancelOnAborted = () => {
                    cancelRequest('Client request aborted, cancelling LM request');
                };
                // 客户端连接关闭时取消 LM 请求（仅在响应尚未结束时）
                const cancelOnClose = () => {
                    if (!res.writableEnded) {
                        cancelRequest('Client connection closed, cancelling LM request');
                    }
                };
                // 链接服务器级取消令牌：服务器停止时自动取消进行中的 LM 请求
                if (serverCancellationToken) {
                    if (serverCancellationToken.isCancellationRequested) {
                        cancelRequest('Server cancellation requested, cancelling LM request');
                    } else {
                        serverCancellationSubscription = serverCancellationToken.onCancellationRequested(() => {
                            cancelRequest('Server cancellation requested, cancelling LM request');
                        });
                    }
                }

                // 注册客户端断开事件监听
                req.once('aborted', cancelOnAborted);
                res.once('close', cancelOnClose);

                try {
                    // 发送 LM 请求，支持工具模式出错时的自动降级重试
                    // allowToolFallback 仅在有工具且非强制模式时为 true
                    const response = await this.sendRequestWithToolFallback(
                        selectedModel.vsCodeModel,
                        vsCodeMessages,
                        requestOptions,
                        requestCancellation.token,
                        requestLogger,
                        vsCodeTools.length > 0 && !requiresToolCall
                    );
                    
                    // 根据客户端请求的 stream 参数选择流式或非流式响应处理
                    if (isStream) {
                        await this.handleStreamingResponse(
                            response,
                            res,
                            context,
                            requestLogger,
                            requiresToolCall,
                            requiredModeParam
                        );
                    } else {
                        await this.handleNonStreamingResponse(
                            response,
                            res,
                            context,
                            requestLogger,
                            preferLegacyFunctionCall,
                            requiresToolCall,
                            requiredModeParam
                        );
                    }
                } finally {
                    // 清理事件监听器和取消令牌，防止资源泄漏
                    req.removeListener('aborted', cancelOnAborted);
                    res.removeListener('close', cancelOnClose);
                    serverCancellationSubscription?.dispose();
                    requestCancellation.dispose();
                }
                
            } catch (lmError) {
                requestLogger.error('VS Code LM API error:', lmError as Error);

                // 强制工具模式下的工具模式错误，返回明确的 400 错误
                if (requiresToolCall && vsCodeTools.length > 0 && this.isLikelyToolModeError(lmError)) {
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.BAD_REQUEST,
                        `Model failed to satisfy required tool-calling request: ${this.stringifyError(lmError)}`,
                        ERROR_CODES.INVALID_REQUEST,
                        requestId,
                        toolChoice !== undefined ? 'tool_choice' : 'function_call'
                    );
                    return;
                }
                
                // 将 VS Code LanguageModelError 映射为对应的 HTTP 状态码和错误码
                if (lmError instanceof vscode.LanguageModelError) {
                    this.handleLanguageModelError(lmError, res, requestId);
                } else {
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.BAD_GATEWAY,
                        `Language model request failed: ${lmError}`,
                        ERROR_CODES.API_ERROR,
                        requestId
                    );
                }
            }
            
        } catch (error) {
            // 顶层兜底错误处理：捕获所有未处理的异常，确保服务器永不崩溃
            const duration = Date.now() - startTime;
            requestLogger.error(`Request failed after ${duration}ms:`, error as Error);
            
            if (!res.headersSent) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.INTERNAL_SERVER_ERROR,
                    'Request processing failed',
                    ERROR_CODES.API_ERROR,
                    requestId
                );
            }
        }
    }
    
    /**
     * 处理模型列表端点 (/v1/models)
     *
     * 获取所有通过 ModelDiscoveryService 动态发现的可用模型，
     * 并将其转换为 OpenAI 兼容的模型列表响应格式。
     * 同时在日志中记录每个模型的能力信息以便排查问题。
     *
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 唯一请求标识符，用于日志追踪
     * @returns 处理完成的 Promise
     */
    public async handleModels(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        const requestLogger = logger.createRequestLogger(requestId);
        
        try {
            requestLogger.info('Fetching all available models...');
            
            // 获取所有动态发现的可用模型
            const allModels = this.modelDiscovery.getAllModels();
            
            requestLogger.info(`Found ${allModels.length} total models:`);
            
            // 逐个记录模型能力，便于调试和透明度
            allModels.forEach(model => {
                requestLogger.info(`  ${model.id}: tokens=${model.maxInputTokens}, vision=${model.supportsVision}, tools=${model.supportsTools}`);
            });
            
            const modelsResponse = Converter.createModelsResponse(allModels);
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(modelsResponse, null, 2));
            
            requestLogger.info(`Models response sent with ${modelsResponse.data.length} models`);
            
        } catch (error) {
            requestLogger.error('Error handling models request:', error as Error);
            this.sendErrorResponse(
                res,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                'Failed to retrieve models',
                ERROR_CODES.API_ERROR,
                requestId
            );
        }
    }
    
    /**
     * 处理健康检查端点 (/health)
     *
     * 返回服务器的基本健康状态和模型池信息。
     * 此端点不需要认证，可用于外部监控和负载均衡器探活。
     *
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 唯一请求标识符，用于日志追踪
     * @param serverState - 当前服务器状态信息（启动时间、请求计数等）
     * @returns 处理完成的 Promise
     */
    public async handleHealth(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string,
        serverState: ServerState
    ): Promise<void> {
        try {
            const modelPool = this.modelDiscovery.getModelPool();
            const healthResponse = Converter.createHealthResponse(serverState, modelPool);
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(healthResponse, null, 2));
            
        } catch (error) {
            this.sendErrorResponse(
                res,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                'Health check failed',
                ERROR_CODES.API_ERROR,
                requestId
            );
        }
    }
    
    /**
     * 处理详细状态端点 (/status)
     *
     * 返回服务器的完整运行状态，包括：
     * - 服务器状态（启动时间、请求计数等）
     * - 模型池统计（按优先级分类的模型数量、能力统计）
     * - 工具调用统计
     * - 功能特性标志
     * - Copilot 连接状态
     *
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 唯一请求标识符，用于日志追踪
     * @param serverState - 当前服务器状态信息
     * @returns 处理完成的 Promise
     */
    public async handleStatus(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string,
        serverState: ServerState
    ): Promise<void> {
        try {
            const modelPool = this.modelDiscovery.getModelPool();
            const toolStats = this.functionService.getToolStats();
            
            const status = {
                server: serverState,
                models: {
                    total: modelPool.primary.length + modelPool.secondary.length + modelPool.fallback.length,
                    primary: modelPool.primary.length,
                    secondary: modelPool.secondary.length,
                    fallback: modelPool.fallback.length,
                    unhealthy: modelPool.unhealthy.length,
                    lastUpdated: modelPool.lastUpdated.toISOString(),
                    capabilities: {
                        vision: modelPool.primary.filter(m => m.supportsVision).length,
                        tools: modelPool.primary.filter(m => m.supportsTools).length,
                        multimodal: modelPool.primary.filter(m => m.supportsMultimodal).length
                    }
                },
                tools: {
                    available: Object.keys(toolStats).length,
                    stats: toolStats
                },
                features: {
                    dynamicModelDiscovery: true,
                    multimodalSupport: true,
                    functionCalling: true,
                    noHardcodedLimitations: true,
                    loadBalancing: false
                },
                copilot: {
                    available: await this.checkCopilotAccess(),
                    models: await this.getModelCount()
                },
                timestamp: new Date().toISOString()
            };
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(status, null, 2));
            
        } catch (error) {
            this.sendErrorResponse(
                res,
                HTTP_STATUS.INTERNAL_SERVER_ERROR,
                'Status check failed',
                ERROR_CODES.API_ERROR,
                requestId
            );
        }
    }
    
    /**
     * 处理流式响应 (SSE - Server-Sent Events)
     *
     * 将 LM API 的响应流逐块转换为 SSE 格式发送给客户端。
     * 关键设计：SSE 响应头延迟到收到第一个数据块时才发送，
     * 这样在流开始前如果发生错误，仍可返回标准的 JSON 错误响应。
     *
     * 错误处理策略：
     * - 如果响应头尚未发送：返回标准 JSON 错误响应
     * - 如果响应头已发送：通过 SSE error 事件通知客户端
     * - 强制工具模式下模型未产生工具调用时，返回特定错误
     *
     * @param response - VS Code LM API 的响应对象，包含异步内容流
     * @param res - HTTP 响应对象
     * @param context - 增强请求上下文，包含请求 ID、模型信息等
     * @param requestLogger - 带请求 ID 的日志记录器
     * @param requiresToolCall - 是否为强制工具调用模式
     * @param requiredModeParam - 触发强制模式的参数名称（'tool_choice' 或 'function_call'）
     * @returns 处理完成的 Promise
     */
    private async handleStreamingResponse(
        response: vscode.LanguageModelChatResponse,
        res: http.ServerResponse,
        context: EnhancedRequestContext,
        requestLogger: RequestLogger,
        requiresToolCall: boolean,
        requiredModeParam: string
    ): Promise<void> {
        try {
            requestLogger.info('Starting streaming response...');

            let chunkCount = 0;

            // 遍历 Converter 产出的 SSE 数据块
            for await (const chunk of Converter.extractStreamContent(
                response,
                context,
                context.selectedModel!,
                {
                    requiresToolCall
                }
            )) {
                // 延迟发送 SSE 头部：直到收到第一个数据块才写入响应头
                // 这样流开始前的错误仍可返回标准 JSON 格式
                if (!res.headersSent) {
                    const sseHeaders = getSSEHeaders();
                    res.setHeader('Content-Type', CONTENT_TYPES.SSE);
                    res.setHeader('Cache-Control', sseHeaders['Cache-Control']);
                    res.setHeader('Connection', sseHeaders['Connection']);
                    res.setHeader('X-Accel-Buffering', sseHeaders['X-Accel-Buffering']);
                    res.writeHead(HTTP_STATUS.OK);
                }
                res.write(chunk);
                chunkCount++;
            }
            
            requestLogger.info(`Streaming completed: ${chunkCount} chunks sent`);
            
        } catch (error) {
            requestLogger.error('Streaming error:', error as Error);
            const errorText = this.stringifyError(error);
            if (requiresToolCall && errorText.includes('required tool mode')) {
                if (!res.headersSent) {
                    this.sendErrorResponse(
                        res,
                        HTTP_STATUS.BAD_REQUEST,
                        'Model did not produce any tool calls despite required mode',
                        ERROR_CODES.INVALID_REQUEST,
                        context.requestId,
                        requiredModeParam
                    );
                    return;
                }

                const errorEvent = Converter.createSSEEvent('error', {
                    message: 'Model did not produce any tool calls despite required mode',
                    type: ERROR_CODES.INVALID_REQUEST,
                    param: requiredModeParam
                });
                res.write(errorEvent);
                return;
            }

            if (!res.headersSent) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.BAD_GATEWAY,
                    'Stream processing error',
                    ERROR_CODES.API_ERROR,
                    context.requestId
                );
                return;
            }
            
            const errorEvent = Converter.createSSEEvent('error', {
                message: 'Stream processing error',
                type: ERROR_CODES.API_ERROR
            });
            res.write(errorEvent);
        } finally {
            // 确保响应流正确关闭，防止连接挂起
            if (!res.writableEnded) {
                res.end();
            }
        }
    }
    
    /**
     * 处理非流式响应
     *
     * 收集 LM API 的完整响应内容后，一次性构造 OpenAI 兼容的 JSON 响应返回。
     * 支持工具调用结果的提取，以及旧版 function_call 格式的兼容输出。
     *
     * @param response - VS Code LM API 的响应对象
     * @param res - HTTP 响应对象
     * @param context - 增强请求上下文
     * @param requestLogger - 带请求 ID 的日志记录器
     * @param preferLegacyFunctionCall - 是否优先使用旧版 function_call 格式（当客户端仅提供 functions 时）
     * @param requiresToolCall - 是否为强制工具调用模式
     * @param requiredModeParam - 触发强制模式的参数名称
     * @returns 处理完成的 Promise
     */
    private async handleNonStreamingResponse(
        response: vscode.LanguageModelChatResponse,
        res: http.ServerResponse,
        context: EnhancedRequestContext,
        requestLogger: RequestLogger,
        preferLegacyFunctionCall: boolean,
        requiresToolCall: boolean,
        requiredModeParam: string
    ): Promise<void> {
        try {
            requestLogger.info('Collecting full response...');
            
            // 收集完整响应内容和工具调用结果
            const fullResponse = await Converter.collectFullResponse(response);
            // 强制工具模式下，如果模型未产生任何工具调用则返回错误
            if (requiresToolCall && fullResponse.toolCalls.length === 0) {
                requestLogger.warn('Model returned no tool calls despite required mode');
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.BAD_REQUEST,
                    'Model did not produce any tool calls despite required mode',
                    ERROR_CODES.INVALID_REQUEST,
                    context.requestId,
                    requiredModeParam
                );
                return;
            }
            
            const completionResponse = Converter.createCompletionResponse(
                fullResponse.content, 
                context,
                context.selectedModel!,
                fullResponse.toolCalls,
                preferLegacyFunctionCall
            );
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(completionResponse, null, 2));
            
            requestLogger.info('Response sent:', {
                contentLength: fullResponse.content.length,
                toolCalls: fullResponse.toolCalls.length,
                tokens: completionResponse.usage.total_tokens,
                model: context.selectedModel!.id
            });
            
        } catch (error) {
            requestLogger.error('Error collecting response:', error as Error);
            throw error;
        }
    }

    /**
     * 判断当前请求是否为强制工具调用模式
     *
     * 强制工具调用模式意味着模型必须产生工具调用结果，不能自动降级为纯文本响应。
     * 以下情况被视为强制模式：
     * - tool_choice 为 'required'
     * - tool_choice 为指定具体工具的对象（如 {type: 'function', function: {name: 'xxx'}}）
     * - function_call 为指定具体函数的对象（旧版格式）
     *
     * @param toolChoice - 请求中的 tool_choice 参数
     * @param functionCall - 请求中的 function_call 参数（旧版格式）
     * @returns 如果是强制工具调用模式返回 true
     */
    private isRequiredToolMode(
        toolChoice: ValidatedRequest['tool_choice'],
        functionCall: ValidatedRequest['function_call']
    ): boolean {
        if (toolChoice === 'required') {
            return true;
        }
        if (toolChoice && typeof toolChoice === 'object') {
            return true;
        }
        if (functionCall && typeof functionCall === 'object') {
            return true;
        }
        return false;
    }

    /**
     * 发送 LM 请求，支持工具模式出错时的自动降级重试
     *
     * 当满足以下条件时，会自动去除工具配置重试一次：
     * - allowToolFallback 为 true（即非强制工具模式且有工具定义）
     * - 请求确实包含工具配置
     * - 请求未被取消
     * - 错误看起来与工具模式不兼容有关
     *
     * 这种降级机制允许在模型不支持工具时仍能返回纯文本响应，
     * 而不是直接报错，提升了兼容性。
     *
     * @param model - VS Code 语言模型实例
     * @param messages - 转换后的 VS Code 格式消息数组
     * @param requestOptions - 请求选项（包含工具配置）
     * @param token - 取消令牌，用于中断请求
     * @param requestLogger - 带请求 ID 的日志记录器
     * @param allowToolFallback - 是否允许工具降级重试
     * @returns LM API 的响应对象
     */
    private async sendRequestWithToolFallback(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        requestOptions: vscode.LanguageModelChatRequestOptions,
        token: vscode.CancellationToken,
        requestLogger: RequestLogger,
        allowToolFallback: boolean
    ): Promise<vscode.LanguageModelChatResponse> {
        try {
            // 首次尝试：带工具配置发送请求
            return await model.sendRequest(messages, requestOptions, token);
        } catch (error) {
            // 检查是否满足降级条件
            const hasTools = Array.isArray(requestOptions.tools) && requestOptions.tools.length > 0;
            if (
                !allowToolFallback ||
                !hasTools ||
                token.isCancellationRequested ||
                !this.isLikelyToolModeError(error)
            ) {
                // 不满足降级条件，直接抛出原始错误
                throw error;
            }

            requestLogger.warn('LM request with tools failed due probable tool-mode incompatibility, retrying once without tools', {
                error: String(error)
            });

            // 降级重试：移除工具和工具模式配置，仅保留其他选项
            const fallbackOptions: vscode.LanguageModelChatRequestOptions = {
                ...requestOptions,
                tools: undefined,
                toolMode: undefined
            };

            try {
                return await model.sendRequest(messages, fallbackOptions, token);
            } catch (fallbackError) {
                requestLogger.error('LM fallback request without tools also failed', fallbackError as Error);
                throw fallbackError;
            }
        }
    }

    /**
     * 判断错误是否与工具模式不兼容有关
     *
     * 通过检查错误消息中的关键词来推断是否为工具模式相关错误。
     * 匹配的关键词包括：toolmode、tool mode、tool_mode、tools are not supported、
     * does not support tools/function、function call is not supported 等。
     *
     * @param error - 捕获的错误对象
     * @returns 如果错误可能与工具模式不兼容有关返回 true
     */
    private isLikelyToolModeError(error: unknown): boolean {
        const message = this.stringifyError(error).toLowerCase();
        return (
            message.includes('toolmode') ||
            message.includes('tool mode') ||
            message.includes('tool_mode') ||
            message.includes('tools are not supported') ||
            message.includes('does not support tools') ||
            message.includes('does not support function') ||
            message.includes('function call is not supported') ||
            /\btool\s*(call|use|invocation)\b/.test(message)
        );
    }

    /**
     * 统一错误文本提取工具方法
     *
     * 将各种类型的错误对象安全地转换为字符串表示，
     * 用于日志记录和错误消息构造。
     *
     * @param error - 任意类型的错误对象
     * @returns 错误的字符串描述
     */
    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message || String(error);
        }
        return String(error);
    }
    
    /**
     * 检查 Copilot 访问权限（带 TTL 缓存）
     *
     * 通过 vscode.lm.selectChatModels 接口检查是否有可用的 Copilot 模型。
     * 检查结果会被缓存以避免频繁调用 API：
     * - 成功结果缓存 60 秒（COPILOT_ACCESS_SUCCESS_CACHE_TTL）
     * - 失败结果缓存 10 秒（COPILOT_ACCESS_FAILURE_CACHE_TTL），较短以便快速恢复
     *
     * @returns 如果 Copilot 可访问返回 true
     */
    private async checkCopilotAccess(): Promise<boolean> {
        const now = Date.now();
        // 缓存未过期时直接返回缓存结果
        if (this.copilotAccessCache && now < this.copilotAccessCache.expiry) {
            return this.copilotAccessCache.result;
        }

        try {
            // 尝试选择 vendor 为 copilot 的模型，有结果即表示可访问
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            const result = models.length > 0;
            // 根据结果选择不同的缓存 TTL
            const cacheTtl = result
                ? RequestHandler.COPILOT_ACCESS_SUCCESS_CACHE_TTL
                : RequestHandler.COPILOT_ACCESS_FAILURE_CACHE_TTL;
            this.copilotAccessCache = { result, expiry: now + cacheTtl };
            return result;
        } catch (error) {
            logger.warn('Copilot access check failed:', { error: String(error) });
            this.copilotAccessCache = { result: false, expiry: now + RequestHandler.COPILOT_ACCESS_FAILURE_CACHE_TTL };
            return false;
        }
    }
    
    /**
     * 获取当前可用的模型总数
     *
     * 通过 vscode.lm.selectChatModels 获取所有可用模型的数量，
     * 用于 /status 端点的 copilot.models 字段。
     *
     * @returns 可用模型数量；查询失败时返回 0
     */
    private async getModelCount(): Promise<number> {
        try {
            const models = await vscode.lm.selectChatModels();
            return models.length;
        } catch (error) {
            return 0;
        }
    }
    
    /**
     * 处理 VS Code LanguageModelError 的错误映射
     *
     * 将 VS Code 语言模型的错误码映射为对应的 HTTP 状态码和 OpenAI 错误码：
     * - NoPermissions -> 403 Forbidden (permission_error)
     * - Blocked -> 403 Forbidden (permission_error，内容过滤器拦截)
     * - NotFound -> 404 Not Found (not_found_error)
     * - ContextLengthExceeded -> 400 Bad Request (invalid_request_error)
     * - 其他 -> 502 Bad Gateway (api_error)
     *
     * @param error - VS Code LanguageModelError 实例
     * @param res - HTTP 响应对象
     * @param requestId - 唯一请求标识符，用于日志追踪
     */
    private handleLanguageModelError(
        error: vscode.LanguageModelError,
        res: http.ServerResponse,
        requestId: string
    ): void {
        let statusCode: number = HTTP_STATUS.INTERNAL_SERVER_ERROR;
        let errorCode: string = ERROR_CODES.API_ERROR;
        let message = error.message;
        
        // 增强错误映射：将 VS Code 错误码转换为 HTTP 状态码
        switch (error.code) {
            case 'NoPermissions':
                statusCode = HTTP_STATUS.FORBIDDEN;
                errorCode = ERROR_CODES.PERMISSION_ERROR;
                message = 'Permission denied for language model access';
                break;
            case 'Blocked':
                statusCode = HTTP_STATUS.FORBIDDEN;
                errorCode = ERROR_CODES.PERMISSION_ERROR;
                message = 'Request blocked by content filter';
                break;
            case 'NotFound':
                statusCode = HTTP_STATUS.NOT_FOUND;
                errorCode = ERROR_CODES.NOT_FOUND_ERROR;
                message = 'Language model not found';
                break;
            case 'ContextLengthExceeded':
                statusCode = HTTP_STATUS.BAD_REQUEST;
                errorCode = ERROR_CODES.INVALID_REQUEST;
                message = 'Request exceeds context length limit';
                break;
            default:
                statusCode = HTTP_STATUS.BAD_GATEWAY;
                errorCode = ERROR_CODES.API_ERROR;
                message = `Language model error: ${error.message}`;
        }
        
        this.sendErrorResponse(res, statusCode, message, errorCode, requestId);
    }
    
    /**
     * 发送标准化的 OpenAI 兼容错误响应
     *
     * 构造并发送符合 OpenAI API 错误格式的 JSON 响应。
     * 如果响应头已经发送（例如流式响应中途出错），则静默跳过。
     * 当状态码为 413 (Payload Too Large) 时，额外设置 Connection: close 头，
     * 提示客户端关闭连接。
     *
     * @param res - HTTP 响应对象
     * @param statusCode - HTTP 状态码
     * @param message - 错误描述信息
     * @param type - 错误类型码（如 'invalid_request_error'、'api_error' 等）
     * @param requestId - 唯一请求标识符，用于日志追踪
     * @param param - 可选，触发错误的参数名称
     */
    private sendErrorResponse(
        res: http.ServerResponse,
        statusCode: number,
        message: string,
        type: string,
        requestId: string,
        param?: string
    ): void {
        if (res.headersSent) {
            // 响应头已发送时无法再发送错误响应，静默跳过
            return;
        }
        
        // 通过 Converter 构造标准 OpenAI 错误响应体
        const errorResponse = Converter.createErrorResponse(message, type, undefined, param);

        const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPES.JSON };
        // 请求体超大时设置 Connection: close，提示客户端关闭连接
        if (statusCode === HTTP_STATUS.PAYLOAD_TOO_LARGE) {
            headers.Connection = 'close';
        }

        res.writeHead(statusCode, headers);
        res.end(JSON.stringify(errorResponse, null, 2));
        
        logger.error(`Error response: ${statusCode}`, new Error(message), { type, param }, requestId);
    }
    
    /**
     * 读取 HTTP 请求体（带大小限制）
     *
     * 以流式方式读取请求体数据，累计大小超过 LIMITS.MAX_REQUEST_BODY_BYTES（10MB）时
     * 立即停止读取并抛出 'Request body too large' 错误。
     *
     * 采用 settled 标志和 cleanup 函数确保 Promise 只被 resolve/reject 一次，
     * 并在完成后立即移除所有事件监听器，避免内存泄漏。
     *
     * @param req - HTTP 请求对象
     * @returns 请求体的 UTF-8 字符串
     * @throws Error('Request body too large') 当请求体超过大小限制时
     * @throws Error('Request aborted by client') 当客户端中途断开时
     */
    private async readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            /** 防止多次 resolve/reject 的标志 */
            let settled = false;

            /** 清理所有事件监听器 */
            const cleanup = () => {
                req.removeListener('data', onData);
                req.removeListener('end', onEnd);
                req.removeListener('error', onError);
                req.removeListener('aborted', onAborted);
            };

            /** 统一的失败处理：确保只触发一次 reject */
            const fail = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };

            /** 数据块到达处理：累计大小并检查限制 */
            const onData = (chunk: Buffer | string) => {
                const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                totalBytes += chunkBuffer.length;

                // 超过大小限制时，消耗剩余数据后销毁连接
                if (totalBytes > LIMITS.MAX_REQUEST_BODY_BYTES) {
                    req.resume();
                    req.once('end', () => {
                        if (!req.destroyed) {
                            req.destroy();
                        }
                    });
                    fail(new Error('Request body too large'));
                    return;
                }

                chunks.push(chunkBuffer);
            };

            /** 数据接收完成：拼接所有数据块并解码为 UTF-8 字符串 */
            const onEnd = () => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(Buffer.concat(chunks).toString('utf8'));
            };

            const onError = (error: Error) => fail(error);
            const onAborted = () => fail(new Error('Request aborted by client'));

            req.on('data', onData);
            req.once('end', onEnd);
            req.once('error', onError);
            req.once('aborted', onAborted);
        });
    }
    
    /**
     * 获取客户端 IP 地址
     *
     * 优先从 X-Forwarded-For 头部获取（支持反向代理场景），
     * 其次从 socket 连接获取，最后回退到 127.0.0.1。
     *
     * @param req - HTTP 请求对象
     * @returns 客户端 IP 地址字符串
     */
    private getClientIP(req: http.IncomingMessage): string {
        return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
               req.socket?.remoteAddress ||
               '127.0.0.1';
    }
    
    /**
     * 清理请求处理器持有的资源
     *
     * 释放 FunctionCallService 的资源。
     * 注意：ModelDiscoveryService 的生命周期由 CopilotServer 管理，此处不负责释放。
     */
    public dispose(): void {
        this.functionService.dispose();
    }
}
