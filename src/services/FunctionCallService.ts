/**
 * @module FunctionCallService
 * @description 函数调用服务 - 连接 OpenAI 函数调用格式与 VS Code 语言模型工具 API。
 *
 * 本模块是服务层（services/）的关键组件，负责将 OpenAI 格式的工具/函数定义
 * 转换为 VS Code LM API 可接受的工具格式，管理工具注册表，并提供工具调用的
 * 执行引擎（含参数验证、超时控制、错误处理）。
 *
 * 架构位置：
 *   RequestHandler --> FunctionCallService --> vscode.LanguageModelChatTool
 *   OpenAI tools/functions --> 格式转换 --> VS Code LM API 工具
 *
 * 关键依赖：
 *   - vscode：LanguageModelChatTool / LanguageModelChatToolMode 类型
 *   - types/ModelCapabilities：FunctionDefinition / ToolCall 类型定义
 *   - types/OpenAI：OpenAIFunction / OpenAITool / OpenAIToolChoice 等类型
 *   - Logger：统一日志
 *
 * 设计要点：
 *   1. 双格式兼容 - 同时支持 OpenAI 现代 tools 格式和旧版 functions 格式
 *   2. 工具注册表 - 通过 Map 维护工具的注册状态、使用计数、错误计数等元数据
 *   3. tool_choice / function_call 语义解析 - 正确处理 none/auto/required/指定工具名等模式
 *   4. 执行引擎 - 带 30 秒超时保护、JSON 参数解析、必需字段校验
 *   5. 事件通知 - 通过 EventEmitter 发布工具注册、执行成功、执行错误等事件
 *
 * 接口/类清单：
 *
 * 【EnhancedTool（接口）】
 *   - 功能：增强型工具定义，包含处理器函数和元数据信息
 *
 * 【ToolExecutionContext（接口）】
 *   - 功能：工具执行上下文，携带请求 ID、超时时间等执行环境信息
 *
 * 【ToolRegistryEntry（接口）】
 *   - 功能：工具注册表条目，包含工具定义、启用状态、使用计数、错误计数等
 *
 * 【FunctionCallService（类）】
 *   功能：管理工具注册表、格式转换和工具执行的核心服务
 *
 *   1. constructor()
 *      - 功能：初始化工具注册表（Map）和事件发射器
 *      - 输入：无
 *      - 输出：FunctionCallService 实例
 *
 *   2. registerTool(id: string, tool: EnhancedTool): void
 *      - 功能：注册工具到注册表
 *      - 输入：id — 工具 ID；tool — 增强型工具定义
 *      - 输出：void
 *
 *   3. convertFunctionsToTools(functions: FunctionDefinition[]): vscode.LanguageModelChatTool[]
 *      - 功能：将内部函数定义转换为 VS Code 语言模型工具格式
 *      - 输入：functions — 内部函数定义数组
 *      - 输出：vscode.LanguageModelChatTool[] — VS Code 工具数组
 *
 *   4. convertOpenAIToolsToFunctions(tools: OpenAITool[]): FunctionDefinition[]
 *      - 功能：将 OpenAI 工具格式转换为内部函数定义
 *      - 输入：tools — OpenAI 工具数组
 *      - 输出：FunctionDefinition[] — 内部函数定义数组
 *
 *   5. prepareToolsForRequest(functions?, tools?, toolChoice?, functionCall?): { tools, toolMode? }
 *      - 功能：为请求准备完整的工具配置（合并函数和工具定义，解析调用模式）
 *      - 输入：functions — 旧版函数数组（可选）；tools — 现代工具数组（可选）；
 *              toolChoice — 工具选择控制（可选）；functionCall — 函数调用控制（可选）
 *      - 输出：{ tools: vscode.LanguageModelChatTool[], toolMode?: LanguageModelChatToolMode }
 *
 *   6. resolveForcedToolName(toolChoice?, functionCall?): string | undefined
 *      - 功能：解析强制指定的工具名称（当 tool_choice 或 function_call 指定具体工具时）
 *      - 输入：toolChoice — 工具选择控制（可选）；functionCall — 函数调用控制（可选）
 *      - 输出：string | undefined — 强制工具名或 undefined
 *
 *   7. resolveToolMode(toolChoice?, functionCall?): LanguageModelChatToolMode
 *      - 功能：解析工具调用模式（Auto / Required）
 *      - 输入：toolChoice — 工具选择控制（可选）；functionCall — 函数调用控制（可选）
 *      - 输出：LanguageModelChatToolMode — 解析后的工具模式
 *
 *   8. executeToolCall(toolCall: ToolCall, context: ToolExecutionContext): Promise<{ success, result?, error? }>
 *      - 功能：执行工具调用，带 30 秒超时保护和参数验证
 *      - 输入：toolCall — 工具调用信息；context — 执行上下文
 *      - 输出：Promise<{ success: boolean, result?: string, error?: string }>
 *
 *   9. validateParameters(parameters: Record<string, unknown>, schema: object): { isValid, error? }
 *      - 功能：验证工具参数是否符合 JSON Schema（检查必需字段）
 *      - 输入：parameters — 参数对象；schema — JSON Schema 定义
 *      - 输出：{ isValid: boolean, error?: string }
 *
 *   10. getAvailableTools(modelCapabilities: ModelCapabilities): FunctionDefinition[]
 *       - 功能：获取指定模型能力下可用的工具列表
 *       - 输入：modelCapabilities — 模型能力描述
 *       - 输出：FunctionDefinition[] — 可用工具的函数定义列表
 *
 *   11. getToolStats(): object
 *       - 功能：获取工具使用统计（调用次数、错误率等）
 *       - 输入：无
 *       - 输出：object — 统计信息对象
 *
 *   12. setToolEnabled(toolId: string, enabled: boolean): boolean
 *       - 功能：启用或禁用指定工具
 *       - 输入：toolId — 工具 ID；enabled — 是否启用
 *       - 输出：boolean — 操作是否成功
 *
 *   13. dispose(): void
 *       - 功能：释放资源（清空注册表、释放事件发射器）
 *       - 输入：无
 *       - 输出：void
 */

