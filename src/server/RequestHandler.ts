/**
 * 请求处理器
 * 多模态、函数调用和动态模型支持
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

export class RequestHandler {
    private modelDiscovery: ModelDiscoveryService;
    private functionService: FunctionCallService;
    private isInitialized: boolean = false;
    private copilotAccessCache: { result: boolean; expiry: number } | null = null;
    private static readonly COPILOT_ACCESS_SUCCESS_CACHE_TTL = 60_000; // 60 seconds
    private static readonly COPILOT_ACCESS_FAILURE_CACHE_TTL = 10_000; // 10 seconds

    constructor(modelDiscovery: ModelDiscoveryService) {
        this.modelDiscovery = modelDiscovery;
        this.functionService = new FunctionCallService();
    }

    /**
     * 初始化处理器（由 CopilotServer.start() 显式调用）
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
     * 处理聊天完成，具备完整多模态支持
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
            
            // 读取并解析请求体并验证
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
            
            // 解析JSON并处理错误
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
            
            // 使用验证器验证请求
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
            
            const requestData: ValidatedRequest = validatedRequest;
            
            // 提取增强消息和请求参数
            const messages: EnhancedMessage[] = requestData.messages;
            const requestedModel = requestData.model;
            const isStream = requestData.stream || false;
            const functions = requestData.functions || [];
            const tools: OpenAITool[] = requestData.tools || [];
            const toolChoice = requestData.tool_choice;
            const functionCall = requestData.function_call;
            const preferLegacyFunctionCall = functions.length > 0 && tools.length === 0;
            const requiresToolCall = this.isRequiredToolMode(toolChoice, functionCall);
            const requiredModeParam = toolChoice !== undefined ? 'tool_choice' : 'function_call';
            
            requestLogger.info('Request analysis:', {
                model: requestedModel,
                stream: isStream,
                messageCount: messages.length,
                hasImages: messages.some(m => Array.isArray(m.content) && 
                    m.content.some(p => p.type === 'image_url')),
                hasFunctions: functions.length > 0 || tools.length > 0
            });
            
            // 创建增强上下文
            const context = Converter.createEnhancedContext(
                requestId,
                requestedModel,
                isStream,
                messages,
                undefined, // Will be set after model selection
                this.getClientIP(req),
                req.headers['user-agent']
            );
            
            // 仅允许直接使用请求的模型（完全移除自动选择）
            let selectedModel: ModelCapabilities | null = this.modelDiscovery.getModel(requestedModel) || null;
            if (!selectedModel) {
                // 如果找不到模型，尝试重新发现模型
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
            
            // 用所选模型更新上下文
            context.selectedModel = selectedModel;
            
            // 始终 direct：日志清晰表明使用请求的模型
            requestLogger.info('Model direct:', {
                model: requestedModel,
                vendor: selectedModel.vendor,
                family: selectedModel.family,
                maxTokens: selectedModel.maxInputTokens,
                supportsVision: selectedModel.supportsVision,
                supportsTools: selectedModel.supportsTools
            });
            
            // 检查 Copilot 访问权限
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
            
            // 验证上下文窗口限制（动态！）
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
            
            // 将消息转换为 VS Code 格式
            const vsCodeMessages = await Converter.convertMessagesToVSCode(
                messages, 
                selectedModel
            );
            
            // 如果请求包含工具定义，则准备 VS Code 工具配置
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

            if (!selectedModel.supportsTools && vsCodeTools.length > 0) {
                requestLogger.warn('Model capability probe reports supportsTools=false, continuing with runtime attempt', {
                    model: selectedModel.id,
                    requiredToolMode: requiresToolCall,
                    tools: vsCodeTools.length
                });
            }
            
            // 向 VS CODE LM API 发送请求
            try {
                requestLogger.info('Sending request to VS Code LM API...');
                
                const requestOptions: vscode.LanguageModelChatRequestOptions = {};
                if (vsCodeTools.length > 0) {
                    requestOptions.tools = vsCodeTools;
                }
                if (toolMode && vsCodeTools.length > 0) {
                    requestOptions.toolMode = toolMode;
                }
                const requestCancellation = new vscode.CancellationTokenSource();
                let serverCancellationSubscription: vscode.Disposable | undefined;
                const cancelRequest = (reason: string) => {
                    if (!requestCancellation.token.isCancellationRequested) {
                        requestLogger.warn(reason);
                        requestCancellation.cancel();
                    }
                };
                const cancelOnAborted = () => {
                    cancelRequest('Client request aborted, cancelling LM request');
                };
                const cancelOnClose = () => {
                    if (!res.writableEnded) {
                        cancelRequest('Client connection closed, cancelling LM request');
                    }
                };
                if (serverCancellationToken) {
                    if (serverCancellationToken.isCancellationRequested) {
                        cancelRequest('Server cancellation requested, cancelling LM request');
                    } else {
                        serverCancellationSubscription = serverCancellationToken.onCancellationRequested(() => {
                            cancelRequest('Server cancellation requested, cancelling LM request');
                        });
                    }
                }

                req.once('aborted', cancelOnAborted);
                res.once('close', cancelOnClose);

                try {
                    const response = await this.sendRequestWithToolFallback(
                        selectedModel.vsCodeModel,
                        vsCodeMessages,
                        requestOptions,
                        requestCancellation.token,
                        requestLogger,
                        vsCodeTools.length > 0 && !requiresToolCall
                    );
                    
                    // 处理流式与非流式响应
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
                    req.removeListener('aborted', cancelOnAborted);
                    res.removeListener('close', cancelOnClose);
                    serverCancellationSubscription?.dispose();
                    requestCancellation.dispose();
                }
                
            } catch (lmError) {
                requestLogger.error('VS Code LM API error:', lmError as Error);

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
                
                // 使用增强错误映射处理特定的 LM API 错误
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
     * 处理增强模型端点
     */
    public async handleModels(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        const requestLogger = logger.createRequestLogger(requestId);
        
        try {
            requestLogger.info('Fetching all available models...');
            
            // 获取所有可用模型
            const allModels = this.modelDiscovery.getAllModels();
            
            requestLogger.info(`Found ${allModels.length} total models:`);
            
            // 为透明度记录模型能力
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
     * 增强健康检查
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
     * 增强状态端点
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
     * 处理增强流式响应
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

            for await (const chunk of Converter.extractStreamContent(
                response,
                context,
                context.selectedModel!,
                {
                    requiresToolCall
                }
            )) {
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
            if (!res.writableEnded) {
                res.end();
            }
        }
    }
    
    /**
     * 处理增强非流式响应
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
            
            const fullResponse = await Converter.collectFullResponse(response);
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
     * 是否为强制工具调用语义（不能自动降级）
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
     * 发送请求：工具失败时可选自动降级重试一次
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
            return await model.sendRequest(messages, requestOptions, token);
        } catch (error) {
            const hasTools = Array.isArray(requestOptions.tools) && requestOptions.tools.length > 0;
            if (
                !allowToolFallback ||
                !hasTools ||
                token.isCancellationRequested ||
                !this.isLikelyToolModeError(error)
            ) {
                throw error;
            }

            requestLogger.warn('LM request with tools failed due probable tool-mode incompatibility, retrying once without tools', {
                error: String(error)
            });

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
     * 判断是否是工具模式相关错误（用于控制是否降级）
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
     * 统一错误文本提取
     */
    private stringifyError(error: unknown): string {
        if (error instanceof Error) {
            return error.message || String(error);
        }
        return String(error);
    }
    
    /**
     * 检查 Copilot 访问权限（带 TTL 缓存，避免每次请求都调用 API）
     */
    private async checkCopilotAccess(): Promise<boolean> {
        const now = Date.now();
        if (this.copilotAccessCache && now < this.copilotAccessCache.expiry) {
            return this.copilotAccessCache.result;
        }

        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            const result = models.length > 0;
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
     * 获取模型总数
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
     * 处理 VS Code 语言模型特定错误
     */
    private handleLanguageModelError(
        error: vscode.LanguageModelError,
        res: http.ServerResponse,
        requestId: string
    ): void {
        let statusCode: number = HTTP_STATUS.INTERNAL_SERVER_ERROR;
        let errorCode: string = ERROR_CODES.API_ERROR;
        let message = error.message;
        
        // 增强错误映射
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
     * 发送增强错误响应
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
            return;
        }
        
        const errorResponse = Converter.createErrorResponse(message, type, undefined, param);

        const headers: Record<string, string> = { 'Content-Type': CONTENT_TYPES.JSON };
        if (statusCode === HTTP_STATUS.PAYLOAD_TOO_LARGE) {
            headers.Connection = 'close';
        }

        res.writeHead(statusCode, headers);
        res.end(JSON.stringify(errorResponse, null, 2));
        
        logger.error(`Error response: ${statusCode}`, new Error(message), { type, param }, requestId);
    }
    
    /**
     * 读取请求体
     */
    private async readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            let settled = false;

            const cleanup = () => {
                req.removeListener('data', onData);
                req.removeListener('end', onEnd);
                req.removeListener('error', onError);
                req.removeListener('aborted', onAborted);
            };

            const fail = (error: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(error);
            };

            const onData = (chunk: Buffer | string) => {
                const chunkBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                totalBytes += chunkBuffer.length;

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
     * 获取客户端IP地址
     */
    private getClientIP(req: http.IncomingMessage): string {
        return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
               req.socket?.remoteAddress ||
               '127.0.0.1';
    }
    
    /**
     * 清理资源（ModelDiscoveryService 由 CopilotServer 管理，此处不 dispose）
     */
    public dispose(): void {
        this.functionService.dispose();
    }
}
