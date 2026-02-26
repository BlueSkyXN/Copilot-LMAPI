/**
 * @module Converter
 * @description 格式转换器模块
 *
 * 职责：
 * - 将 OpenAI 格式的消息转换为 VS Code Language Model API 格式
 * - 处理多模态内容（文本、图像 URL、base64 图像）的转换
 * - 转换 assistant 工具调用消息（tool_calls -> VS Code ToolCallPart）
 * - 转换工具结果消息（tool/function 角色 -> VS Code ToolResultPart）
 * - 从 VS Code LM 响应流中提取内容并生成 SSE（Server-Sent Events）事件
 * - 创建完成响应（流式和非流式两种模式）
 * - 创建模型列表响应和健康检查响应
 * - 提供令牌数量估算
 * - 创建请求上下文对象，汇总请求的元数据和能力需求
 *
 * 架构位置：
 *   位于 src/utils/ 工具层。被 RequestHandler 调用：
 *   - 请求阶段：Validator 验证通过后，Converter 将消息转换为 VS Code 格式
 *   - 响应阶段：将 VS Code LM API 的响应转换回 OpenAI 兼容格式
 *
 * 关键依赖：
 * - vscode —— VS Code Language Model API（LanguageModelChatMessage 等类型）
 * - EnhancedMessage, ModelCapabilities, ToolCall, ModelPool (types/ModelCapabilities)
 * - ServerState (types/VSCode)
 * - OpenAICompletionResponse, OpenAIStreamResponse 等 (types/OpenAI)
 * - Logger (utils/Logger)
 *
 * 设计要点：
 * - 使用 ToolConversionState 跟踪待匹配的工具调用 ID，支持旧版 function 消息的自动关联
 * - 流式模式下在必需工具调用场景（requiresToolCall）中缓冲事件，直到第一个工具调用出现
 * - 角色映射策略：system/user/tool/function 均映射为 VS Code User 角色
 * - 令牌估算采用字符数/4 + 特殊字符数的近似算法
 *
 * ═══════════════════════════════════════════════════════
 * 函数/类清单
 * ═══════════════════════════════════════════════════════
 *
 * 【ToolConversionState（接口）】
 *   - 功能说明：工具调用转换状态
 *
 * 【StreamExtractionOptions（接口）】
 *   - 功能说明：流式提取选项
 *
 * 【Converter（类，静态方法集合）】
 *
 *   1. convertMessagesToVSCode(messages: EnhancedMessage[], conversionState?: ToolConversionState): Promise<vscode.LanguageModelChatMessage[]>
 *      - 功能：消息格式转换（OpenAI -> VS Code）
 *      - 输入：messages — 增强消息数组, conversionState — 工具转换状态（可选）
 *      - 输出：Promise<vscode.LanguageModelChatMessage[]>
 *
 *   2. convertSingleMessage(message: EnhancedMessage, conversionState: ToolConversionState): Promise<vscode.LanguageModelChatMessage | null>
 *      - 功能：转换单条消息
 *
 *   3. convertAssistantToolCallMessage(message: EnhancedMessage, conversionState: ToolConversionState): vscode.LanguageModelChatMessage
 *      - 功能：转换 assistant 工具调用消息
 *
 *   4. convertToolResultMessage(message: EnhancedMessage, conversionState: ToolConversionState): vscode.LanguageModelChatMessage
 *      - 功能：转换工具结果消息
 *
 *   5. convertMultimodalMessage(message: EnhancedMessage): Promise<vscode.LanguageModelChatMessage>
 *      - 功能：转换多模态消息
 *
 *   6. processImageContent(imageUrl: string): Promise<{description: string, data?: any} | null>
 *      - 功能：处理图片内容
 *
 *   7. extractTextContent(message: EnhancedMessage): string
 *      - 功能：提取文本内容
 *
 *   8. extractToolResultText(content: any): string
 *      - 功能：提取工具结果文本
 *
 *   9. parseToolArguments(rawArguments: string): object
 *      - 功能：解析工具参数 JSON
 *
 *  10. generateLegacyToolCallId(name: string): string
 *      - 功能：生成旧版工具调用 ID
 *
 *  11. trackPendingToolCall(name: string, callId: string, state: ToolConversionState): void
 *      - 功能：跟踪待匹配的工具调用
 *
 *  12. consumePendingToolCallId(name: string, state: ToolConversionState): string | undefined
 *      - 功能：消费待匹配的工具调用 ID
 *
 *  13. convertVSCodeToolCallPart(part: any): ToolCall
 *      - 功能：转换 VS Code 工具调用部分
 *
 *  14. convertToolCallToOpenAI(toolCall: ToolCall): OpenAIToolCall
 *      - 功能：转换为 OpenAI 格式
 *
 *  15. stringifyToolInput(input: any): string
 *      - 功能：序列化工具输入
 *
 *  16. estimateToolCallTokens(toolCalls: ToolCall[]): number
 *      - 功能：估算工具调用令牌数
 *
 *  17. mapRoleToVSCode(role: string): LanguageModelChatMessageRole
 *      - 功能：角色映射
 *
 *  18. formatRolePrefix(role: string): string
 *      - 功能：格式化角色前缀
 *
 *  19. createCompletionResponse(content: string, model: string, requestId: string, usage: any, toolCalls?: ToolCall[], finishReason?: string): OpenAICompletionResponse
 *      - 功能：创建非流式响应
 *
 *  20. createStreamChunk(content: string, model: string, requestId: string, isFirst?: boolean, finishReason?: string, toolCallDelta?: any): OpenAIStreamResponse
 *      - 功能：创建流式响应块
 *
 *  21. createModelsResponse(availableModels: any[]): OpenAIModelsResponse
 *      - 功能：创建模型列表响应
 *
 *  22. getResponseChunks(text: string, model: string, requestId: string): string[]
 *      - 功能：获取响应分块
 *
 *  23. extractStreamContent(response: any, model: string, requestId: string, options?: StreamExtractionOptions): AsyncGenerator<string>
 *      - 功能：提取流式内容
 *      - 输出：AsyncGenerator<string>
 *
 *  24. collectFullResponse(response: any): Promise<string>
 *      - 功能：收集完整响应
 *
 *  25. createSSEEvent(type: string, data?: any): string
 *      - 功能：创建 SSE 事件
 *
 *  26. estimateTokens(text: string): number
 *      - 功能：估算令牌数
 *
 *  27. createEnhancedContext(requestId: string, model: string, isStream: boolean, startTime: number, clientIP?: string, userAgent?: string, request?: any): EnhancedRequestContext
 *      - 功能：创建增强上下文
 *
 *  28. createHealthResponse(serverState: ServerState, modelPool?: ModelPool): object
 *      - 功能：创建健康检查响应
 *
 *  29. createErrorResponse(message: string, type: string, param?: string, code?: string): OpenAIError
 *      - 功能：创建错误响应
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

/**
 * 工具调用转换状态接口
 *
 * 在消息转换过程中跟踪待匹配的工具调用 ID。
 * 当 assistant 消息包含 tool_calls 时，将每个调用的 ID 按函数名存入队列；
 * 后续遇到旧版 function 角色的结果消息时，按 FIFO 顺序消费对应的 ID，
 * 从而实现旧版格式与新版格式的自动关联。
 */