import * as vscode from 'vscode';
import { 
    FunctionDefinition, 
    ToolCall, 
    ModelCapabilities 
} from '../types/ModelCapabilities';
import {
    OpenAIFunction,
    OpenAIFunctionCallChoice,
    OpenAITool,
    OpenAIToolChoice
} from '../types/OpenAI';
import { logger } from '../utils/Logger';

/**
 * 增强型工具定义接口
 *
 * 在基础函数定义之上扩展了执行处理器和元数据信息，
 * 用于在工具注册表中完整描述一个可执行的工具。
 */
export interface EnhancedTool {
    /** 工具的函数定义（名称、描述、参数 JSON Schema） */
    definition: FunctionDefinition;
    /**
     * 工具执行处理器
     * @param parameters - 经过验证的调用参数
     * @param context - 工具执行上下文（请求 ID、模型 ID 等）
     * @returns 工具执行结果
     */
    handler: (parameters: any, context: ToolExecutionContext) => Promise<any>;
    /** 工具元数据，描述工具的分类、版本、权限等信息 */
    metadata: {
        /** 工具分类（如 "code"、"search"、"file" 等） */
        category: string;
        /** 工具的人类可读描述 */
        description: string;
        /** 工具版本号 */
        version: string;
        /** 工具作者 */
        author: string;
        /** 是否需要身份认证才能调用 */
        requiresAuth?: boolean;
        /** 是否受速率限制约束 */
        rateLimited?: boolean;
    };
}

/**
 * 工具执行上下文接口
 *
 * 提供工具执行时所需的环境信息，包括请求追踪、用户身份和权限等。
 */
export interface ToolExecutionContext {
    /** 当前请求的唯一标识符，用于日志追踪 */
    requestId: string;
    /** 当前使用的语言模型 ID */
    modelId: string;
    /** 发起请求的用户标识（可选） */
    userId?: string;
    /** 会话标识（可选） */
    sessionId?: string;
    /** 运行环境标识 */
    environment: 'development' | 'production';
    /** 当前上下文拥有的权限列表 */
    permissions: string[];
}

/**
 * 工具注册表条目接口
 *
 * 在工具注册表中存储的单个工具条目，包含工具本身及其运行时状态。
 */
export interface ToolRegistryEntry {
    /** 工具的唯一标识符 */
    id: string;
    /** 增强型工具定义（含处理器和元数据） */
    tool: EnhancedTool;
    /** 工具是否处于启用状态 */
    isEnabled: boolean;
    /** 工具被调用的累计次数 */
    usageCount: number;
    /** 工具最后一次被调用的时间 */
    lastUsed?: Date;
    /** 工具执行失败的累计次数 */
    errorCount: number;
}

/**
 * 函数调用服务类
 *
 * 提供 OpenAI 函数/工具调用与 VS Code 语言模型工具 API 之间的完整桥接功能。
 *
 * 主要职责：
 * - 管理工具注册表（注册、启用/禁用、查询）
 * - 将 OpenAI functions/tools 定义转换为 VS Code LanguageModelChatTool 格式
 * - 解析 tool_choice / function_call 语义，确定工具调用模式（auto/required/指定）
 * - 执行工具调用（带参数验证、超时控制、错误处理）
 * - 维护工具使用统计（调用次数、错误次数、最后使用时间）
 */
