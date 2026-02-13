/**
 * 🛠️ 革命性函数调用服务
 * ✨ 连接 OpenAI 函数调用和 VS Code 语言模型工具 API
 * 🚀 完全支持动态工具发现和执行！
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
import * as fs from 'fs';
import * as path from 'path';

// 🛠️ 增强型工具定义
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

// 🎯 工具执行上下文
export interface ToolExecutionContext {
    requestId: string;
    modelId: string;
    userId?: string;
    sessionId?: string;
    environment: 'development' | 'production';
    permissions: string[];
}

// 📋 工具注册表条目
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
    private builtInTools: Map<string, EnhancedTool>;
    
    constructor() {
        this.toolRegistry = new Map();
        this.eventEmitter = new vscode.EventEmitter();
        this.builtInTools = new Map();
        
        this.initializeBuiltInTools();
    }
    
    /**
     * 🚀 初始化内置工具
     */
    private initializeBuiltInTools(): void {
        // 📊 计算器工具
        this.registerTool('calculator', {
            definition: {
                name: 'calculator',
                description: '执行数学计算',
                parameters: {
                    type: 'object',
                    properties: {
                        expression: {
                            type: 'string',
                            description: '要评估的数学表达式'
                        }
                    },
                    required: ['expression']
                }
            },
            handler: this.calculatorHandler.bind(this),
            metadata: {
                category: 'math',
                description: '用于数学运算的内置计算器',
                version: '1.0.0',
                author: 'copilot-lmapi'
            }
        });
        
        // 📅 日期/时间工具
        this.registerTool('datetime', {
            definition: {
                name: 'datetime',
                description: '获取当前日期和时间信息',
                parameters: {
                    type: 'object',
                    properties: {
                        format: {
                            type: 'string',
                            description: '日期格式 (iso, locale, timestamp)',
                            enum: ['iso', 'locale', 'timestamp']
                        },
                        timezone: {
                            type: 'string',
                            description: '时区（可选）'
                        }
                    },
                    required: []
                }
            },
            handler: this.datetimeHandler.bind(this),
            metadata: {
                category: 'utility',
                description: '以各种格式获取当前日期和时间',
                version: '1.0.0',
                author: 'copilot-lmapi'
            }
        });
        
        // 📁 文件系统工具（只读）
        this.registerTool('file_info', {
            definition: {
                name: 'file_info',
                description: '获取文件和目录信息（只读）',
                parameters: {
                    type: 'object',
                    properties: {
                        path: {
                            type: 'string',
                            description: '文件或目录路径'
                        },
                        operation: {
                            type: 'string',
                            description: '操作类型',
                            enum: ['stat', 'list', 'exists']
                        }
                    },
                    required: ['path', 'operation']
                }
            },
            handler: this.fileInfoHandler.bind(this),
            metadata: {
                category: 'filesystem',
                description: '只读文件系统操作',
                version: '1.0.0',
                author: 'copilot-lmapi'
            }
        });
        
        logger.info(`🛠️ 初始化了 ${this.builtInTools.size} 个内置工具`);
    }
    
    /**
     * 📝 注册新工具
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
        this.builtInTools.set(id, tool);
        
        logger.info(`✅ 已注册工具： ${id}`);
        
        this.eventEmitter.fire({
            type: 'tool_registered',
            data: { id, tool: tool.definition }
        });
    }
    
    /**
     * 🚀 将 OpenAI 函数转换为 VS Code 工具格式
     */
    public convertFunctionsToTools(functions: FunctionDefinition[]): vscode.LanguageModelChatTool[] {
        return functions.map(func => ({
            name: func.name,
            description: func.description || '',
            inputSchema: func.parameters || { type: 'object', properties: {} }
        }));
    }

    /**
     * 🔄 将 OpenAI tool 定义转换为 FunctionDefinition
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
     * 🔧 为 VS Code LM 请求准备工具配置（含 tool_choice/function_call 语义）
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
     * 🎯 执行工具调用
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
            logger.info(`🛠️ 正在执行工具： ${toolName}`, { parameters, requestId: context.requestId });
            
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
            logger.info(`✅ 工具执行成功： ${toolName} (${executionTime}ms)`);
            
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
            
            logger.error(`❌ 工具执行失败： ${toolName} (${executionTime}ms)`, error as Error, {
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
     * 📋 根据模式验证参数
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
     * 📊 计算器工具处理程序
     */
    private async calculatorHandler(parameters: any, context: ToolExecutionContext): Promise<any> {
        const { expression } = parameters;
        
        // 安全表达式评估（仅基本操作）
        const safeExpression = expression.replace(/[^0-9+\-*/().\s]/g, '');
        
        // 进一步验证表达式
        if (!safeExpression || !/^[\d+\-*/().\s]+$/.test(safeExpression)) {
            throw new Error('无效的数学表达式');
        }
        
        try {
            // 使用更安全的 eval 替代方案（限制了输入）
            const result = this.safeEval(safeExpression);
            
            if (typeof result !== 'number' || !isFinite(result)) {
                throw new Error('无效的计算结果');
            }
            
            return {
                expression: safeExpression,
                result: result,
                type: 'calculation'
            };
        } catch (error) {
            throw new Error(`计算错误： ${error}`);
        }
    }
    
    /**
     * 📅 日期/时间工具处理程序
     */
    private async datetimeHandler(parameters: any, context: ToolExecutionContext): Promise<any> {
        const { format = 'iso', timezone } = parameters;
        const now = new Date();
        
        let result: string;
        
        switch (format) {
            case 'iso':
                result = now.toISOString();
                break;
            case 'locale':
                result = now.toLocaleString();
                break;
            case 'timestamp':
                result = now.getTime().toString();
                break;
            default:
                result = now.toISOString();
        }
        
        return {
            datetime: result,
            format: format,
            timezone: timezone || 'local',
            timestamp: now.getTime()
        };
    }
    
    /**
     * 📁 文件信息工具处理程序
     */
    private async fileInfoHandler(parameters: any, context: ToolExecutionContext): Promise<any> {
        const { path: filePath, operation } = parameters;
        
        // 🔒 安全检查：防止路径遍历攻击
        if (!filePath || typeof filePath !== 'string') {
            throw new Error('无效的路径参数');
        }
        
        // 严格的路径安全检查
        const normalizedPath = this.validateAndNormalizePath(filePath);
        
        // 限制只能访问工作目录及其子目录（可配置）
        const workspaceRoot = process.cwd();
        if (!normalizedPath.startsWith(workspaceRoot)) {
            throw new Error('只允许访问工作目录内的文件');
        }
        
        try {
            switch (operation) {
                case 'exists':
                    try {
                        await fs.promises.access(normalizedPath);
                        return { exists: true, path: normalizedPath };
                    } catch {
                        return { exists: false, path: normalizedPath };
                    }
                
                case 'stat':
                    const stat = await fs.promises.stat(normalizedPath);
                    return {
                        path: normalizedPath,
                        size: stat.size,
                        isFile: stat.isFile(),
                        isDirectory: stat.isDirectory(),
                        created: stat.birthtime.toISOString(),
                        modified: stat.mtime.toISOString()
                    };
                
                case 'list':
                    const entries = await fs.promises.readdir(normalizedPath);
                    return {
                        path: normalizedPath,
                        entries: entries.slice(0, 100), // 限制结果
                        total: entries.length
                    };
                
                default:
                    throw new Error(`未知操作： ${operation}`);
            }
        } catch (error) {
            throw new Error(`文件操作失败： ${error}`);
        }
    }
    
    /**
     * 📋 获取模型可用的工具
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
     * 📋 获取工具使用统计信息
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
     * 🔄 启用/禁用工具
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
     * 🔒 安全的数学表达式求值器（替代 eval）
     */
    private safeEval(expression: string): number {
        // 简单的数学解析器，避免使用 eval
        try {
            // 移除所有空格
            const cleanExpr = expression.replace(/\s/g, '');
            
            // 基本的括号匹配验证
            let bracketCount = 0;
            for (const char of cleanExpr) {
                if (char === '(') {
                    bracketCount++;
                }
                if (char === ')') {
                    bracketCount--;
                }
                if (bracketCount < 0) {
                    throw new Error('括号不匹配');
                }
            }
            if (bracketCount !== 0) {
                throw new Error('括号不匹配');
            }
            
            // 使用简单的表达式解析器（完全避免 eval）
            const result = this.parseExpression(cleanExpr);
            return Number(result);
        } catch (error) {
            throw new Error('数学表达式计算失败：' + String(error));
        }
    }

    /**
     * 🔒 严格的路径验证和规范化
     */
    private validateAndNormalizePath(filePath: string): string {
        // 1. 基本格式检查
        if (filePath.length > 1000) {
            throw new Error('路径过长');
        }
        
        // 2. 检查危险字符和模式
        const dangerousPatterns = [
            /\.\./,              // 父目录遍历
            /~/,                 // home目录引用
            /\0/,                // null字节注入
            /%2e/i,              // URL编码的 . (任何形式)
            /%2f/i,              // URL编码的 /
            /%5c/i,              // URL编码的 \
            /\\/,                // Windows路径分隔符
            /^\/[^\/]/,          // 绝对路径
            /^[a-zA-Z]:/,        // Windows驱动器路径
            /%[0-9a-f]{2}/i,     // 任何URL编码都不允许
        ];
        
        for (const pattern of dangerousPatterns) {
            if (pattern.test(filePath)) {
                throw new Error(`路径包含危险字符或模式: ${filePath}`);
            }
        }
        
        // 3. 只允许相对路径且在当前目录下
        if (path.isAbsolute(filePath)) {
            throw new Error('不允许绝对路径');
        }
        
        // 4. 规范化路径
        const normalizedPath = path.resolve(filePath);
        
        // 5. 验证规范化后的路径
        const workspaceRoot = process.cwd();
        if (!normalizedPath.startsWith(workspaceRoot)) {
            throw new Error('路径超出允许范围');
        }
        
        // 6. 额外安全检查：确保没有符号链接攻击
        const relativePath = path.relative(workspaceRoot, normalizedPath);
        if (relativePath.startsWith('..')) {
            throw new Error('规范化后的路径无效');
        }
        
        return normalizedPath;
    }

    /**
     * 🧮 安全的数学表达式解析器（无eval）
     */
    private parseExpression(expr: string): number {
        // 简单的递归下降解析器，支持 +, -, *, /, () 和数字
        let index = 0;
        
        const parseNumber = (): number => {
            let num = '';
            while (index < expr.length && /[\d.]/.test(expr[index])) {
                num += expr[index++];
            }
            const result = parseFloat(num);
            if (isNaN(result)) {
                throw new Error('无效数字');
            }
            return result;
        };
        
        const parseFactor = (): number => {
            if (expr[index] === '(') {
                index++; // skip '('
                const result = parseAddSub();
                if (expr[index] !== ')') {
                    throw new Error('缺少右括号');
                }
                index++; // skip ')'
                return result;
            }
            if (expr[index] === '-') {
                index++; // skip '-'
                return -parseFactor();
            }
            if (expr[index] === '+') {
                index++; // skip '+'
                return parseFactor();
            }
            return parseNumber();
        };
        
        const parseMulDiv = (): number => {
            let result = parseFactor();
            while (index < expr.length && /[*/]/.test(expr[index])) {
                const op = expr[index++];
                const right = parseFactor();
                if (op === '*') {
                    result *= right;
                } else if (op === '/') {
                    if (right === 0) {
                        throw new Error('除零错误');
                    }
                    result /= right;
                }
            }
            return result;
        };
        
        const parseAddSub = (): number => {
            let result = parseMulDiv();
            while (index < expr.length && /[+-]/.test(expr[index])) {
                const op = expr[index++];
                const right = parseMulDiv();
                if (op === '+') {
                    result += right;
                } else {
                    result -= right;
                }
            }
            return result;
        };
        
        const result = parseAddSub();
        if (index < expr.length) {
            throw new Error('表达式末尾有多余字符');
        }
        return result;
    }

    /**
     * 🧹 清理资源
     */
    public dispose(): void {
        this.eventEmitter.dispose();
        this.toolRegistry.clear();
        this.builtInTools.clear();
    }
}