interface ToolConversionState {
    /** 按函数名分组的待匹配工具调用 ID 队列 */
    pendingToolCallIdsByName: Map<string, string[]>;
}

/**
 * 流式内容提取选项接口
 *
 * 控制从 VS Code LM 响应流中提取内容时的行为。
 * 当 requiresToolCall 为 true 时，提取器会缓冲所有事件，
 * 直到检测到第一个工具调用后才开始输出，确保必需工具调用模式下的正确性。
 */
interface StreamExtractionOptions {
    /** 是否要求响应必须包含工具调用；为 true 时启用缓冲机制 */
    requiresToolCall?: boolean;
}

/**
 * 格式转换器类
 *
 * 负责 OpenAI API 格式与 VS Code Language Model API 格式之间的双向转换。
 * 所有方法均为静态方法，无需实例化即可调用。
 *
 * 主要功能分为三大类：
 * 1. 请求转换 - 将 OpenAI 格式的消息数组转换为 VS Code LanguageModelChatMessage 数组
 * 2. 响应转换 - 将 VS Code LM API 的响应转换为 OpenAI 兼容的 JSON 或 SSE 流
 * 3. 辅助功能 - 令牌估算、角色映射、上下文创建、健康检查响应等
 */
export class Converter {
    
    /**
     * 将增强消息数组转换为 VS Code Language Model API 格式
     *
     * 遍历所有消息，根据角色和内容类型分别调用不同的转换方法。
     * 转换失败时会回退到纯文本消息，确保不会因单条消息的问题而中断整个转换流程。
     *
     * @param messages - OpenAI 格式的增强消息数组，支持文本、多模态、工具调用等类型
     * @param selectedModel - 目标模型的能力描述，用于判断是否支持视觉等特性
     * @returns 转换后的 VS Code LanguageModelChatMessage 数组
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
     * 转换单条增强消息为 VS Code 格式
     *
     * 根据消息的角色和内容类型进行分发：
     * - tool/function 角色 -> convertToolResultMessage（工具结果）
     * - assistant 角色且包含 tool_calls/function_call -> convertAssistantToolCallMessage（工具调用）
     * - 纯文本内容 -> 直接构造 LanguageModelChatMessage
     * - 数组内容 -> convertMultimodalMessage（多模态）
     *
     * @param message - 待转换的单条增强消息
     * @param selectedModel - 目标模型的能力描述
     * @param conversionState - 工具调用转换状态，用于跟踪待匹配的工具调用 ID
     * @returns 转换后的 VS Code 消息对象，若消息无法转换则返回 null
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
     * 转换 assistant 角色的工具调用消息为 VS Code 格式
     *
     * 处理两种工具调用格式：
     * - 新版格式：message.tool_calls 数组，每项包含 id、function.name、function.arguments
     * - 旧版格式：message.function_call 对象，仅包含 name 和 arguments，
     *   此时会自动生成唯一 ID 并归一化为 tool_calls 数组格式
     *
     * 每个工具调用的 ID 会通过 trackPendingToolCall 记录到转换状态中，
     * 以便后续的 function 角色结果消息能匹配到对应的调用 ID。
     *
     * @param message - 包含工具调用信息的 assistant 消息
     * @param conversionState - 工具调用转换状态，用于记录待匹配的调用 ID
     * @returns 包含 TextPart 和 ToolCallPart 的 VS Code Assistant 消息
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

        // 统一新版 tool_calls 和旧版 function_call 为数组格式
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
     * 转换工具结果消息（tool/function 角色）为 VS Code 格式
     *
     * 优先使用 message.tool_call_id 作为调用 ID；
     * 对于旧版 function 角色消息（无 tool_call_id），通过 consumePendingToolCallId
     * 从转换状态中按 FIFO 顺序获取之前 assistant 消息记录的调用 ID。
     *
     * 若最终无法获取 callId，则降级为普通用户消息（User 角色纯文本），
     * 并输出警告日志，避免因缺少 ID 导致 VS Code API 调用失败。
     *
     * @param message - tool 或 function 角色的结果消息
     * @param conversionState - 工具调用转换状态，用于消费待匹配的调用 ID
     * @returns 包含 ToolResultPart 的 VS Code User 消息；若缺少 callId 则返回纯文本消息
     */
    private static convertToolResultMessage(
        message: EnhancedMessage,
        conversionState: ToolConversionState
    ): vscode.LanguageModelChatMessage {
        // 优先使用新版 tool_call_id；旧版 function 角色则从转换状态中按 FIFO 消费
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
     * 转换包含多模态内容（文本 + 图像）的消息为 VS Code 格式
     *
     * 遍历消息的 content 数组，将文本部分拼接，图像部分根据模型能力处理：
     * - 模型支持视觉时：调用 processImageContent 处理图像并插入描述文本
     * - 模型不支持视觉时：插入提示文本说明不支持图像
     *
     * @param message - 包含多模态内容数组的增强消息
     * @param selectedModel - 目标模型的能力描述，用于判断视觉支持
     * @returns 转换后的 VS Code 消息对象；若 content 非数组则返回 null
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
     * 处理图像内容，支持 Base64 编码、HTTP/HTTPS URL 两种来源
     *
     * - Base64 格式（data:image/...）：解析 MIME 类型并提取编码数据
     * - HTTP/HTTPS URL：出于安全考虑仅记录来源域名，不下载图像内容
     * - 其他格式：返回 null 表示无法处理
     *
     * @param imageUrl - 图像的 URL 字符串（支持 data: URI 和 http(s): URL）
     * @returns 包含描述文本和可选 Base64 数据的对象；无法处理时返回 null
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
     * 提取消息中的纯文本内容
     *
     * 支持 string 类型和 content 数组类型的消息：
     * - string 类型：直接添加角色前缀后返回
     * - 数组类型：过滤出 type='text' 的部分并拼接，添加角色前缀
     *
     * @param message - 待提取文本的增强消息
     * @returns 带角色前缀的文本内容；无文本时返回空字符串
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
     * 提取工具结果消息中的文本内容
     *
     * 处理 content 的两种可能类型：
     * - string 类型：直接返回
     * - 数组类型：过滤出 type='text' 的部分并拼接
     *
     * @param content - 工具结果消息的 content 字段（可能为字符串或内容数组）
     * @returns 提取出的纯文本内容；无文本时返回空字符串
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
     * 将工具参数的 JSON 字符串解析为对象
     *
     * 解析策略：
     * - 正常解析成功且结果为对象：直接返回
     * - 解析成功但结果为原始值（如数字、字符串）：包装为 { value: parsed }
     * - 解析失败（非法 JSON）：回退为 { __raw: rawArguments }，保留原始字符串
     *
     * @param rawArguments - 工具调用的参数 JSON 字符串
     * @returns 解析后的参数对象
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

    /**
     * 为旧版 function_call 格式生成唯一的工具调用 ID
     *
     * 旧版 OpenAI function_call 不包含 id 字段，需要自动生成。
     * 格式为 call_{函数名}_{时间戳的36进制表示}，确保唯一性。
     *
     * @param name - 函数名称
     * @returns 生成的唯一工具调用 ID 字符串
     */
    private static generateLegacyToolCallId(name: string): string {
        return `call_${name}_${Date.now().toString(36)}`;
    }

    /**
     * 将工具调用 ID 记录到转换状态中，按函数名分组存储
     *
     * 当处理 assistant 的 tool_calls 时调用此方法，将每个调用的 ID
     * 追加到对应函数名的队列末尾，供后续 function 角色结果消息匹配使用。
     *
     * @param name - 函数名称
     * @param callId - 工具调用的唯一 ID
     * @param conversionState - 当前的工具调用转换状态
     */
    private static trackPendingToolCall(name: string, callId: string, conversionState: ToolConversionState): void {
        const pending = conversionState.pendingToolCallIdsByName.get(name) || [];
        pending.push(callId);
        conversionState.pendingToolCallIdsByName.set(name, pending);
    }

    /**
     * 按 FIFO 顺序消费指定函数名的待匹配工具调用 ID
     *
     * 从转换状态中取出该函数名队列的第一个 ID 并返回。
     * 若队列为空则返回 undefined。队列清空后自动从 Map 中移除该键。
     *
     * @param name - 函数名称
     * @param conversionState - 当前的工具调用转换状态
     * @returns 匹配到的工具调用 ID；队列为空时返回 undefined
     */
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
     * 将 VS Code LanguageModelToolCallPart 转换为内部 ToolCall 格式
     *
     * 从 VS Code 的工具调用部分提取 callId、name 和 input，
     * 转换为统一的 ToolCall 对象（id、type、function.name、function.arguments）。
     *
     * @param part - VS Code 的 LanguageModelToolCallPart 对象
     * @returns 内部统一的 ToolCall 对象
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

    /**
     * 将内部 ToolCall 对象转换为 OpenAI API 格式的 ToolCall
     *
     * @param toolCall - 内部统一的 ToolCall 对象
     * @returns OpenAI API 格式的 OpenAIToolCall 对象
     */
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

    /**
     * 将工具调用的 input 对象序列化为 JSON 字符串
     *
     * 序列化失败时返回空对象字符串 '{}'，避免异常传播。
     *
     * @param input - 工具调用的输入参数对象
     * @returns JSON 字符串；序列化失败时返回 '{}'
     */
    private static stringifyToolInput(input: object): string {
        try {
            return JSON.stringify(input);
        } catch {
            return '{}';
        }
    }

    /**
     * 估算工具调用数组的总令牌数
     *
     * 将每个工具调用的函数名和参数字符串拼接后进行令牌估算，累加得到总数。
     *
     * @param toolCalls - 工具调用数组
     * @returns 估算的总令牌数
     */
    private static estimateToolCallTokens(toolCalls: ToolCall[]): number {
        return toolCalls.reduce((total, call) => {
            return total + this.estimateTokens(call.function.name + call.function.arguments);
        }, 0);
    }
    
    /**
     * 将 OpenAI 消息角色映射到 VS Code Language Model 角色
     *
     * 映射规则：
     * - system -> User（VS Code LM API 无 system 角色，需映射为 User 并添加前缀）
     * - user -> User
     * - tool -> User（工具结果作为 User 消息传递）
     * - function -> User（旧版函数结果同样映射为 User）
     * - assistant -> Assistant
     * - 其他未知角色 -> User（默认安全回退）
     *
     * @param role - OpenAI 格式的角色字符串
     * @returns 对应的 VS Code LanguageModelChatMessageRole 枚举值
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
     * 根据消息角色生成内容前缀字符串
     *
     * 由于 VS Code LM API 的角色粒度较粗（仅 User/Assistant），
     * 对于 system 和 tool 角色需要添加文本前缀以保留语义信息：
     * - system -> 'System: '
     * - tool -> 'Tool: '
     * - assistant/user/其他 -> ''（无前缀）
     *
     * @param role - OpenAI 格式的角色字符串
     * @returns 角色对应的前缀字符串
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
     * 创建 OpenAI 格式的完成响应对象（非流式模式）
     *
     * 根据是否包含工具调用来决定 finish_reason：
     * - 有工具调用且使用旧版格式（单个调用 + preferLegacyFunctionCall）-> 'function_call'
     * - 有工具调用使用新版格式 -> 'tool_calls'
     * - 无工具调用 -> 'stop'
     *
     * 当存在工具调用且无文本内容时，message.content 设为 null（符合 OpenAI 规范）。
     *
     * @param content - 模型生成的文本内容
     * @param context - 请求上下文，包含 requestId、模型名称、估算令牌数等
     * @param selectedModel - 所选模型的能力描述，用于生成 system_fingerprint
     * @param toolCalls - 工具调用数组（默认为空数组）
     * @param preferLegacyFunctionCall - 是否优先使用旧版 function_call 格式（默认 false）
     * @returns OpenAI 格式的完整完成响应对象
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
        // 根据工具调用情况决定 finish_reason：旧版单调用 -> function_call，新版 -> tool_calls，无调用 -> stop
        const finishReason = isToolResponse
            ? (useLegacyFunctionCall ? 'function_call' : 'tool_calls')
            : 'stop';
        // 有工具调用且无文本时 content 设为 null（符合 OpenAI 规范）
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
     * 创建 OpenAI 格式的流式响应块（SSE chunk）
     *
     * 每个 chunk 包含一个 delta 对象（增量内容），遵循 OpenAI 的流式协议。
     * 最后一个 chunk 的 finishReason 不为 null，表示生成结束。
     *
     * @param context - 请求上下文，提供 requestId 和模型名称
     * @param selectedModel - 所选模型的能力描述，用于生成 system_fingerprint
     * @param delta - 增量内容对象，可包含 role、content、tool_calls 等字段
     * @param finishReason - 完成原因（默认 null 表示生成未结束）
     * @returns OpenAI 格式的流式响应块对象
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
     * 创建 OpenAI 格式的模型列表响应
     *
     * 将动态发现的模型能力数组转换为 OpenAI /v1/models 接口的标准响应格式，
     * 包含每个模型的权限信息和元数据。
     *
     * @param availableModels - 动态发现的可用模型能力描述数组
     * @returns OpenAI 格式的模型列表响应对象
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

    /**
     * 获取 VS Code LM 响应的可迭代内容流
     *
     * 对响应对象进行规范化处理，按优先级依次尝试以下数据源：
     * 1. response.stream（新版异步可迭代对象，包含 TextPart/ToolCallPart）
     * 2. response.text（旧版异步可迭代字符串流）
     * 3. response.text（旧版纯字符串，包装为单元素异步生成器）
     *
     * 若以上均不可用，则抛出错误。
     *
     * @param response - VS Code Language Model 的聊天响应对象
     * @returns 统一的异步可迭代对象，元素类型为 TextPart、ToolCallPart、string 或 unknown
     */
    private static getResponseChunks(
        response: vscode.LanguageModelChatResponse
    ): AsyncIterable<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | string | unknown> {
        // 类型断言以兼容不同版本的 VS Code LM API
        const responseWithFallback = response as vscode.LanguageModelChatResponse & {
            stream?: AsyncIterable<unknown>;
            text?: AsyncIterable<string> | string;
        };

        // 优先级 1：新版 stream 属性（包含 TextPart/ToolCallPart 的异步可迭代对象）
        if (responseWithFallback.stream && typeof responseWithFallback.stream[Symbol.asyncIterator] === 'function') {
            return responseWithFallback.stream;
        }

        // 优先级 2：旧版 text 属性为异步可迭代字符串流
        const legacyText = responseWithFallback.text;
        if (legacyText && typeof (legacyText as AsyncIterable<string>)[Symbol.asyncIterator] === 'function') {
            return legacyText as AsyncIterable<string>;
        }
        // 优先级 3：旧版 text 属性为纯字符串，包装为单元素异步生成器
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
     * 从 VS Code LM 响应流中提取内容并生成 SSE 事件的异步生成器
     *
     * 处理流程：
     * 1. 遍历响应流的每个 chunk，识别 TextPart、ToolCallPart 或纯字符串
     * 2. 为每个 chunk 构造 OpenAI 流式 delta 对象
     * 3. 将 delta 封装为 SSE 事件并 yield 输出
     *
     * 缓冲机制（requiresToolCall 模式）：
     * - 当 options.requiresToolCall 为 true 时，所有事件先存入 pendingEvents 缓冲区
     * - 直到检测到第一个 ToolCallPart 后，才将缓冲区中的事件全部释放
     * - 若流结束仍未出现工具调用，则抛出错误
     *
     * 结束序列：
     * - 输出带 finish_reason 的终止 chunk（'tool_calls' 或 'stop'）
     * - 输出 [DONE] 事件标记流结束
     *
     * @param response - VS Code Language Model 的聊天响应对象
     * @param context - 请求上下文，提供 requestId 和模型名称
     * @param selectedModel - 所选模型的能力描述
     * @param options - 流提取选项，控制是否要求必须包含工具调用
     * @returns 异步生成器，逐个 yield SSE 格式的事件字符串
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

                    // 必需工具调用模式下的缓冲逻辑：
                    // 在检测到第一个工具调用之前，将所有事件暂存到 pendingEvents
                    if (requiresToolCall && !hasToolCalls) {
                        pendingEvents.push(event);
                    } else {
                        // 检测到工具调用后，先释放所有缓冲事件，再输出当前事件
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

            // 若流中无任何 chunk，仍需发送一个仅含 role 的事件
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

            // 必需工具调用模式下，若流结束仍无工具调用则报错
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
     * 从 VS Code LM 响应中收集所有内容（非流式模式使用）
     *
     * 遍历整个响应流，将所有文本部分拼接为完整字符串，
     * 同时收集所有工具调用部分并转换为内部 ToolCall 格式。
     *
     * @param response - VS Code Language Model 的聊天响应对象
     * @returns 包含完整文本内容和工具调用数组的对象
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
     * 创建 Server-Sent Events (SSE) 格式的事件字符串
     *
     * 支持三种事件类型：
     * - data: 正常数据事件，将 data 序列化为 JSON
     * - done: 流结束标记，输出固定的 [DONE] 信号
     * - error: 错误事件，将错误信息包装在 error 对象中
     *
     * @param type - 事件类型：'data'（数据）、'done'（完成）或 'error'（错误）
     * @param data - 事件数据（data 和 error 类型时必需）
     * @returns SSE 格式的事件字符串，以双换行符结尾
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
     * 估算文本的令牌数量
     *
     * 采用近似算法：基础令牌数 = 字符数 / 4（英文平均值），
     * 加上换行符、回车符、制表符等特殊字符的额外计数。
     * 此为粗略估算，用于 usage 统计，非精确分词结果。
     *
     * @param text - 待估算的文本字符串
     * @returns 估算的令牌数量
     */
    private static estimateTokens(text: string): number {
        // 基础令牌数：字符总数除以4（英文平均每个令牌约4个字符）
        const baseTokens = Math.ceil(text.length / 4);
        // 额外计数：换行符、回车符、制表符等特殊字符通常单独占用令牌
        const specialTokens = (text.match(/[\n\r\t]/g) || []).length;
        return baseTokens + specialTokens;
    }
    
    /**
     * 创建增强请求上下文对象
     *
     * 分析消息数组的内容特征（是否包含图像、工具调用等），
     * 估算总令牌数，确定所需的模型能力，最终汇总为上下文对象。
     * 该上下文贯穿整个请求处理流程，供日志记录、响应构造等环节使用。
     *
     * @param requestId - 请求的唯一标识符
     * @param modelId - 请求指定的模型 ID
     * @param isStream - 是否为流式请求
     * @param messages - OpenAI 格式的增强消息数组
     * @param selectedModel - 已选择的模型能力描述（可选）
     * @param clientIP - 客户端 IP 地址（可选）
     * @param userAgent - 客户端 User-Agent 字符串（可选）
     * @returns 包含请求元数据和能力需求的增强请求上下文对象
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
        
        // 扫描消息数组，检测是否包含图像内容
        const hasImages = messages.some(msg => 
            Array.isArray(msg.content) && 
            msg.content.some(part => part.type === 'image_url')
        );
        
        // 扫描消息数组，检测是否涉及工具/函数调用
        const hasFunctions = messages.some(msg => 
            (msg.tool_calls && msg.tool_calls.length > 0) ||
            !!msg.function_call ||
            !!msg.tool_call_id
        );
        
        // 累加所有消息的令牌估算：文本按字符估算，图像按固定值（100）估算
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
                    return partTotal + 100; // 图像内容按固定 100 令牌估算
                }, 0);
            }
            return total;
        }, 0);
        
        // 根据消息特征确定所需的模型能力列表
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
     * 创建带有服务器状态和模型信息的健康检查响应
     *
     * 返回服务器运行状态（运行时间、请求计数、错误计数、活跃连接数）
     * 以及可选的模型池统计信息（各层级模型数量、视觉/工具支持数量）。
     *
     * @param serverState - 服务器运行状态对象
     * @param modelPool - 模型池对象（可选），包含各优先级的模型列表
     * @returns 健康检查响应对象
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
     * 创建 OpenAI 格式的错误响应对象
     *
     * 遵循 OpenAI API 的错误响应规范，包含 message、type、code 和 param 字段。
     *
     * @param message - 错误描述信息
     * @param type - 错误类型（默认 'api_error'）
     * @param code - 错误代码（可选）
     * @param param - 导致错误的参数名称（可选）
     * @returns OpenAI 格式的错误响应对象
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