export class FunctionCallService {
    /** 工具注册表，键为工具 ID，存储工具定义及运行时状态 */
    private toolRegistry: Map<string, ToolRegistryEntry>;
    /** 事件发射器，用于发布工具注册、执行、错误等事件 */
    private eventEmitter: vscode.EventEmitter<{ type: string; data: any }>;

    /**
     * 构造函数 - 初始化空的工具注册表和事件发射器
     */
    constructor() {
        this.toolRegistry = new Map();
        this.eventEmitter = new vscode.EventEmitter();
    }
    
    /**
     * 注册新工具到注册表
     *
     * 创建注册表条目，设置初始计数为零并标记为启用状态，
     * 然后触发 tool_registered 事件通知订阅者。
     *
     * @param id - 工具的唯一标识符
     * @param tool - 增强型工具定义（含处理器和元数据）
     */
    public registerTool(id: string, tool: EnhancedTool): void {
        const entry: ToolRegistryEntry = {
            id,
            tool,
            isEnabled: true,
            usageCount: 0,
            errorCount: 0
        };

        this.toolRegistry.set(id, entry);

        logger.info(`Registered tool: ${id}`);

        this.eventEmitter.fire({
            type: 'tool_registered',
            data: { id, tool: tool.definition }
        });
    }
    
    /**
     * 将内部函数定义数组转换为 VS Code 语言模型工具格式
     *
     * 将 FunctionDefinition[] 映射为 vscode.LanguageModelChatTool[]，
     * 每个工具包含 name、description 和 inputSchema（JSON Schema）。
     *
     * @param functions - 内部函数定义数组
     * @returns VS Code 语言模型工具数组
     */
    public convertFunctionsToTools(functions: FunctionDefinition[]): vscode.LanguageModelChatTool[] {
        return functions.map(func => ({
            name: func.name,
            description: func.description || '',
            inputSchema: func.parameters || { type: 'object', properties: {} }
        }));
    }

    /**
     * 将 OpenAI tool 定义数组转换为内部 FunctionDefinition 数组
     *
     * 过滤出类型为 'function' 且包含有效名称的工具，
     * 提取其 function 字段并转换为 FunctionDefinition 格式。
     *
     * @param tools - OpenAI 格式的工具定义数组
     * @returns 内部函数定义数组
     */
    private convertOpenAIToolsToFunctions(tools: OpenAITool[]): FunctionDefinition[] {
        return tools
            .filter(tool => tool?.type === 'function' && !!tool.function?.name)
            .map(tool => ({
                name: tool.function.name,
                description: tool.function.description,
                parameters: (tool.function.parameters as FunctionDefinition['parameters']) || { type: 'object', properties: {} }
            }));
    }

    /**
     * 为 VS Code LM 请求准备工具配置
     *
     * 综合处理 OpenAI 的 functions（旧版）和 tools（现代版）两种工具定义格式，
     * 合并去重后根据 tool_choice / function_call 语义决定最终的工具列表和调用模式。
     *
     * 处理流程：
     * 1. 检查 tool_choice / function_call 是否为 'none'，若是则返回空工具列表
     * 2. 合并 functions 和 tools 中的定义，以名称去重（tools 优先）
     * 3. 若指定了强制工具名（通过 tool_choice 对象或 function_call 对象），则只保留该工具
     * 4. 转换为 VS Code 工具格式，确定工具调用模式（Auto / Required）
     *
     * @param functions - OpenAI 旧版函数定义数组（可选）
     * @param tools - OpenAI 现代工具定义数组（可选）
     * @param toolChoice - OpenAI tool_choice 参数（none/auto/required/指定工具）
     * @param functionCall - OpenAI function_call 参数（none/auto/指定函数名）
     * @returns 包含 VS Code 工具数组和工具调用模式的配置对象
     * @throws 当强制指定的工具名在可用定义中找不到时抛出错误
     */
    public prepareToolsForRequest(
        functions: OpenAIFunction[] = [],
        tools: OpenAITool[] = [],
        toolChoice?: OpenAIToolChoice,
        functionCall?: OpenAIFunctionCallChoice
    ): { tools: vscode.LanguageModelChatTool[]; toolMode?: vscode.LanguageModelChatToolMode } {
        const disableTools = toolChoice !== undefined
            ? toolChoice === 'none'
            : functionCall === 'none';
        if (disableTools) {
            return { tools: [] };
        }

        const mergedDefinitions = new Map<string, FunctionDefinition>();

        for (const func of functions) {
            if (!func?.name) {
                continue;
            }
            mergedDefinitions.set(func.name, {
                name: func.name,
                description: func.description,
                parameters: (func.parameters as FunctionDefinition['parameters']) || { type: 'object', properties: {} }
            });
        }

        for (const func of this.convertOpenAIToolsToFunctions(tools)) {
            mergedDefinitions.set(func.name, func);
        }

        let finalDefinitions = Array.from(mergedDefinitions.values());
        const forcedToolName = this.resolveForcedToolName(toolChoice, functionCall);
        if (forcedToolName) {
            finalDefinitions = finalDefinitions.filter(tool => tool.name === forcedToolName);
            if (finalDefinitions.length === 0) {
                throw new Error(`Forced tool "${forcedToolName}" not found in available definitions`);
            }
        }

        const vsCodeTools = this.convertFunctionsToTools(finalDefinitions);
        if (vsCodeTools.length === 0) {
            return { tools: [] };
        }

        const toolMode = this.resolveToolMode(toolChoice, functionCall);
        return { tools: vsCodeTools, toolMode };
    }

