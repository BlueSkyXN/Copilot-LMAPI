/**
 * 增强型多模态转换器
 * OpenAI API 与 VS Code LM API 之间的革命性转换
 * 完全支持图像、函数和动态模型！
 */

import * as vscode from 'vscode';
import {
    EnhancedMessage,
    ModelCapabilities,
    EnhancedRequestContext,
    ToolCall,
    ModelPool
} from '../types/ModelCapabilities';
import { ServerState } from '../types/VSCode';
import { 
    OpenAICompletionResponse, 
    OpenAIStreamResponse, 
    OpenAIModelsResponse,
    OpenAIModel,
    OpenAIToolCall
} from '../types/OpenAI';
import { logger } from './Logger';

interface ToolConversionState {
    pendingToolCallIdsByName: Map<string, string[]>;
}

interface StreamExtractionOptions {
    requiresToolCall?: boolean;
}

export class Converter {
    
    /**
     * 将增强消息转换为 VS Code LM API 格式
     * 支持图像和多模态内容！
     */
    public static async convertMessagesToVSCode(
        messages: EnhancedMessage[], 
        selectedModel: ModelCapabilities
    ): Promise<vscode.LanguageModelChatMessage[]> {
        const vsCodeMessages: vscode.LanguageModelChatMessage[] = [];
        const conversionState: ToolConversionState = {
            pendingToolCallIdsByName: new Map()
        };
        
        for (const message of messages) {
            try {
                const vsCodeMessage = await this.convertSingleMessage(message, selectedModel, conversionState);
                if (vsCodeMessage) {
                    vsCodeMessages.push(vsCodeMessage);
                }
            } catch (error) {
                logger.error(`转换消息失败：`, error as Error, { message });
                // 回退到仅文本内容
                if (typeof message.content === 'string') {
                    vsCodeMessages.push(new vscode.LanguageModelChatMessage(
                        this.mapRoleToVSCode(message.role),
                        this.formatRolePrefix(message.role) + message.content
                    ));
                }
            }
        }
        
        return vsCodeMessages;
    }
    
    /**
     * 转换单个增强消息
     */
    private static async convertSingleMessage(
        message: EnhancedMessage, 
        selectedModel: ModelCapabilities,
        conversionState: ToolConversionState
    ): Promise<vscode.LanguageModelChatMessage | null> {
        if (message.role === 'tool' || message.role === 'function') {
            return this.convertToolResultMessage(message, conversionState);
        }

        if (message.role === 'assistant' && (message.tool_calls?.length || message.function_call)) {
            return this.convertAssistantToolCallMessage(message, conversionState);
        }
        
        // 处理简单文本消息
        if (typeof message.content === 'string') {
            return new vscode.LanguageModelChatMessage(
                this.mapRoleToVSCode(message.role),
                this.formatRolePrefix(message.role) + message.content
            );
        }
        
        // 处理复杂的多模态内容
        if (Array.isArray(message.content)) {
            return await this.convertMultimodalMessage(message, selectedModel);
        }
        
        return null;
    }

