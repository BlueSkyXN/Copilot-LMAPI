/**
 * 函数调用服务
 * 连接 OpenAI 函数调用和 VS Code 语言模型工具 API
 * 完全支持动态工具发现和执行！
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

// 增强型工具定义
export interface EnhancedTool {
    definition: FunctionDefinition;
    handler: (parameters: any, context: ToolExecutionContext) => Promise<any>;
    metadata: {
        category: string;
        description: string;
        version: string;
        author: string;
        requiresAuth?: boolean;
        rateLimited?: boolean;
    };
}

// 工具执行上下文
export interface ToolExecutionContext {
    requestId: string;
    modelId: string;
    userId?: string;
    sessionId?: string;
    environment: 'development' | 'production';
    permissions: string[];
}

// 工具注册表条目
export interface ToolRegistryEntry {
    id: string;
    tool: EnhancedTool;
    isEnabled: boolean;
    usageCount: number;
    lastUsed?: Date;
    errorCount: number;
}

export class FunctionCallService {
    private toolRegistry: Map<string, ToolRegistryEntry>;
    private eventEmitter: vscode.EventEmitter<{ type: string; data: any }>;

    constructor() {
        this.toolRegistry = new Map();
        this.eventEmitter = new vscode.EventEmitter();
    }
    
    /**
     * 注册新工具
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
     * 将 OpenAI 函数转换为 VS Code 工具格式
     */
    public convertFunctionsToTools(functions: FunctionDefinition[]): vscode.LanguageModelChatTool[] {
        return functions.map(func => ({
            name: func.name,
            description: func.description || '',
            inputSchema: func.parameters || { type: 'object', properties: {} }
        }));
    }

    /**
     * 将 OpenAI tool 定义转换为 FunctionDefinition
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
     * 为 VS Code LM 请求准备工具配置（含 tool_choice/function_call 语义）
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
     * 根据模式验证参数
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
     * 获取模型可用的工具
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
     * 获取工具使用统计信息
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
     * 启用/禁用工具
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
     * 清理资源
     */
    public dispose(): void {
        this.eventEmitter.dispose();
        this.toolRegistry.clear();
    }
}