    /**
     * 从 tool_choice 或 function_call 中解析强制指定的工具名
     *
     * 当 tool_choice 为对象形式 { type: 'function', function: { name } } 或
     * function_call 为对象形式 { name } 时，提取被强制指定的工具名称。
     *
     * @param toolChoice - OpenAI tool_choice 参数
     * @param functionCall - OpenAI function_call 参数
     * @returns 强制指定的工具名，若未指定则返回 undefined
     */
    private resolveForcedToolName(
        toolChoice?: OpenAIToolChoice,
        functionCall?: OpenAIFunctionCallChoice
    ): string | undefined {
        if (toolChoice && typeof toolChoice === 'object') {
            return toolChoice.function?.name;
        }
        if (functionCall && typeof functionCall === 'object') {
            return functionCall.name;
        }
        return undefined;
    }

    /**
     * 根据 tool_choice 和 function_call 语义解析 VS Code 工具调用模式
     *
     * 映射规则：
     * - tool_choice 为 'required' 或对象形式 --> Required 模式
     * - function_call 为对象形式（指定函数名） --> Required 模式
     * - 其他情况 --> Auto 模式（模型自行决定是否调用工具）
     *
     * @param toolChoice - OpenAI tool_choice 参数
     * @param functionCall - OpenAI function_call 参数
     * @returns VS Code 语言模型工具调用模式
     */
    private resolveToolMode(
        toolChoice?: OpenAIToolChoice,
        functionCall?: OpenAIFunctionCallChoice
    ): vscode.LanguageModelChatToolMode {
        if (toolChoice === 'required' || (toolChoice && typeof toolChoice === 'object')) {
            return vscode.LanguageModelChatToolMode.Required;
        }
        if (functionCall && typeof functionCall === 'object') {
            return vscode.LanguageModelChatToolMode.Required;
        }
        return vscode.LanguageModelChatToolMode.Auto;
    }
    