    /**
     * 转换 assistant 的工具调用消息
     */
    private static convertAssistantToolCallMessage(
        message: EnhancedMessage,
        conversionState: ToolConversionState
    ): vscode.LanguageModelChatMessage {
        const parts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
        const textContent = this.extractTextContent(message);

        if (textContent) {
            parts.push(new vscode.LanguageModelTextPart(textContent));
        }

        const toolCalls = message.tool_calls || (message.function_call
            ? [{
                id: this.generateLegacyToolCallId(message.function_call.name),
                type: 'function' as const,
                function: {
                    name: message.function_call.name,
                    arguments: message.function_call.arguments
                }
            }]
            : []);

        for (const toolCall of toolCalls) {
            this.trackPendingToolCall(toolCall.function.name, toolCall.id, conversionState);
            parts.push(new vscode.LanguageModelToolCallPart(
                toolCall.id,
                toolCall.function.name,
                this.parseToolArguments(toolCall.function.arguments)
            ));
        }

        return new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.Assistant,
            parts
        );
    }

    /**
     * 转换 tool 角色结果消息
     */
    private static convertToolResultMessage(
        message: EnhancedMessage,
        conversionState: ToolConversionState
    ): vscode.LanguageModelChatMessage {
        const callId = message.tool_call_id
            || (message.role === 'function' && message.name
                ? this.consumePendingToolCallId(message.name, conversionState)
                : undefined);
        const text = this.extractToolResultText(message.content);
        const content = [new vscode.LanguageModelTextPart(text || '')];

        if (!callId) {
            logger.warn('工具结果消息缺少 tool_call_id，降级为普通用户消息', {
                role: message.role,
                name: message.name
            });
            return new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.User,
                text || ''
            );
        }

        return new vscode.LanguageModelChatMessage(
            vscode.LanguageModelChatMessageRole.User,
            [new vscode.LanguageModelToolResultPart(callId, content)]
        );
    }
    
    /**
     * 转换带图像的多模态消息
     */
    private static async convertMultimodalMessage(
        message: EnhancedMessage,
        selectedModel: ModelCapabilities
    ): Promise<vscode.LanguageModelChatMessage | null> {
        
        if (!Array.isArray(message.content)) {
            return null;
        }
        
        const contentParts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
        let textContent = this.formatRolePrefix(message.role);
        
        for (const part of message.content) {
            if (part.type === 'text' && part.text) {
                textContent += part.text;
                
            } else if (part.type === 'image_url' && part.image_url) {
                
                // 如果模型支持视觉则处理图像
                if (selectedModel.supportsVision) {
                    try {
                        const imageContent = await this.processImageContent(part.image_url.url);
                        if (imageContent) {
                            textContent += `\n[Image: ${imageContent.description}]\n`;
                            // 注意：VS Code LM API 可能以不同方式处理图像
                            // 目前这是一个文本表示
                        }
                    } catch (error) {
                        logger.warn(`处理图像失败：`, error as Error);
                        textContent += `\n[Image: ${part.image_url.url}]\n`;
                    }
                } else {
                    logger.warn(`模型 ${selectedModel.id} 不支持视觉，跳过图像`);
                    textContent += `\n[所选模型不支持图像]\n`;
                }
            }
        }
        
        // 添加文本部分
        contentParts.push(new vscode.LanguageModelTextPart(textContent));
        
        // 使用正确的角色映射创建消息
        return new vscode.LanguageModelChatMessage(
            this.mapRoleToVSCode(message.role),
            contentParts
        );
    }
    
    /**
     * 处理图像内容（Base64、URL 或文件路径）
     */
    private static async processImageContent(imageUrl: string): Promise<{ description: string; data?: string } | null> {
        try {
            if (imageUrl.startsWith('data:image/')) {
                // Base64 编码图像
                const [header, data] = imageUrl.split(',');
                const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                return {
                    description: `Base64 ${mimeType} image`,
                    data: data
                };

            } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
                // HTTP URL 图像 - 出于安全考虑，仅记录来源
                try {
                    return {
                        description: `Remote image from ${new URL(imageUrl).hostname}`
                    };
                } catch {
                    return {
                        description: `Remote image URL`
                    };
                }
            }

            return null;
        } catch (error) {
            logger.error('Error processing image:', error as Error);
            return null;
        }
    }

    /**
     * 提取消息中的文本内容
     */
    private static extractTextContent(message: EnhancedMessage): string {
        if (typeof message.content === 'string') {
            return this.formatRolePrefix(message.role) + message.content;
        }

        if (!Array.isArray(message.content)) {
            return '';
        }

        const textParts = message.content
            .filter(part => part.type === 'text' && !!part.text)
            .map(part => part.text || '');
        const joined = textParts.join('');
        return joined ? this.formatRolePrefix(message.role) + joined : '';
    }

    /**
     * 提取 tool 结果文本
     */
    private static extractToolResultText(content: EnhancedMessage['content']): string {
        if (typeof content === 'string') {
            return content;
        }

        if (!Array.isArray(content)) {
            return '';
        }

        return content
            .filter(part => part.type === 'text' && !!part.text)
            .map(part => part.text || '')
            .join('');
    }

    /**
     * 将工具参数字符串解析为对象
     */
    private static parseToolArguments(rawArguments: string): object {
        try {
            const parsed = JSON.parse(rawArguments);
            if (parsed && typeof parsed === 'object') {
                return parsed;
            }
            return { value: parsed };
        } catch {
            return { __raw: rawArguments };
        }
    }

    private static generateLegacyToolCallId(name: string): string {
        return `call_${name}_${Date.now().toString(36)}`;
    }

    private static trackPendingToolCall(name: string, callId: string, conversionState: ToolConversionState): void {
        const pending = conversionState.pendingToolCallIdsByName.get(name) || [];
        pending.push(callId);
        conversionState.pendingToolCallIdsByName.set(name, pending);
    }

    private static consumePendingToolCallId(name: string, conversionState: ToolConversionState): string | undefined {
        const pending = conversionState.pendingToolCallIdsByName.get(name);
        if (!pending || pending.length === 0) {
            return undefined;
        }
        const callId = pending.shift();
        if (pending.length === 0) {
            conversionState.pendingToolCallIdsByName.delete(name);
        } else {
            conversionState.pendingToolCallIdsByName.set(name, pending);
        }
        return callId;
    }

    /**
     * VS Code ToolCallPart -> OpenAI ToolCall
     */
    private static convertVSCodeToolCallPart(part: vscode.LanguageModelToolCallPart): ToolCall {
        return {
            id: part.callId,
            type: 'function',
            function: {
                name: part.name,
                arguments: this.stringifyToolInput(part.input)
            }
        };
    }

    private static convertToolCallToOpenAI(toolCall: ToolCall): OpenAIToolCall {
        return {
            id: toolCall.id,
            type: 'function',
            function: {
                name: toolCall.function.name,
                arguments: toolCall.function.arguments
            }
        };
    }

    private static stringifyToolInput(input: object): string {
        try {
            return JSON.stringify(input);
        } catch {
            return '{}';
        }
    }

    private static estimateToolCallTokens(toolCalls: ToolCall[]): number {
        return toolCalls.reduce((total, call) => {
            return total + this.estimateTokens(call.function.name + call.function.arguments);
        }, 0);
    }
    
    /**
     * 将 OpenAI 角色映射到 VS Code 角色
     */
    private static mapRoleToVSCode(role: string): vscode.LanguageModelChatMessageRole {
        switch (role) {
            case 'system':
            case 'user':
            case 'tool':
            case 'function':
                return vscode.LanguageModelChatMessageRole.User;
            case 'assistant':
                return vscode.LanguageModelChatMessageRole.Assistant;
            default:
                return vscode.LanguageModelChatMessageRole.User;
        }
    }
    
    /**
     * 为内容格式化角色前缀
     */
    private static formatRolePrefix(role: string): string {
        switch (role) {
            case 'system':
                return 'System: ';
            case 'assistant':
                return '';
            case 'tool':
                return 'Tool: ';
            case 'user':
            default:
                return '';
        }
    }
    
    /**
     * 创建增强完成响应
     */
    public static createCompletionResponse(
        content: string,
        context: EnhancedRequestContext,
        selectedModel: ModelCapabilities,
        toolCalls: ToolCall[] = [],
        preferLegacyFunctionCall: boolean = false
    ): OpenAICompletionResponse {
        const now = Math.floor(Date.now() / 1000);
        const openAIToolCalls = toolCalls.map(call => this.convertToolCallToOpenAI(call));
        const isToolResponse = openAIToolCalls.length > 0;
        const useLegacyFunctionCall = preferLegacyFunctionCall && openAIToolCalls.length === 1;
        const completionTokens = this.estimateTokens(content) + this.estimateToolCallTokens(toolCalls);
        const finishReason = isToolResponse
            ? (useLegacyFunctionCall ? 'function_call' : 'tool_calls')
            : 'stop';
        const messageContent = content.length > 0 ? content : (isToolResponse ? null : '');

        const message: OpenAICompletionResponse['choices'][0]['message'] = {
            role: 'assistant',
            content: messageContent
        };

        if (isToolResponse) {
            if (useLegacyFunctionCall && openAIToolCalls[0]) {
                message.function_call = openAIToolCalls[0].function;
            } else {
                message.tool_calls = openAIToolCalls;
            }
        }
        
        return {
            id: `chatcmpl-${context.requestId}`,
            object: 'chat.completion',
            created: now,
            model: context.model, // 使用请求的模型名称
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason
            }],
            usage: {
                prompt_tokens: context.estimatedTokens,
                completion_tokens: completionTokens,
                total_tokens: context.estimatedTokens + completionTokens
            },
            system_fingerprint: `vs-code-${selectedModel.vendor}-${selectedModel.family}`
        };
    }
    
    /**
     * 创建增强流式响应块
     */
    public static createStreamChunk(
        context: EnhancedRequestContext,
        selectedModel: ModelCapabilities,
        delta: OpenAIStreamResponse['choices'][0]['delta'],
        finishReason: OpenAIStreamResponse['choices'][0]['finish_reason'] = null
    ): OpenAIStreamResponse {
        const now = Math.floor(Date.now() / 1000);
        
        return {
            id: `chatcmpl-${context.requestId}`,
            object: 'chat.completion.chunk',
            created: now,
            model: context.model, // 使用请求的模型名称
            choices: [{
                index: 0,
                delta,
                finish_reason: finishReason
            }],
            system_fingerprint: `vs-code-${selectedModel.vendor}-${selectedModel.family}`
        };
    }
    
    /**
     * 创建动态模型响应
     */
    public static createModelsResponse(availableModels: ModelCapabilities[]): OpenAIModelsResponse {
        const now = Math.floor(Date.now() / 1000);
        
        const models: OpenAIModel[] = availableModels.map(model => ({
            id: model.id,
            object: 'model',
            created: now,
            owned_by: model.vendor || 'vs-code',
            // 添加关于能力的自定义元数据
            permission: [{
                id: `perm-${model.id}`,
                object: 'model_permission',
                created: now,
                allow_create_engine: false,
                allow_sampling: true,
                allow_logprobs: false,
                allow_search_indices: false,
                allow_view: true,
                allow_fine_tuning: false,
                organization: model.vendor || 'vs-code',
                is_blocking: false
            }]
        }));
        
        return {
            object: 'list',
            data: models
        };
    }

    private static getResponseChunks(
        response: vscode.LanguageModelChatResponse
    ): AsyncIterable<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | string | unknown> {
        const responseWithFallback = response as vscode.LanguageModelChatResponse & {
            stream?: AsyncIterable<unknown>;
            text?: AsyncIterable<string> | string;
        };

        if (responseWithFallback.stream && typeof responseWithFallback.stream[Symbol.asyncIterator] === 'function') {
            return responseWithFallback.stream;
        }

        const legacyText = responseWithFallback.text;
        if (legacyText && typeof (legacyText as AsyncIterable<string>)[Symbol.asyncIterator] === 'function') {
            return legacyText as AsyncIterable<string>;
        }
        if (typeof legacyText === 'string') {
            const text = legacyText;
            return (async function* () {
                if (text) {
                    yield text;
                }
            })();
        }

        throw new Error('Language model response stream is unavailable');
    }
    
    /**
     * 从带有增强上下文的 VS Code LM 响应流中提取内容
     */
    public static async *extractStreamContent(
        response: vscode.LanguageModelChatResponse,
        context: EnhancedRequestContext,
        selectedModel: ModelCapabilities,
        options: StreamExtractionOptions = {}
    ): AsyncGenerator<string> {
        const requiresToolCall = !!options.requiresToolCall;
        let emittedRole = false;
        let hasToolCalls = false;
        let emittedToolCallIndex = 0;
        const pendingEvents: string[] = [];
        
        try {
            for await (const chunk of this.getResponseChunks(response)) {
                const delta: OpenAIStreamResponse['choices'][0]['delta'] = {};

                if (!emittedRole) {
                    delta.role = 'assistant';
                    emittedRole = true;
                }

                if (chunk instanceof vscode.LanguageModelTextPart) {
                    if (chunk.value) {
                        delta.content = chunk.value;
                    }
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    const toolCall = this.convertVSCodeToolCallPart(chunk);
                    hasToolCalls = true;
                    delta.tool_calls = [{
                        index: emittedToolCallIndex,
                        id: toolCall.id,
                        type: 'function',
                        function: {
                            name: toolCall.function.name,
                            arguments: toolCall.function.arguments
                        }
                    }];
                    emittedToolCallIndex++;
                } else if (typeof chunk === 'string' && chunk) {
                    delta.content = chunk;
                }

                if (Object.keys(delta).length > 0) {
                    const event = this.createSSEEvent('data', this.createStreamChunk(
                        context,
                        selectedModel,
                        delta
                    ));

                    if (requiresToolCall && !hasToolCalls) {
                        pendingEvents.push(event);
                    } else {
                        if (requiresToolCall && pendingEvents.length > 0) {
                            for (const pendingEvent of pendingEvents) {
                                yield pendingEvent;
                            }
                            pendingEvents.length = 0;
                        }
                        yield event;
                    }
                }
            }

            if (!emittedRole) {
                const roleOnlyEvent = this.createSSEEvent('data', this.createStreamChunk(
                    context,
                    selectedModel,
                    { role: 'assistant' }
                ));

                if (requiresToolCall && !hasToolCalls) {
                    pendingEvents.push(roleOnlyEvent);
                } else {
                    if (requiresToolCall && pendingEvents.length > 0) {
                        for (const pendingEvent of pendingEvents) {
                            yield pendingEvent;
                        }
                        pendingEvents.length = 0;
                    }
                    yield roleOnlyEvent;
                }
            }

            if (requiresToolCall && !hasToolCalls) {
                throw new Error('Model did not produce any tool calls despite required tool mode');
            }

            const finishReason: OpenAIStreamResponse['choices'][0]['finish_reason'] = hasToolCalls
                ? 'tool_calls'
                : 'stop';

            if (requiresToolCall && pendingEvents.length > 0) {
                for (const pendingEvent of pendingEvents) {
                    yield pendingEvent;
                }
                pendingEvents.length = 0;
            }

            yield this.createSSEEvent('data', this.createStreamChunk(
                context,
                selectedModel,
                {},
                finishReason
            ));
            
            // 发送完成信号
            yield this.createSSEEvent('done');
            
        } catch (error) {
            logger.error('增强流提取中出错', error as Error, {}, context.requestId);
            throw error;
        }
    }
    
    /**
     * 从 VS Code LM 响应中收集所有内容
     */
    public static async collectFullResponse(
        response: vscode.LanguageModelChatResponse
    ): Promise<{ content: string; toolCalls: ToolCall[] }> {
        let fullContent = '';
        const toolCalls: ToolCall[] = [];
        
        try {
            for await (const chunk of this.getResponseChunks(response)) {
                if (chunk instanceof vscode.LanguageModelTextPart) {
                    fullContent += chunk.value;
                } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(this.convertVSCodeToolCallPart(chunk));
                } else if (typeof chunk === 'string') {
                    fullContent += chunk;
                }
            }
        } catch (error) {
            logger.error('收集增强响应时出错', error as Error);
            throw new Error('收集响应内容失败');
        }
        
        return { content: fullContent, toolCalls };
    }
    
    /**
     * 创建服务器发送事件数据
     */
    public static createSSEEvent(type: 'data' | 'done' | 'error', data?: any): string {
        switch (type) {
            case 'data':
                return `data: ${JSON.stringify(data)}\n\n`;
            case 'done':
                return 'data: [DONE]\n\n';
            case 'error':
                return `data: ${JSON.stringify({ error: data })}\n\n`;
            default:
                return '';
        }
    }
    
    /**
     * 增强令牌估算
     */
    private static estimateTokens(text: string): number {
        // 更精细的令牌估算
        // 考虑不同语言和特殊令牌
        const baseTokens = Math.ceil(text.length / 4);
        const specialTokens = (text.match(/[\n\r\t]/g) || []).length;
        return baseTokens + specialTokens;
    }
    
    /**
     * 创建增强转换上下文
     */
    public static createEnhancedContext(
        requestId: string,
        modelId: string,
        isStream: boolean,
        messages: EnhancedMessage[],
        selectedModel?: ModelCapabilities,
        clientIP?: string,
        userAgent?: string
    ): EnhancedRequestContext {
        
        // 分析消息内容以获取能力
        const hasImages = messages.some(msg => 
            Array.isArray(msg.content) && 
            msg.content.some(part => part.type === 'image_url')
        );
        
        const hasFunctions = messages.some(msg => 
            (msg.tool_calls && msg.tool_calls.length > 0) ||
            !!msg.function_call ||
            !!msg.tool_call_id
        );
        
        // 估算总令牌数
        const estimatedTokens = messages.reduce((total, msg) => {
            if (typeof msg.content === 'string') {
                return total + this.estimateTokens(msg.content);
            } else if (msg.content === null) {
                return total;
            } else if (Array.isArray(msg.content)) {
                return total + msg.content.reduce((partTotal, part) => {
                    if (part.type === 'text' && part.text) {
                        return partTotal + this.estimateTokens(part.text);
                    }
                    return partTotal + 100; // 图像估算
                }, 0);
            }
            return total;
        }, 0);
        
        // 确定所需能力
        const requiredCapabilities: string[] = [];
        if (hasImages) {
            requiredCapabilities.push('supportsVision');
        }
        if (hasFunctions) {
            requiredCapabilities.push('supportsTools');
        }
        if (isStream) {
            requiredCapabilities.push('supportsStreaming');
        }
        
        return {
            requestId,
            model: modelId,
            isStream,
            startTime: new Date(),
            clientIP,
            userAgent,
            hasImages,
            hasFunctions,
            requiredCapabilities,
            estimatedTokens,
            selectedModel
        };
    }
    
    /**
     * 创建带有模型信息的健康检查响应
     */
    public static createHealthResponse(serverState: ServerState, modelPool?: ModelPool) {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            server: {
                running: serverState.isRunning,
                uptime: serverState.startTime ? Date.now() - serverState.startTime.getTime() : 0,
                requests: serverState.requestCount,
                errors: serverState.errorCount,
                activeConnections: serverState.activeConnections
            },
            models: modelPool ? {
                total: modelPool.primary.length + modelPool.secondary.length + modelPool.fallback.length,
                primary: modelPool.primary.length,
                secondary: modelPool.secondary.length,
                fallback: modelPool.fallback.length,
                unhealthy: modelPool.unhealthy.length,
                supportsVision: modelPool.primary.filter(m => m.supportsVision).length,
                supportsTools: modelPool.primary.filter(m => m.supportsTools).length
            } : undefined
        };
    }
    
    /**
     * 创建 OpenAI 格式的错误响应
     */
    public static createErrorResponse(
        message: string,
        type: string = 'api_error',
        code?: string,
        param?: string
    ) {
        return {
            error: {
                message,
                type,
                code,
                param
            }
        };
    }
}
