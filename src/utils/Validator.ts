/**
 * @module Validator
 * @description 请求验证器模块
 *
 * 职责：
 * - 验证聊天完成请求的完整性和合法性（模型、消息、参数范围）
 * - 验证多模态内容格式（文本部分、图像 URL 格式与安全性）
 * - 验证工具/函数定义的结构完整性
 * - 验证 assistant 消息中的 tool_calls 结构
 * - 校验工具调用与结果消息之间的关联关系（防止歧义和错误绑定）
 * - 验证 tool_choice / function_call 策略选择的合法性
 * - 提供端口号和主机地址的安全验证
 * - 提供字符串清理（去除控制字符）
 *
 * 架构位置：
 *   位于 src/utils/ 工具层。被 RequestHandler 在处理请求时调用，
 *   对请求体进行全面验证后才转交给 Converter 进行格式转换。
 *
 * 关键依赖：
 * - EnhancedMessage, ModelCapabilities, FunctionDefinition, ToolCall (types/ModelCapabilities)
 * - OpenAIFunctionCallChoice, OpenAITool, OpenAIToolChoice, ValidatedRequest (types/OpenAI)
 * - LIMITS, ERROR_CODES (constants/Config)
 * - Logger (utils/Logger)
 *
 * 设计要点：
 * - 无硬编码模型列表，支持任意模型的动态验证
 * - tool_call_id 关联检查使用 pending 队列机制，支持多轮工具调用场景
 * - 旧版 function 消息无 tool_call_id 时，仅在无歧义（同名调用唯一）时允许关联
 * - 图像 URL 仅允许 base64 data URI 和 HTTP(S) URL，阻止 file:// 以防 SSRF
 *
 * ═══════════════════════════════════════════════════════
 * 函数/类清单
 * ═══════════════════════════════════════════════════════
 *
 * 【ValidationError（类，extends Error）】
 *   - 功能说明：验证错误，携带 code 和 param 信息
 *
 * 【Validator（类，静态方法集合）】
 *
 *   1. validateChatCompletionRequest(request: any, availableModels?: string[]): ValidatedRequest
 *      - 功能：验证聊天补全请求
 *      - 输入：request — 原始请求体, availableModels — 可用模型列表（可选）
 *      - 输出：ValidatedRequest
 *
 *   2. validateEnhancedMessages(messages: any[]): EnhancedMessage[]
 *      - 功能：验证消息数组
 *      - 输出：EnhancedMessage[]
 *
 *   3. validateEnhancedMessage(message: any, index: number): EnhancedMessage
 *      - 功能：验证单条消息
 *
 *   4. validateToolCallAssociations(messages: EnhancedMessage[]): void
 *      - 功能：校验工具调用关联
 *
 *   5. validateMultimodalContent(content: any[], messageIndex: number): void
 *      - 功能：验证多模态内容
 *
 *   6. validateImageUrl(url: string, messageIndex: number, partIndex: number): void
 *      - 功能：验证图片 URL
 *
 *   7. validateDynamicModel(model: string, availableModels?: string[]): string
 *      - 功能：验证模型标识
 *      - 输出：验证通过的模型名称字符串
 *
 *   8. validateFunctions(functions: any[]): FunctionDefinition[]
 *      - 功能：验证函数定义数组
 *      - 输出：FunctionDefinition[]
 *
 *   9. validateFunction(func: any, path: string): FunctionDefinition
 *      - 功能：验证单个函数定义
 *
 *  10. validateTools(tools: any[]): OpenAITool[]
 *      - 功能：验证工具定义数组
 *      - 输出：OpenAITool[]
 *
 *  11. validateToolCalls(toolCalls: any[], messageIndex: number): ToolCall[]
 *      - 功能：验证工具调用数组
 *      - 输出：ToolCall[]
 *
 *  12. validateMessageFunctionCall(functionCall: any, messageIndex: number): {name: string, arguments: string}
 *      - 功能：验证消息中的函数调用
 *
 *  13. validateFunctionCallChoice(functionCall: any): OpenAIFunctionCallChoice | undefined
 *      - 功能：验证 function_call 选择
 *
 *  14. validateToolChoice(toolChoice: any): OpenAIToolChoice | undefined
 *      - 功能：验证 tool_choice 选择
 *
 *  15. validateMaxTokens(maxTokens: any, selectedModel?: string): number | undefined
 *      - 功能：验证 max_tokens
 *
 *  16. validateStream(stream: any): boolean
 *      - 功能：验证 stream 参数
 *      - 输出：boolean
 *
 *  17. validateTemperature(temperature: any): number
 *      - 功能：验证 temperature
 *      - 输出：number
 *
 *  18. validateN(n: any): number | undefined
 *      - 功能：验证 n 参数
 *
 *  19. validateTopP(topP: any): number | undefined
 *      - 功能：验证 top_p
 *
 *  20. validateStop(stop: any): string | string[] | undefined
 *      - 功能：验证 stop 参数
 *
 *  21. validatePenalty(penalty: any, paramName: string): number | undefined
 *      - 功能：验证惩罚系数
 *
 *  22. validateUser(user: any): string
 *      - 功能：验证 user 字段
 *      - 输出：string
 *
 *  23. sanitizeString(input: string): string
 *      - 功能：清理字符串（去控制字符）
 *      - 输出：string
 *
 *  24. validatePort(port: any): number
 *      - 功能：验证端口号
 *      - 输出：number
 *
 *  25. validateHost(host: any): string
 *      - 功能：验证主机地址
 *      - 输出：string
 */