    /**
     * 执行工具调用
     *
     * 从注册表中查找工具，解析并验证 JSON 参数，执行工具处理器，
     * 并更新使用统计。包含完整的错误处理和 30 秒超时保护。
     *
     * 执行流程：
     * 1. 从注册表查找工具并检查启用状态
     * 2. 解析 JSON 格式的调用参数
     * 3. 根据工具的参数 Schema 验证必需字段
     * 4. 通过 Promise.race 执行工具处理器（带 30 秒超时）
     * 5. 更新使用计数和最后使用时间
     * 6. 触发 tool_executed 或 tool_error 事件
     *
     * @param toolCall - 工具调用对象（含函数名和 JSON 参数字符串）
     * @param context - 工具执行上下文
     * @returns 执行结果对象，包含 success 标志和 result 或 error
     */
    public async executeToolCall(
        toolCall: ToolCall, 
        context: ToolExecutionContext
    ): Promise<{ success: boolean; result?: any; error?: string }> {
        
        const startTime = Date.now();
        const toolName = toolCall.function.name;
        
        try {
            // 从注册表获取工具
            const registryEntry = this.toolRegistry.get(toolName);
            
            if (!registryEntry) {
                throw new Error(`工具 ${toolName} 未找到`);
            }
            
            if (!registryEntry.isEnabled) {
                throw new Error(`工具 ${toolName} 已禁用`);
            }
            
            // 解析参数
            let parameters: any;
            try {
                parameters = JSON.parse(toolCall.function.arguments);
            } catch (error) {
                throw new Error(`无效的 JSON 参数： ${error}`);
            }
            
            // 根据模式验证参数
            const validationResult = this.validateParameters(
                parameters, 
                registryEntry.tool.definition.parameters
            );
            
            if (!validationResult.isValid) {
                throw new Error(`参数验证失败： ${validationResult.error}`);
            }
            
            // 执行工具
            logger.info(`正在执行工具： ${toolName}`, { parameters, requestId: context.requestId });
            
            const result = await Promise.race([
                registryEntry.tool.handler(parameters, context),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('工具执行超时')), 30000)
                )
            ]);
            
            // 更新指标
            registryEntry.usageCount++;
            registryEntry.lastUsed = new Date();
            
            const executionTime = Date.now() - startTime;
            logger.info(`工具执行成功： ${toolName} (${executionTime}ms)`);
            
            this.eventEmitter.fire({
                type: 'tool_executed',
                data: { toolName, success: true, executionTime, requestId: context.requestId }
            });
            
            return { success: true, result };
            
        } catch (error) {
            // 更新错误指标
            const registryEntry = this.toolRegistry.get(toolName);
            if (registryEntry) {
                registryEntry.errorCount++;
            }
            
            const executionTime = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            logger.error(`工具执行失败： ${toolName} (${executionTime}ms)`, error as Error, {
                requestId: context.requestId
            });
            
            this.eventEmitter.fire({
                type: 'tool_error',
                data: { toolName, error: errorMessage, executionTime, requestId: context.requestId }
            });
            
            return { success: false, error: errorMessage };
        }
    }
    
    /**
     * 根据 JSON Schema 验证工具调用参数
     *
     * 当前实现为基础验证：仅检查 schema.required 中声明的必需字段是否存在。
     * 生产环境建议替换为完整的 JSON Schema 验证器（如 ajv）。
     *
     * @param parameters - 待验证的参数对象
     * @param schema - 参数的 JSON Schema 定义
     * @returns 验证结果，包含 isValid 标志和可选的错误信息
     */
    private validateParameters(parameters: any, schema: any): { isValid: boolean; error?: string } {
        try {
            // 基本验证 - 在生产中使用适当的 JSON 模式验证器
            if (schema.required) {
                for (const required of schema.required) {
                    if (!(required in parameters)) {
                        return { isValid: false, error: `缺少必需参数： ${required}` };
                    }
                }
            }
            
            return { isValid: true };
        } catch (error) {
            return { isValid: false, error: String(error) };
        }
    }
    
    
    /**
     * 获取指定模型可用的工具列表
     *
     * 检查模型是否支持工具调用，若支持则返回注册表中所有已启用工具的函数定义。
     *
     * @param modelCapabilities - 目标模型的能力描述
     * @returns 该模型可用的函数定义数组，若模型不支持工具则返回空数组
     */
    public getAvailableTools(modelCapabilities: ModelCapabilities): FunctionDefinition[] {
        const tools: FunctionDefinition[] = [];
        
        if (!modelCapabilities.supportsTools) {
            return tools;
        }
        
        for (const [id, entry] of this.toolRegistry) {
            if (entry.isEnabled) {
                tools.push(entry.tool.definition);
            }
        }
        
        return tools;
    }
    
    /**
     * 获取所有已注册工具的使用统计信息
     *
     * @returns 以工具 ID 为键的统计对象，包含调用次数、错误次数和最后使用时间
     */
    public getToolStats(): { [toolId: string]: { usageCount: number; errorCount: number; lastUsed?: Date } } {
        const stats: { [toolId: string]: { usageCount: number; errorCount: number; lastUsed?: Date } } = {};
        
        for (const [id, entry] of this.toolRegistry) {
            stats[id] = {
                usageCount: entry.usageCount,
                errorCount: entry.errorCount,
                lastUsed: entry.lastUsed
            };
        }
        
        return stats;
    }
    
    /**
     * 启用或禁用指定工具
     *
     * @param toolId - 工具的唯一标识符
     * @param enabled - true 为启用，false 为禁用
     * @returns 操作是否成功（工具是否存在于注册表中）
     */
    public setToolEnabled(toolId: string, enabled: boolean): boolean {
        const entry = this.toolRegistry.get(toolId);
        if (entry) {
            entry.isEnabled = enabled;
            logger.info(`工具 ${toolId} ${enabled ? '已启用' : '已禁用'}`);
            return true;
        }
        return false;
    }
    
    /**
     * 清理服务占用的资源
     *
     * 释放事件发射器并清空工具注册表。
     * 应在扩展停用（deactivate）或服务器关闭时调用。
     */
    public dispose(): void {
        this.eventEmitter.dispose();
        this.toolRegistry.clear();
    }
}
