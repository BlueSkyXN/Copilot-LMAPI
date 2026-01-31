/**
 * 🚀 革命性请求处理器
 * ✨ 完全重写，无硬编码限制！
 * 🎨 完整的多模态、函数调用和动态模型支持
 */

import * as http from 'http';
import * as vscode from 'vscode';

import { logger } from '../utils/Logger';
import { Converter } from '../utils/Converter';
import { Validator, ValidationError } from '../utils/Validator';
import { ModelDiscoveryService } from '../services/ModelDiscoveryService';
import { FunctionCallService } from '../services/FunctionCallService';

import {
    ModelCapabilities,
    EnhancedMessage,
    EnhancedRequestContext,
    FunctionDefinition,
    ToolCall
} from '../types/ModelCapabilities';

import { ServerState } from '../types/VSCode';
import { 
    HTTP_STATUS, 
    CONTENT_TYPES, 
    SSE_HEADERS,
    ERROR_CODES,
    NOTIFICATIONS
} from '../constants/Config';

export class RequestHandler {
    private modelDiscovery: ModelDiscoveryService;
    private functionService: FunctionCallService;
    private isInitialized: boolean = false;
    
    constructor() {
        this.modelDiscovery = new ModelDiscoveryService();
        this.functionService = new FunctionCallService();
        
        // 异步初始化
        this.initialize();
    }
    
    /**
     * 🚀 初始化处理器
     */
    private async initialize(): Promise<void> {
        try {
            logger.info('🚀 Initializing Enhanced Request Handler...');
            
            // 发现所有可用模型
            await this.modelDiscovery.discoverAllModels();
            
            this.isInitialized = true;
            logger.info('✅ Enhanced Request Handler initialized successfully!');
            
        } catch (error) {
            logger.error('❌ Failed to initialize Enhanced Request Handler:', error as Error);
        }
    }
    