import { 
    EnhancedMessage, 
    ModelCapabilities, 
    FunctionDefinition,
    ToolCall
} from '../types/ModelCapabilities';
import {
    OpenAIFunctionCallChoice,
    OpenAITool,
    OpenAIToolChoice,
    ValidatedRequest
} from '../types/OpenAI';
import { LIMITS, ERROR_CODES } from '../constants/Config';
import { logger } from './Logger';

/**
 * 验证错误类
 *
 * 在请求验证失败时抛出，携带错误码和参数路径信息，
 * 便于上层（RequestHandler）生成符合 OpenAI 规范的错误响应。
 *
 * @extends Error
 */
export class ValidationError extends Error {
    constructor(
        message: string,
        public code: string = ERROR_CODES.INVALID_REQUEST,
        public param?: string
    ) {
        super(message);
        this.name = 'ValidationError';
    }
}

/**
 * 核心请求验证器
 *
 * 提供所有请求参数的验证逻辑，包括聊天完成请求的完整验证、
 * 多模态内容格式校验、工具/函数定义验证、以及端口和主机安全校验。
 * 所有验证方法均为静态方法，无需实例化即可调用。
 */
export class Validator {
    
    /**
     * 验证聊天完成请求（支持动态模型，无硬编码限制）
     *
     * 对请求体中的所有字段进行逐一验证，包括模型、消息列表、
     * 采样参数、工具/函数定义及其调用策略，最终返回经过验证的请求对象。
     *
     * @param request - 原始请求体（任意类型，需经验证）
     * @param availableModels - 当前可用的模型能力列表（可选，用于模型存在性检查和 max_tokens 上限校验）
     * @returns 经过验证和规范化的请求对象
     * @throws {ValidationError} 当请求体不合法时抛出
     */
    public static validateChatCompletionRequest(
        request: any, 
        availableModels?: ModelCapabilities[]
    ): ValidatedRequest {
        if (!request || typeof request !== 'object') {
            throw new ValidationError('Request must be a valid JSON object');
        }
        
        // 验证增强消息
        const messages = this.validateEnhancedMessages(request.messages);
        
        // 动态模型验证（无硬编码列表）
        const model = this.validateDynamicModel(request.model, availableModels);
        const stream = this.validateStream(request.stream);
        const temperature = this.validateTemperature(request.temperature);
        const maxTokens = this.validateMaxTokens(request.max_tokens, availableModels?.find(m => m.id === model));
        const n = this.validateN(request.n);
        const topP = this.validateTopP(request.top_p);
        const stop = this.validateStop(request.stop);
        const presencePenalty = this.validatePenalty(request.presence_penalty, 'presence_penalty');
        const frequencyPenalty = this.validatePenalty(request.frequency_penalty, 'frequency_penalty');
        
        const validatedFunctions = request.functions ? this.validateFunctions(request.functions) : undefined;
        const validatedTools = request.tools ? this.validateTools(request.tools) : undefined;
        const availableToolNames = [
            ...(validatedFunctions || []).map(func => func.name),
            ...(validatedTools || []).map(tool => tool.function.name)
        ];
        if (request.function_call !== undefined && request.tool_choice !== undefined) {
            throw new ValidationError(
                'function_call and tool_choice cannot be used together',
                ERROR_CODES.INVALID_REQUEST,
                'tool_choice'
            );
        }
        const validatedFunctionCall = request.function_call !== undefined
            ? this.validateFunctionCallChoice(request.function_call, availableToolNames)
            : undefined;
        const validatedToolChoice = request.tool_choice !== undefined
            ? this.validateToolChoice(request.tool_choice, availableToolNames)
            : undefined;
        
        // 构建已验证的请求
        const validatedRequest: ValidatedRequest = {
            model,
            messages,
            stream,
            temperature,
        };
        
        // 添加可选参数
        if (maxTokens !== undefined) {
            validatedRequest.max_tokens = maxTokens;
        }
        if (n !== undefined) {
            validatedRequest.n = n;
        }
        if (topP !== undefined) {
            validatedRequest.top_p = topP;
        }
        if (stop !== undefined) {
            validatedRequest.stop = stop;
        }
        if (presencePenalty !== undefined) {
            validatedRequest.presence_penalty = presencePenalty;
        }
        if (frequencyPenalty !== undefined) {
            validatedRequest.frequency_penalty = frequencyPenalty;
        }
        if (request.user) {
            validatedRequest.user = this.validateUser(request.user);
        }
        if (validatedFunctions) {
            validatedRequest.functions = validatedFunctions;
        }
        if (validatedTools) {
            validatedRequest.tools = validatedTools;
        }
        if (validatedFunctionCall !== undefined) {
            validatedRequest.function_call = validatedFunctionCall;
        }
        if (validatedToolChoice !== undefined) {
            validatedRequest.tool_choice = validatedToolChoice;
        }
        
        return validatedRequest;
    }
    
    /**
     * 验证支持多模态的增强消息列表
     *
     * 检查消息数组的类型、长度限制，逐条验证消息格式，
     * 并在最后校验工具调用与结果消息之间的关联关系。
     *
     * @param messages - 原始消息数组
     * @returns 经过验证的增强消息数组
     * @throws {ValidationError} 当消息格式不合法时抛出
     */
    private static validateEnhancedMessages(messages: any): EnhancedMessage[] {
        if (!Array.isArray(messages)) {
            throw new ValidationError('Messages must be an array', ERROR_CODES.INVALID_REQUEST, 'messages');
        }
        
        if (messages.length === 0) {
            throw new ValidationError('At least one message is required', ERROR_CODES.INVALID_REQUEST, 'messages');
        }
        
        if (messages.length > LIMITS.MAX_MESSAGES_PER_REQUEST) {
            throw new ValidationError(
                `Too many messages. Maximum ${LIMITS.MAX_MESSAGES_PER_REQUEST} allowed`,
                ERROR_CODES.INVALID_REQUEST,
                'messages'
            );
        }
        
        const validatedMessages = messages.map((message, index) => this.validateEnhancedMessage(message, index));
        this.validateToolCallAssociations(validatedMessages);
        return validatedMessages;
    }
    
    /**
     * 验证带多模态内容的单个增强消息
     *
     * 验证消息的角色、内容（字符串/null/多模态数组）、可选字段（name）、
     * tool_calls、function_call 以及 tool_call_id 的合法性和互斥约束。
     *
     * @param message - 原始消息对象
     * @param index - 消息在数组中的索引（用于错误提示定位）
     * @returns 经过验证的增强消息对象
     * @throws {ValidationError} 当消息字段不合法时抛出
     */
    private static validateEnhancedMessage(message: any, index: number): EnhancedMessage {
        if (!message || typeof message !== 'object') {
            throw new ValidationError(
                `Message at index ${index} must be an object`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}`
            );
        }
        
        // 验证角色
        if (!['system', 'user', 'assistant', 'tool', 'function'].includes(message.role)) {
            throw new ValidationError(
                `Invalid role "${message.role}" at message ${index}. Must be 'system', 'user', 'assistant', 'tool', or 'function'`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}.role`
            );
        }
        
        const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
        const hasFunctionCall = !!message.function_call;

        // 验证内容（可以是字符串、null 或多模态数组）
        if (typeof message.content === 'string') {
            if (message.content.length > LIMITS.MAX_MESSAGE_LENGTH) {
                throw new ValidationError(
                    `Message content at index ${index} is too long. Maximum ${LIMITS.MAX_MESSAGE_LENGTH} characters allowed`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.content`
                );
            }

            if (message.role !== 'tool' && message.role !== 'function' && !hasToolCalls && !hasFunctionCall && message.content.length === 0) {
                throw new ValidationError(
                    `Message content at index ${index} cannot be empty`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.content`
                );
            }
        } else if (message.role === 'function') {
            throw new ValidationError(
                `Function message content at index ${index} must be a string`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}.content`
            );
        } else if (message.content === null) {
            if (message.role !== 'assistant' || (!hasToolCalls && !hasFunctionCall)) {
                throw new ValidationError(
                    `Null content at index ${index} is only valid for assistant tool call messages`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.content`
                );
            }
        } else if (Array.isArray(message.content)) {
            // 多模态内容验证
            this.validateMultimodalContent(message.content, index);
            
        } else {
            throw new ValidationError(
                `Message content at index ${index} must be a string, null, or array`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}.content`
            );
        }
        
        const validatedMessage: EnhancedMessage = {
            role: message.role,
            content: message.content
        };
        
        // 可选字段
        if (message.name && typeof message.name === 'string') {
            validatedMessage.name = message.name;
        }

        if (message.role === 'function') {
            if (!message.name || typeof message.name !== 'string') {
                throw new ValidationError(
                    `Function message at index ${index} must include function name`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.name`
                );
            }
        }
        
        if (message.tool_calls !== undefined) {
            if (message.role !== 'assistant') {
                throw new ValidationError(
                    `tool_calls is only valid for assistant messages at index ${index}`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.tool_calls`
                );
            }
            validatedMessage.tool_calls = this.validateToolCalls(message.tool_calls, index);
        }

        if (message.function_call !== undefined) {
            if (message.role !== 'assistant') {
                throw new ValidationError(
                    `function_call is only valid for assistant messages at index ${index}`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.function_call`
                );
            }
            validatedMessage.function_call = this.validateMessageFunctionCall(message.function_call, index);
        }
        if (validatedMessage.tool_calls && validatedMessage.function_call) {
            throw new ValidationError(
                `Message at index ${index} cannot contain both tool_calls and function_call`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}`
            );
        }
        
        if (message.role === 'tool') {
            if (!message.tool_call_id || typeof message.tool_call_id !== 'string' || message.tool_call_id.trim().length === 0) {
                throw new ValidationError(
                    `Tool message at index ${index} must include tool_call_id`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${index}.tool_call_id`
                );
            }
            validatedMessage.tool_call_id = message.tool_call_id;
        } else if (message.role === 'function') {
            if (message.tool_call_id !== undefined) {
                if (typeof message.tool_call_id !== 'string' || message.tool_call_id.trim().length === 0) {
                    throw new ValidationError(
                        `Function message tool_call_id at index ${index} must be a non-empty string`,
                        ERROR_CODES.INVALID_REQUEST,
                        `messages.${index}.tool_call_id`
                    );
                }
                validatedMessage.tool_call_id = message.tool_call_id;
            }
        } else if (message.tool_call_id !== undefined) {
            throw new ValidationError(
                `tool_call_id is only valid for tool/function messages at index ${index}`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${index}.tool_call_id`
            );
        }
        
        return validatedMessage;
    }

    /**
     * 校验工具调用与结果消息之间的关联关系
     *
     * 遍历消息列表，维护 pending 队列追踪 assistant 发起的工具调用，
     * 并在遇到 tool/function 结果消息时进行匹配消费。
     * - 防止任意/错误 tool_call_id 绑定
     * - legacy function 消息无 tool_call_id 时，仅在无歧义（同名调用唯一）时允许关联
     *
     * @param messages - 经过单条验证的增强消息数组
     * @throws {ValidationError} 当关联关系不合法（重复 id、找不到匹配、歧义）时抛出
     */
    private static validateToolCallAssociations(messages: EnhancedMessage[]): void {
        const pendingByName = new Map<string, Array<{ id?: string; assistantIndex: number }>>();
        const pendingById = new Map<string, { name: string; assistantIndex: number }>();

        const addPending = (name: string, assistantIndex: number, id?: string) => {
            const pending = pendingByName.get(name) || [];
            pending.push({ id, assistantIndex });
            pendingByName.set(name, pending);

            if (id) {
                if (pendingById.has(id)) {
                    throw new ValidationError(
                        `Duplicate tool call id "${id}" found in assistant messages`,
                        ERROR_CODES.INVALID_REQUEST,
                        `messages.${assistantIndex}.tool_calls`
                    );
                }
                pendingById.set(id, { name, assistantIndex });
            }
        };

        const removePendingByNameEntry = (name: string, matcher: (entry: { id?: string; assistantIndex: number }) => boolean) => {
            const pending = pendingByName.get(name);
            if (!pending || pending.length === 0) {
                return;
            }

            const index = pending.findIndex(matcher);
            if (index === -1) {
                return;
            }

            pending.splice(index, 1);
            if (pending.length === 0) {
                pendingByName.delete(name);
            } else {
                pendingByName.set(name, pending);
            }
        };

        const consumeById = (toolCallId: string, messageIndex: number, paramPath: string, expectedName?: string) => {
            const pending = pendingById.get(toolCallId);
            if (!pending) {
                throw new ValidationError(
                    `No matching assistant tool call found for tool_call_id "${toolCallId}" at message ${messageIndex}`,
                    ERROR_CODES.INVALID_REQUEST,
                    paramPath
                );
            }

            if (expectedName && pending.name !== expectedName) {
                throw new ValidationError(
                    `tool_call_id "${toolCallId}" maps to function "${pending.name}" but message ${messageIndex} declares name "${expectedName}"`,
                    ERROR_CODES.INVALID_REQUEST,
                    paramPath
                );
            }

            pendingById.delete(toolCallId);
            removePendingByNameEntry(pending.name, entry => entry.id === toolCallId);
        };

        const consumeLegacyByName = (name: string, messageIndex: number, paramPath: string) => {
            const pending = pendingByName.get(name) || [];

            if (pending.length === 0) {
                throw new ValidationError(
                    `Function message at index ${messageIndex} has no matching prior assistant tool/function call for name "${name}"`,
                    ERROR_CODES.INVALID_REQUEST,
                    paramPath
                );
            }

            if (pending.length > 1) {
                throw new ValidationError(
                    `Function message at index ${messageIndex} is ambiguous for name "${name}". Please provide explicit tool_call_id.`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${messageIndex}.tool_call_id`
                );
            }

            const matched = pending[0];
            if (matched.id) {
                pendingById.delete(matched.id);
            }
            removePendingByNameEntry(name, entry => entry === matched);
        };

        messages.forEach((message, index) => {
            if (message.role === 'assistant') {
                for (const call of message.tool_calls || []) {
                    addPending(call.function.name, index, call.id);
                }

                if (message.function_call) {
                    addPending(message.function_call.name, index);
                }
                return;
            }

            if (message.role === 'tool' && message.tool_call_id) {
                consumeById(message.tool_call_id, index, `messages.${index}.tool_call_id`);
                return;
            }

            if (message.role === 'function') {
                const functionName = message.name as string;
                if (message.tool_call_id) {
                    consumeById(
                        message.tool_call_id,
                        index,
                        `messages.${index}.tool_call_id`,
                        functionName
                    );
                } else {
                    consumeLegacyByName(functionName, index, `messages.${index}.name`);
                }
            }
        });
    }
    
    /**
     * 验证多模态内容数组
     *
     * 检查内容数组中每个 part 的类型（text/image_url），验证文本部分的必填字段，
     * 验证图像部分的 URL 格式和安全性，并限制单条消息的图像数量上限。
     *
     * @param content - 多模态内容数组
     * @param messageIndex - 所属消息在数组中的索引（用于错误提示定位）
     * @throws {ValidationError} 当内容格式不合法时抛出
     */
    private static validateMultimodalContent(content: any[], messageIndex: number): void {
        if (content.length === 0) {
            throw new ValidationError(
                `Multimodal content array at message ${messageIndex} cannot be empty`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${messageIndex}.content`
            );
        }
        
        let imageCount = 0;
        
        for (let i = 0; i < content.length; i++) {
            const part = content[i];
            
            if (!part || typeof part !== 'object') {
                throw new ValidationError(
                    `Content part ${i} at message ${messageIndex} must be an object`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${messageIndex}.content.${i}`
                );
            }
            
            if (part.type === 'text') {
                if (!part.text || typeof part.text !== 'string') {
                    throw new ValidationError(
                        `Text content part ${i} at message ${messageIndex} must have a text field`,
                        ERROR_CODES.INVALID_REQUEST,
                        `messages.${messageIndex}.content.${i}.text`
                    );
                }
                
            } else if (part.type === 'image_url') {
                imageCount++;
                
                if (!part.image_url || typeof part.image_url !== 'object') {
                    throw new ValidationError(
                        `Image content part ${i} at message ${messageIndex} must have an image_url object`,
                        ERROR_CODES.INVALID_REQUEST,
                        `messages.${messageIndex}.content.${i}.image_url`
                    );
                }
                
                if (!part.image_url.url || typeof part.image_url.url !== 'string') {
                    throw new ValidationError(
                        `Image URL at message ${messageIndex}, part ${i} is required`,
                        ERROR_CODES.INVALID_REQUEST,
                        `messages.${messageIndex}.content.${i}.image_url.url`
                    );
                }
                
                // 验证图像 URL 格式
                this.validateImageUrl(part.image_url.url, messageIndex, i);
                
            } else {
                throw new ValidationError(
                    `Unknown content type "${part.type}" at message ${messageIndex}, part ${i}`,
                    ERROR_CODES.INVALID_REQUEST,
                    `messages.${messageIndex}.content.${i}.type`
                );
            }
        }
        
        // 限制每条消息的图像数量
        if (imageCount > 10) { // Reasonable limit
            throw new ValidationError(
                `Too many images in message ${messageIndex}. Maximum 10 images per message`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${messageIndex}.content`
            );
        }
    }
    
    /**
     * 验证图像 URL 格式
     *
     * 仅允许 base64 data URI 和 HTTP(S) URL，
     * 阻止 file:// 等本地协议以防止 SSRF 攻击。
     *
     * @param url - 待验证的图像 URL 字符串
     * @param messageIndex - 所属消息在数组中的索引
     * @param partIndex - 所属内容部分在数组中的索引
     * @throws {ValidationError} 当 URL 格式不合法时抛出
     */
    private static validateImageUrl(url: string, messageIndex: number, partIndex: number): void {
        // 仅支持 base64 和 HTTP(S) URL（移除 file:// 和本地路径以防止 SSRF）
        const validPatterns = [
            /^data:image\/(jpeg|jpg|png|gif|webp);base64,/, // Base64
            /^https?:\/\/.+/i,                              // HTTP/HTTPS URLs（不限扩展名）
        ];

        const isValid = validPatterns.some(pattern => pattern.test(url));

        if (!isValid) {
            throw new ValidationError(
                `Invalid image URL format at message ${messageIndex}, part ${partIndex}. Supported: base64 data URI, HTTP/HTTPS URLs`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${messageIndex}.content.${partIndex}.image_url.url`
            );
        }
    }
    
    /**
     * 动态模型验证（无硬编码限制）
     *
     * 强制要求明确指定模型名称，禁止空值和自动选择。
     * 若提供了可用模型列表，会检查模型是否存在并记录警告（不强制拒绝）。
     *
     * @param model - 待验证的模型标识
     * @param availableModels - 当前可用的模型能力列表（可选）
     * @returns 验证后的模型名称字符串
     * @throws {ValidationError} 当模型参数缺失或格式不合法时抛出
     */
    private static validateDynamicModel(model: any, availableModels?: ModelCapabilities[]): string {
        // 强制要求明确指定模型，禁止自动选择
        if (!model || (typeof model === 'string' && model.trim() === '')) {
            throw new ValidationError('Model is required and cannot be empty', ERROR_CODES.INVALID_REQUEST, 'model');
        }

        if (typeof model !== 'string') {
            throw new ValidationError('Model must be a string', ERROR_CODES.INVALID_REQUEST, 'model');
        }

        if (model === 'auto-select') {
            throw new ValidationError('Automatic model selection is disabled. Please specify a concrete model id.', ERROR_CODES.INVALID_REQUEST, 'model');
        }

        // 如果提供了可用模型，检查模型是否存在（不强制，但记录）
        if (availableModels && availableModels.length > 0) {
            const modelExists = availableModels.some(m => m.id === model);
            if (!modelExists) {
                logger.warn(`⚠️ Requested model "${model}" not found in available models.`);
            }
        }

        return model;
    }
    
    /**
     * 验证函数定义数组
     *
     * @param functions - 待验证的函数定义数组
     * @returns 经过验证的函数定义数组
     * @throws {ValidationError} 当数组格式不合法时抛出
     */
    private static validateFunctions(functions: any): FunctionDefinition[] {
        if (!Array.isArray(functions)) {
            throw new ValidationError('Functions must be an array', ERROR_CODES.INVALID_REQUEST, 'functions');
        }
        
        return functions.map((func, index) => this.validateFunction(func, `functions.${index}`));
    }
    
    /**
     * 验证单个函数定义
     *
     * 检查函数名称（必填）、描述（可选）、参数 schema（可选，需为对象）的合法性。
     *
     * @param func - 待验证的函数定义对象
     * @param path - 参数路径（用于错误提示定位，如 "functions.0"）
     * @returns 经过验证和规范化的函数定义
     * @throws {ValidationError} 当函数定义不合法时抛出
     */
    private static validateFunction(func: any, path: string): FunctionDefinition {
        if (!func || typeof func !== 'object') {
            throw new ValidationError(
                `Function at ${path} must be an object`,
                ERROR_CODES.INVALID_REQUEST,
                path
            );
        }
        
        if (!func.name || typeof func.name !== 'string') {
            throw new ValidationError(
                `Function name at ${path} is required`,
                ERROR_CODES.INVALID_REQUEST,
                `${path}.name`
            );
        }
        
        if (func.parameters && typeof func.parameters !== 'object') {
            throw new ValidationError(
                `Function parameters at ${path} must be an object`,
                ERROR_CODES.INVALID_REQUEST,
                `${path}.parameters`
            );
        }
        
        return {
            name: func.name,
            description: func.description,
            parameters: func.parameters || { type: 'object', properties: {} }
        };
    }
    
    /**
     * 验证工具定义数组
     *
     * 逐一验证每个工具的类型（必须为 "function"）和内嵌函数定义。
     *
     * @param tools - 待验证的工具定义数组
     * @returns 经过验证的 OpenAI 工具数组
     * @throws {ValidationError} 当工具定义不合法时抛出
     */
    private static validateTools(tools: any): OpenAITool[] {
        if (!Array.isArray(tools)) {
            throw new ValidationError('Tools must be an array', ERROR_CODES.INVALID_REQUEST, 'tools');
        }
        
        return tools.map((tool, index): OpenAITool => {
            if (!tool || typeof tool !== 'object') {
                throw new ValidationError(
                    `Tool at index ${index} must be an object`,
                    ERROR_CODES.INVALID_REQUEST,
                    `tools.${index}`
                );
            }

            if (tool.type !== 'function') {
                throw new ValidationError(
                    `Tool type at index ${index} must be "function"`,
                    ERROR_CODES.INVALID_REQUEST,
                    `tools.${index}.type`
                );
            }

            const validatedFunction = this.validateFunction(tool.function, `tools.${index}.function`);
            return {
                type: 'function',
                function: {
                    name: validatedFunction.name,
                    description: validatedFunction.description,
                    parameters: validatedFunction.parameters
                }
            };
        });
    }

    /**
     * 验证 assistant 消息中的 tool_calls 数组
     *
     * 检查每个 tool_call 的 id（必填）、type（必须为 "function"）、
     * function.name（必填）和 function.arguments（必须为字符串）。
     *
     * @param toolCalls - 待验证的 tool_calls 数组
     * @param messageIndex - 所属消息在数组中的索引（用于错误提示定位）
     * @returns 经过验证的 ToolCall 数组
     * @throws {ValidationError} 当 tool_calls 格式不合法时抛出
     */
    private static validateToolCalls(toolCalls: any, messageIndex: number): ToolCall[] {
        if (!Array.isArray(toolCalls)) {
            throw new ValidationError(
                `tool_calls at message ${messageIndex} must be an array`,
                ERROR_CODES.INVALID_REQUEST,
                `messages.${messageIndex}.tool_calls`
            );
        }

        return toolCalls.map((call, callIndex): ToolCall => {
            const basePath = `messages.${messageIndex}.tool_calls.${callIndex}`;
            if (!call || typeof call !== 'object') {
                throw new ValidationError(`Invalid tool call at ${basePath}`, ERROR_CODES.INVALID_REQUEST, basePath);
            }

            if (!call.id || typeof call.id !== 'string') {
                throw new ValidationError(`tool call id is required at ${basePath}`, ERROR_CODES.INVALID_REQUEST, `${basePath}.id`);
            }

            if (call.type !== 'function') {
                throw new ValidationError(`tool call type must be "function" at ${basePath}`, ERROR_CODES.INVALID_REQUEST, `${basePath}.type`);
            }

            if (!call.function || typeof call.function !== 'object') {
                throw new ValidationError(`tool call function is required at ${basePath}`, ERROR_CODES.INVALID_REQUEST, `${basePath}.function`);
            }

            if (!call.function.name || typeof call.function.name !== 'string') {
                throw new ValidationError(`tool call function.name is required at ${basePath}`, ERROR_CODES.INVALID_REQUEST, `${basePath}.function.name`);
            }

            if (typeof call.function.arguments !== 'string') {
                throw new ValidationError(`tool call function.arguments must be a string at ${basePath}`, ERROR_CODES.INVALID_REQUEST, `${basePath}.function.arguments`);
            }

            return {
                id: call.id,
                type: 'function',
                function: {
                    name: call.function.name,
                    arguments: call.function.arguments
                }
            };
        });
    }

    /**
     * 验证 assistant 消息中的 legacy function_call 对象
     *
     * 检查 function_call 的 name（必填）和 arguments（必须为字符串）。
     *
     * @param functionCall - 待验证的 function_call 对象
     * @param messageIndex - 所属消息在数组中的索引（用于错误提示定位）
     * @returns 经过验证的 function_call 对象（包含 name 和 arguments）
     * @throws {ValidationError} 当 function_call 格式不合法时抛出
     */
    private static validateMessageFunctionCall(functionCall: any, messageIndex: number): { name: string; arguments: string } {
        const basePath = `messages.${messageIndex}.function_call`;
        if (!functionCall || typeof functionCall !== 'object') {
            throw new ValidationError('function_call must be an object', ERROR_CODES.INVALID_REQUEST, basePath);
        }

        if (!functionCall.name || typeof functionCall.name !== 'string') {
            throw new ValidationError('function_call.name is required', ERROR_CODES.INVALID_REQUEST, `${basePath}.name`);
        }

        if (typeof functionCall.arguments !== 'string') {
            throw new ValidationError('function_call.arguments must be a string', ERROR_CODES.INVALID_REQUEST, `${basePath}.arguments`);
        }

        return {
            name: functionCall.name,
            arguments: functionCall.arguments
        };
    }

    /**
     * 验证 function_call 调用策略选择
     *
     * 支持 "none"、"auto" 字符串以及指定函数名的对象格式 { name }。
     * 使用对象格式时，会校验指定的函数名是否存在于已定义的工具列表中。
     *
     * @param functionCall - 待验证的 function_call 选择策略
     * @param availableToolNames - 当前请求中已定义的工具/函数名称列表
     * @returns 验证后的 function_call 选择策略
     * @throws {ValidationError} 当策略格式不合法或引用了未定义的函数时抛出
     */
    private static validateFunctionCallChoice(
        functionCall: any,
        availableToolNames: string[]
    ): OpenAIFunctionCallChoice {
        if (functionCall === 'none' || functionCall === 'auto') {
            return functionCall;
        }

        if (availableToolNames.length === 0) {
            throw new ValidationError(
                'function_call requires at least one function/tool definition',
                ERROR_CODES.INVALID_REQUEST,
                'function_call'
            );
        }

        if (!functionCall || typeof functionCall !== 'object' || typeof functionCall.name !== 'string') {
            throw new ValidationError('function_call must be "none", "auto", or { name }', ERROR_CODES.INVALID_REQUEST, 'function_call');
        }

        if (availableToolNames.length > 0 && !availableToolNames.includes(functionCall.name)) {
            throw new ValidationError(
                `function_call requested unknown function "${functionCall.name}"`,
                ERROR_CODES.INVALID_REQUEST,
                'function_call.name'
            );
        }

        return { name: functionCall.name };
    }

    /**
     * 验证 tool_choice 工具选择策略
     *
     * 支持 "none"、"auto"、"required" 字符串以及指定工具的对象格式
     * { type: "function", function: { name } }。
     * 使用对象格式时，会校验指定的函数名是否存在于已定义的工具列表中。
     *
     * @param toolChoice - 待验证的 tool_choice 选择策略
     * @param availableToolNames - 当前请求中已定义的工具/函数名称列表
     * @returns 验证后的 tool_choice 选择策略
     * @throws {ValidationError} 当策略格式不合法或引用了未定义的函数时抛出
     */
    private static validateToolChoice(
        toolChoice: any,
        availableToolNames: string[]
    ): OpenAIToolChoice {
        if (availableToolNames.length === 0 && toolChoice !== 'none') {
            throw new ValidationError(
                'tool_choice requires at least one function/tool definition',
                ERROR_CODES.INVALID_REQUEST,
                'tool_choice'
            );
        }

        if (toolChoice === 'none' || toolChoice === 'auto' || toolChoice === 'required') {
            return toolChoice;
        }

        if (
            !toolChoice ||
            typeof toolChoice !== 'object' ||
            toolChoice.type !== 'function' ||
            !toolChoice.function ||
            typeof toolChoice.function.name !== 'string'
        ) {
            throw new ValidationError(
                'tool_choice must be "none", "auto", "required", or { type: "function", function: { name } }',
                ERROR_CODES.INVALID_REQUEST,
                'tool_choice'
            );
        }

        if (availableToolNames.length > 0 && !availableToolNames.includes(toolChoice.function.name)) {
            throw new ValidationError(
                `tool_choice requested unknown function "${toolChoice.function.name}"`,
                ERROR_CODES.INVALID_REQUEST,
                'tool_choice.function.name'
            );
        }

        return {
            type: 'function',
            function: {
                name: toolChoice.function.name
            }
        };
    }
    
    /**
     * 验证 max_tokens 参数（结合动态模型上下文）
     *
     * 检查 max_tokens 为正整数，并在提供了模型能力信息时，
     * 根据模型的 maxOutputTokens（或 maxInputTokens 的 50%）进行上限校验。
     *
     * @param maxTokens - 待验证的 max_tokens 值
     * @param selectedModel - 选定模型的能力信息（可选，用于上限校验）
     * @returns 验证后的 max_tokens 值，未指定时返回 undefined
     * @throws {ValidationError} 当 max_tokens 格式不合法或超出模型上限时抛出
     */
    private static validateMaxTokens(maxTokens: any, selectedModel?: ModelCapabilities): number | undefined {
        if (maxTokens === undefined || maxTokens === null) {
            return undefined;
        }
        
        if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens)) {
            throw new ValidationError('max_tokens must be an integer', ERROR_CODES.INVALID_REQUEST, 'max_tokens');
        }
        
        if (maxTokens < 1) {
            throw new ValidationError('max_tokens must be at least 1', ERROR_CODES.INVALID_REQUEST, 'max_tokens');
        }
        
        // 基于选定模型的动态验证
        if (selectedModel) {
            const modelLimit = selectedModel.maxOutputTokens || selectedModel.maxInputTokens * 0.5;
            if (maxTokens > modelLimit) {
                throw new ValidationError(
                    `max_tokens cannot exceed ${Math.floor(modelLimit)} for model ${selectedModel.id}`,
                    ERROR_CODES.INVALID_REQUEST,
                    'max_tokens'
                );
            }
        }
        
        return maxTokens;
    }
    
    // 其他验证方法
    
    /**
     * 验证 stream 参数
     *
     * @param stream - 待验证的 stream 值
     * @returns 验证后的布尔值，未指定时默认返回 false
     * @throws {ValidationError} 当 stream 不是布尔类型时抛出
     */
    private static validateStream(stream: any): boolean {
        if (stream === undefined || stream === null) {
            return false;
        }
        
        if (typeof stream !== 'boolean') {
            throw new ValidationError('Stream must be a boolean', ERROR_CODES.INVALID_REQUEST, 'stream');
        }
        
        return stream;
    }
    
    /**
     * 验证 temperature 采样温度参数
     *
     * @param temperature - 待验证的温度值
     * @returns 验证后的温度值，未指定时默认返回 1.0
     * @throws {ValidationError} 当温度不是数字或超出 [0, 2] 范围时抛出
     */
    private static validateTemperature(temperature: any): number {
        if (temperature === undefined || temperature === null) {
            return 1.0;
        }
        
        if (typeof temperature !== 'number' || isNaN(temperature)) {
            throw new ValidationError('Temperature must be a number', ERROR_CODES.INVALID_REQUEST, 'temperature');
        }
        
        if (temperature < 0 || temperature > 2) {
            throw new ValidationError('Temperature must be between 0 and 2', ERROR_CODES.INVALID_REQUEST, 'temperature');
        }
        
        return temperature;
    }
    
    /**
     * 验证 n 参数（生成候选数量）
     *
     * @param n - 待验证的候选数量
     * @returns 验证后的整数值，未指定时返回 undefined
     * @throws {ValidationError} 当 n 不是整数或超出 [1, 10] 范围时抛出
     */
    private static validateN(n: any): number | undefined {
        if (n === undefined || n === null) {
            return undefined;
        }
        
        if (typeof n !== 'number' || !Number.isInteger(n)) {
            throw new ValidationError('n must be an integer', ERROR_CODES.INVALID_REQUEST, 'n');
        }
        
        if (n < 1 || n > 10) {
            throw new ValidationError('n must be between 1 and 10', ERROR_CODES.INVALID_REQUEST, 'n');
        }
        
        return n;
    }
    
    /**
     * 验证 top_p 核采样参数
     *
     * @param topP - 待验证的 top_p 值
     * @returns 验证后的数值，未指定时返回 undefined
     * @throws {ValidationError} 当 top_p 不是数字或超出 [0, 1] 范围时抛出
     */
    private static validateTopP(topP: any): number | undefined {
        if (topP === undefined || topP === null) {
            return undefined;
        }
        
        if (typeof topP !== 'number' || isNaN(topP)) {
            throw new ValidationError('top_p must be a number', ERROR_CODES.INVALID_REQUEST, 'top_p');
        }
        
        if (topP < 0 || topP > 1) {
            throw new ValidationError('top_p must be between 0 and 1', ERROR_CODES.INVALID_REQUEST, 'top_p');
        }
        
        return topP;
    }
    
    /**
     * 验证 stop 停止序列参数
     *
     * 支持字符串或字符串数组格式，数组最多包含 4 个元素。
     *
     * @param stop - 待验证的停止序列
     * @returns 验证后的停止序列，未指定时返回 undefined
     * @throws {ValidationError} 当格式不合法或数组超出限制时抛出
     */
    private static validateStop(stop: any): string | string[] | undefined {
        if (stop === undefined || stop === null) {
            return undefined;
        }
        
        if (typeof stop === 'string') {
            return stop;
        }
        
        if (Array.isArray(stop)) {
            if (stop.length > 4) {
                throw new ValidationError('stop array cannot have more than 4 elements', ERROR_CODES.INVALID_REQUEST, 'stop');
            }
            
            for (const item of stop) {
                if (typeof item !== 'string') {
                    throw new ValidationError('All stop array elements must be strings', ERROR_CODES.INVALID_REQUEST, 'stop');
                }
            }
            
            return stop;
        }
        
        throw new ValidationError('stop must be a string or array of strings', ERROR_CODES.INVALID_REQUEST, 'stop');
    }
    
    /**
     * 验证惩罚系数参数（presence_penalty / frequency_penalty）
     *
     * @param penalty - 待验证的惩罚系数值
     * @param paramName - 参数名称（用于错误提示，如 "presence_penalty"）
     * @returns 验证后的数值，未指定时返回 undefined
     * @throws {ValidationError} 当惩罚系数不是数字或超出 [-2, 2] 范围时抛出
     */
    private static validatePenalty(penalty: any, paramName: string): number | undefined {
        if (penalty === undefined || penalty === null) {
            return undefined;
        }
        
        if (typeof penalty !== 'number' || isNaN(penalty)) {
            throw new ValidationError(`${paramName} must be a number`, ERROR_CODES.INVALID_REQUEST, paramName);
        }
        
        if (penalty < -2 || penalty > 2) {
            throw new ValidationError(`${paramName} must be between -2 and 2`, ERROR_CODES.INVALID_REQUEST, paramName);
        }
        
        return penalty;
    }
    
    /**
     * 验证 user 用户标识参数
     *
     * @param user - 待验证的用户标识字符串
     * @returns 验证后的用户标识字符串
     * @throws {ValidationError} 当 user 不是字符串或超过 256 字符时抛出
     */
    private static validateUser(user: any): string {
        if (typeof user !== 'string') {
            throw new ValidationError('user must be a string', ERROR_CODES.INVALID_REQUEST, 'user');
        }
        
        if (user.length > 256) {
            throw new ValidationError('user string cannot exceed 256 characters', ERROR_CODES.INVALID_REQUEST, 'user');
        }
        
        return user;
    }
    
    /**
     * 字符串清理
     *
     * 去除首尾空白并移除所有 ASCII 控制字符（0x00-0x1F 和 0x7F）。
     *
     * @param input - 待清理的原始字符串
     * @returns 清理后的安全字符串
     */
    public static sanitizeString(input: string): string {
        return input.trim().replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters
    }
    
    /**
     * 验证端口号
     *
     * 检查端口为整数且在允许范围（MIN_PORT ~ MAX_PORT）内。
     *
     * @param port - 待验证的端口号
     * @returns 验证后的端口号
     * @throws {ValidationError} 当端口不是整数或超出范围时抛出
     */
    public static validatePort(port: any): number {
        if (typeof port !== 'number' || !Number.isInteger(port)) {
            throw new ValidationError('Port must be an integer');
        }
        
        if (port < LIMITS.MIN_PORT || port > LIMITS.MAX_PORT) {
            throw new ValidationError(`Port must be between ${LIMITS.MIN_PORT} and ${LIMITS.MAX_PORT}`);
        }
        
        return port;
    }
    
    /**
     * 验证主机地址字符串
     *
     * 仅允许 localhost 相关地址（localhost、127.0.0.1、0.0.0.0、::1），
     * 防止监听外部网络接口造成安全风险。
     *
     * @param host - 待验证的主机地址
     * @returns 经过清理和验证的主机地址字符串
     * @throws {ValidationError} 当主机地址不合法或不是 localhost 地址时抛出
     */
    public static validateHost(host: any): string {
        if (typeof host !== 'string') {
            throw new ValidationError('Host must be a string');
        }
        
        const sanitized = this.sanitizeString(host);
        
        if (!/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/.test(sanitized)) {
            throw new ValidationError('Only localhost addresses are allowed for security');
        }
        
        return sanitized;
    }
}