    /**
     * 🎨 处理聊天完成，具备完整多模态支持
     */
    public async handleChatCompletions(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string,
        cancellationTokenSource: vscode.CancellationTokenSource
    ): Promise<void> {
        const requestLogger = logger.createRequestLogger(requestId);
        const startTime = Date.now();
        
        try {
            // 确保我们已初始化
            if (!this.isInitialized) {
                await this.initialize();
            }
            
            requestLogger.info('🚀 Processing enhanced chat completion request');
            
            // 读取并解析请求体并验证
            const body = await this.readRequestBody(req);
            
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
            let validatedRequest: any;
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
            
            const requestData = validatedRequest;
            
            // 提取增强消息和请求参数
            const messages: EnhancedMessage[] = requestData.messages;
            const requestedModel = requestData.model;
            const isStream = requestData.stream || false;
            const functions: FunctionDefinition[] = requestData.functions || [];
            const tools = requestData.tools || [];
            
            requestLogger.info('📋 Request analysis:', {
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
            
            // 🎯 仅允许直接使用请求的模型（完全移除自动选择）
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
            requestLogger.info('✅ Model direct:', {
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
            
            // 如果支持则准备工具
            let vsCodeTools: any[] = [];
            if (selectedModel.supportsTools && (functions.length > 0 || tools.length > 0)) {
                try {
                    vsCodeTools = this.functionService.convertFunctionsToTools(functions);
                    requestLogger.info(`🛠️ Prepared ${vsCodeTools.length} tools for execution`);
                } catch (error) {
                    requestLogger.warn('Failed to prepare tools:', { error: String(error) });
                }
            }
            
            // 🚀 向 VS CODE LM API 发送请求
            try {
                requestLogger.info('📨 Sending request to VS Code LM API...');
                
                const requestOptions: any = {
                    tools: vsCodeTools.length > 0 ? vsCodeTools : undefined
                };
                
                const response = await selectedModel.vsCodeModel.sendRequest(
                    vsCodeMessages,
                    requestOptions,
                    cancellationTokenSource.token
                );
                
                // 🌊 处理流式与非流式响应
                if (isStream) {
                    await this.handleStreamingResponse(response, res, context, requestLogger);
                } else {
                    await this.handleNonStreamingResponse(response, res, context, requestLogger);
                }
                
            } catch (lmError) {
                requestLogger.error('❌ VS Code LM API error:', lmError as Error);
                
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
            requestLogger.error(`❌ Request failed after ${duration}ms:`, error as Error);
            
            if (!res.headersSent) {
                this.sendErrorResponse(
                    res,
                    HTTP_STATUS.INTERNAL_SERVER_ERROR,
                    'Enhanced request processing failed',
                    ERROR_CODES.API_ERROR,
                    requestId
                );
            }
        }
    }
    
    /**
     * 📋 处理增强模型端点
     */
    public async handleModels(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        const requestLogger = logger.createRequestLogger(requestId);
        
        try {
            requestLogger.info('📋 Fetching all available models (no limitations!)...');
            
            // 确保我们已初始化
            if (!this.isInitialized) {
                await this.initialize();
            }
            
            // 获取所有可用模型
            const allModels = this.modelDiscovery.getAllModels();
            
            requestLogger.info(`📊 Found ${allModels.length} total models:`);
            
            // 为透明度记录模型能力
            allModels.forEach(model => {
                requestLogger.info(`  ✨ ${model.id}: tokens=${model.maxInputTokens}, vision=${model.supportsVision}, tools=${model.supportsTools}`);
            });
            
            const modelsResponse = Converter.createModelsResponse(allModels);
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(modelsResponse, null, 2));
            
            requestLogger.info(`✅ Models response sent with ${modelsResponse.data.length} models`);
            
        } catch (error) {
            requestLogger.error('❌ Error handling models request:', error as Error);
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
     * 👩‍⚕️ 增强健康检查
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
     * 📋 增强状态端点
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
                    autoModelSelection: true,
                    loadBalancing: true
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
     * 🌊 处理增强流式响应
     */
    private async handleStreamingResponse(
        response: vscode.LanguageModelChatResponse,
        res: http.ServerResponse,
        context: EnhancedRequestContext,
        requestLogger: any
    ): Promise<void> {
        res.writeHead(HTTP_STATUS.OK, SSE_HEADERS);
        
        try {
            requestLogger.info('🌊 Starting enhanced streaming response...');
            
            let chunkCount = 0;
            
            for await (const chunk of Converter.extractStreamContent(
                response, 
                context, 
                context.selectedModel!
            )) {
                res.write(chunk);
                chunkCount++;
            }
            
            requestLogger.info(`✅ Enhanced streaming completed: ${chunkCount} chunks sent`);
            
        } catch (error) {
            requestLogger.error('❌ Enhanced streaming error:', error);
            
            const errorEvent = Converter.createSSEEvent('error', {
                message: 'Enhanced stream processing error',
                type: ERROR_CODES.API_ERROR
            });
            res.write(errorEvent);
        } finally {
            res.end();
        }
    }
    
    /**
     * 📋 处理增强非流式响应
     */
    private async handleNonStreamingResponse(
        response: vscode.LanguageModelChatResponse,
        res: http.ServerResponse,
        context: EnhancedRequestContext,
        requestLogger: any
    ): Promise<void> {
        try {
            requestLogger.info('📋 Collecting enhanced full response...');
            
            const fullContent = await Converter.collectFullResponse(response);
            
            const completionResponse = Converter.createCompletionResponse(
                fullContent, 
                context,
                context.selectedModel!
            );
            
            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': CONTENT_TYPES.JSON });
            res.end(JSON.stringify(completionResponse, null, 2));
            
            requestLogger.info('✅ Enhanced response sent:', {
                contentLength: fullContent.length,
                tokens: completionResponse.usage.total_tokens,
                model: context.selectedModel!.id
            });
            
        } catch (error) {
            requestLogger.error('❌ Error collecting enhanced response:', error as Error);
            throw error;
        }
    }
    
    /**
     * 🔮 检查 Copilot 访问权限
     */
    private async checkCopilotAccess(): Promise<boolean> {
        try {
            const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
            return models.length > 0;
        } catch (error) {
            logger.warn('Copilot access check failed:', { error: String(error) });
            return false;
        }
    }
    
    /**
     * 📋 获取模型总数
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
     * ❌ 处理 VS Code 语言模型特定错误
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
     * ❌ 发送增强错误响应
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
        
        res.writeHead(statusCode, { 'Content-Type': CONTENT_TYPES.JSON });
        res.end(JSON.stringify(errorResponse, null, 2));
        
        logger.error(`❌ Enhanced error response: ${statusCode}`, new Error(message), { type, param }, requestId);
    }
    
    /**
     * 📋 读取请求体 - 使用高效的缓冲区收集
     */
    private async readRequestBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let totalSize = 0;
            const MAX_BODY_SIZE = 50 * 1024 * 1024; // 50MB limit for images
            let isRejected = false;
            
            const cleanup = () => {
                req.removeAllListeners('data');
                req.removeAllListeners('end');
                req.removeAllListeners('error');
            };
            
            req.on('data', (chunk: Buffer) => {
                if (isRejected) {
                    return;
                }
                
                totalSize += chunk.length;
                
                // Check size limit BEFORE adding to array
                if (totalSize > MAX_BODY_SIZE) {
                    isRejected = true;
                    cleanup();
                    req.destroy();
                    reject(new Error('Request body too large'));
                    return;
                }
                
                chunks.push(chunk);
            });
            
            req.on('end', () => {
                if (!isRejected) {
                    cleanup();
                    // Efficient one-time concatenation
                    const body = Buffer.concat(chunks, totalSize).toString('utf8');
                    resolve(body);
                }
            });
            
            req.on('error', (error) => {
                if (!isRejected) {
                    isRejected = true;
                    cleanup();
                    reject(error);
                }
            });
        });
    }
    
    /**
     * 📍 获取客户端IP地址
     */
    private getClientIP(req: http.IncomingMessage): string {
        return (req.headers['x-forwarded-for'] as string)?.split(',')[0] ||
               req.connection.remoteAddress ||
               '127.0.0.1';
    }
    
    /**
     * 🧹 清理资源
     */
    public dispose(): void {
        this.modelDiscovery.dispose();
        this.functionService.dispose();
    }
}
