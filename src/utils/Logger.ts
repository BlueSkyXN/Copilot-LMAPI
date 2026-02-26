/**
 * @module Logger
 * @description 集中式日志工具模块
 *
 * 职责：
 * - 提供分级日志记录能力（DEBUG / INFO / WARN / ERROR）
 * - 通过请求 ID 实现跨模块的请求链路追踪
 * - 管理 VS Code 输出频道（Output Channel）的生命周期
 * - 在内存中维护有限容量的日志条目，超过 120% 阈值时自动裁剪
 * - 提供 createRequestLogger 工厂方法，生成绑定特定请求 ID 的日志记录器
 * - 错误弹窗策略：仅全局/致命错误（无 requestId）弹出 VS Code 错误通知，
 *   请求级错误仅写入输出面板，避免干扰用户
 *
 * 架构位置：
 *   位于 src/utils/ 工具层，被 CopilotServer、RequestHandler 等上层模块依赖。
 *   通过单例 `logger` 导出，确保全局共享同一输出频道和日志存储。
 *
 * 关键依赖：
 * - vscode.OutputChannel —— 日志输出到 VS Code "输出"面板
 * - LogEntry (types/VSCode) —— 日志条目数据结构
 * - LOG_LEVELS, CONFIG_SECTION (constants/Config) —— 日志级别常量与配置节名称
 *
 * 设计要点：
 * - 日志是否启用通过 VS Code 用户配置 `copilot-lmapi.enableLogging` 控制
 * - ERROR 级别日志无论开关状态始终记录
 * - 内存裁剪使用 120% 阈值批量裁剪，减少频繁的数组切片操作
 *
 * ═══════════════════════════════════════════════════════
 * 函数/类清单
 * ═══════════════════════════════════════════════════════
 *
 * 【RequestLogger（接口）】
 *   - 功能说明：请求范围日志记录器，提供 debug / info / warn / error 方法
 *
 * 【Logger（类）】
 *   - 功能说明：集中式日志记录器
 *   - 关键属性：outputChannel, isLoggingEnabled, logEntries, maxLogEntries=1000
 *
 *   1. constructor()
 *      - 功能：创建输出频道并读取配置
 *
 *   2. updateLoggingState(): void
 *      - 功能：读取日志启用配置
 *
 *   3. formatMessage(level: string, message: string, context?: string, requestId?: string): string
 *      - 功能：格式化日志
 *      - 输入：level — 日志级别, message — 日志内容, context — 上下文, requestId — 请求 ID
 *      - 输出：格式化后的日志字符串
 *
 *   4. log(level: string, message: string, context?: string, requestId?: string): void
 *      - 功能：核心日志记录
 *
 *   5. debug(message: string, context?: string, requestId?: string): void
 *      - 功能：DEBUG 日志
 *
 *   6. info(message: string, context?: string, requestId?: string): void
 *      - 功能：INFO 日志
 *
 *   7. warn(message: string, context?: string, requestId?: string): void
 *      - 功能：WARN 日志
 *
 *   8. error(message: string, error?: Error, context?: string, requestId?: string): void
 *      - 功能：ERROR 日志
 *
 *   9. logRequest(method: string, url: string, requestId: string, body?: any): void
 *      - 功能：记录入站请求
 *
 *  10. logResponse(statusCode: number, requestId: string, duration: number, error?: string): void
 *      - 功能：记录出站响应
 *
 *  11. logServerEvent(event: string, details?: string): void
 *      - 功能：记录服务器事件
 *
 *  12. getRecentLogs(count?: number): LogEntry[]
 *      - 功能：获取最近日志
 *      - 输出：LogEntry[]
 *
 *  13. clearLogs(): void
 *      - 功能：清空日志
 *
 *  14. show(): void
 *      - 功能：显示输出频道
 *
 *  15. dispose(): void
 *      - 功能：释放资源
 *
 *  16. createRequestLogger(requestId: string): RequestLogger
 *      - 功能：创建绑定请求 ID 的日志器
 *      - 输入：requestId — 请求 ID
 *      - 输出：RequestLogger 实例
 *
 * 【logger（const）】
 *   - 功能说明：全局单例日志记录器
 */

import * as vscode from 'vscode';
import { LogEntry } from '../types/VSCode';
import { LOG_LEVELS, CONFIG_SECTION } from '../constants/Config';

/**
 * 请求范围日志记录器接口
 *
 * 由 Logger.createRequestLogger() 生成，自动在每条日志中附加对应的 requestId，
 * 使调用方无需每次手动传入 requestId。
 */
export interface RequestLogger {
    /** 记录调试级别日志 */
    debug: (message: string, context?: Record<string, any>) => void;
    /** 记录信息级别日志 */
    info: (message: string, context?: Record<string, any>) => void;
    /** 记录警告级别日志 */
    warn: (message: string, context?: Record<string, any>) => void;
    /** 记录错误级别日志，可附带 Error 对象 */
    error: (message: string, error?: Error, context?: Record<string, any>) => void;
}

/**
 * 集中式日志记录器
 *
 * 提供分级日志输出、请求追踪、内存日志存储等功能。
 * 以单例模式导出（见文件末尾 `logger`），确保全局共享同一实例。
 */
export class Logger {
    /** VS Code 输出频道实例，用于向"输出"面板写入日志 */
    private outputChannel: vscode.OutputChannel;
    /** 日志记录开关，受用户配置控制 */
    private isLoggingEnabled: boolean = true;
    /** 内存中的日志条目数组 */
    private logEntries: LogEntry[] = [];
    /** 内存日志最大保留条数 */
    private maxLogEntries: number = 1000;

    /**
     * 构造函数
     * 创建 VS Code 输出频道并读取当前日志开关配置。
     */
    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Copilot-LMAPI');
        this.updateLoggingState();
    }

    /**
     * 从 VS Code 用户配置中读取日志启用状态
     * 对应配置项：copilot-lmapi.enableLogging
     */
    private updateLoggingState(): void {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        this.isLoggingEnabled = config.get<boolean>('enableLogging', true);
    }

    /**
     * 将日志元数据格式化为统一的字符串表示
     *
     * 格式: [ISO时间戳] [级别] | Request: requestId 消息内容 | Context: {...}
     *
     * @param level - 日志级别字符串
     * @param message - 日志正文
     * @param context - 可选的结构化上下文信息
     * @param requestId - 可选的请求追踪 ID
     * @returns 格式化后的日志字符串
     */
    private formatMessage(level: string, message: string, context?: Record<string, any>, requestId?: string): string {
        const timestamp = new Date().toISOString();
        const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
        const requestIdStr = requestId ? ` | Request: ${requestId}` : '';
        
        return `[${timestamp}] [${level.toUpperCase()}]${requestIdStr} ${message}${contextStr}`;
    }

    /**
     * 核心日志记录方法
     *
     * 执行流程：
     * 1. 检查日志开关（ERROR 级别始终记录，不受开关影响）
     * 2. 构建 LogEntry 并追加到内存存储
     * 3. 当内存条目超过 maxLogEntries 的 120% 时批量裁剪，保留最新 maxLogEntries 条
     * 4. 格式化后写入 VS Code 输出频道
     * 5. 仅对全局错误（无 requestId）弹出错误通知
     * 6. 开发环境额外输出到控制台
     *
     * @param level - 日志级别，取值为 LOG_LEVELS 的键
     * @param message - 日志正文
     * @param context - 可选的结构化上下文信息
     * @param requestId - 可选的请求追踪 ID
     */
    private log(level: keyof typeof LOG_LEVELS, message: string, context?: Record<string, any>, requestId?: string): void {
        if (!this.isLoggingEnabled && level !== 'ERROR') {
            return;
        }

        const logEntry: LogEntry = {
            level,
            message,
            timestamp: new Date(),
            context,
            requestId
        };

        // 添加到内存存储（超过 120% 阈值时裁剪，减少频繁分配）
        this.logEntries.push(logEntry);
        const trimThreshold = Math.ceil(this.maxLogEntries * 1.2);
        if (this.logEntries.length > trimThreshold) {
            this.logEntries = this.logEntries.slice(-this.maxLogEntries);
        }

        // 格式化和输出
        const formattedMessage = this.formatMessage(level, message, context, requestId);
        
        // 总是在输出频道中显示
        this.outputChannel.appendLine(formattedMessage);

        // 仅在全局/致命错误（无 requestId）时弹窗；请求级错误仅写入输出面板
        if (level === 'ERROR' && !requestId) {
            vscode.window.showErrorMessage(`Copilot-LMAPI: ${message}`);
        }

        // 开发时的控制台输出
        if (process.env.NODE_ENV === 'development') {
            console.log(formattedMessage);
        }
    }

    /**
     * 记录 DEBUG 级别日志
     * @param message - 日志正文
     * @param context - 可选的结构化上下文
     * @param requestId - 可选的请求追踪 ID
     */
    public debug(message: string, context?: Record<string, any>, requestId?: string): void {
        this.log('DEBUG', message, context, requestId);
    }

    /**
     * 记录 INFO 级别日志
     * @param message - 日志正文
     * @param context - 可选的结构化上下文
     * @param requestId - 可选的请求追踪 ID
     */
    public info(message: string, context?: Record<string, any>, requestId?: string): void {
        this.log('INFO', message, context, requestId);
    }

    /**
     * 记录 WARN 级别日志
     * @param message - 日志正文
     * @param context - 可选的结构化上下文
     * @param requestId - 可选的请求追踪 ID
     */
    public warn(message: string, context?: Record<string, any>, requestId?: string): void {
        this.log('WARN', message, context, requestId);
    }

    /**
     * 记录 ERROR 级别日志
     *
     * 自动将 Error 对象的 name、message、stack 提取到上下文中，
     * 便于在输出面板中查看完整的错误信息。
     *
     * @param message - 日志正文
     * @param error - 可选的 Error 对象
     * @param context - 可选的额外结构化上下文
     * @param requestId - 可选的请求追踪 ID
     */
    public error(message: string, error?: Error, context?: Record<string, any>, requestId?: string): void {
        const errorContext = {
            ...context,
            error: error ? {
                name: error.name,
                message: error.message,
                stack: error.stack
            } : undefined
        };
        this.log('ERROR', message, errorContext, requestId);
    }

    /**
     * 记录入站 HTTP 请求
     *
     * 将请求体截断为前 500 字符以防日志过大。
     *
     * @param method - HTTP 方法（GET / POST 等）
     * @param url - 请求 URL 路径
     * @param requestId - 请求追踪 ID
     * @param body - 可选的请求体对象
     */
    public logRequest(method: string, url: string, requestId: string, body?: any): void {
        this.info(`Incoming request: ${method} ${url}`, { 
            body: body ? JSON.stringify(body).substring(0, 500) : undefined 
        }, requestId);
    }

    /**
     * 记录出站 HTTP 响应
     *
     * 根据状态码自动选择日志级别：>=400 记为 ERROR，否则记为 INFO。
     *
     * @param statusCode - HTTP 响应状态码
     * @param requestId - 请求追踪 ID
     * @param duration - 请求耗时（毫秒）
     * @param error - 可选的错误描述
     */
    public logResponse(statusCode: number, requestId: string, duration: number, error?: string): void {
        const level = statusCode >= 400 ? 'ERROR' : 'INFO';
        const message = `Response: ${statusCode} (${duration}ms)`;
        this.log(level, message, { 
            statusCode, 
            duration, 
            error 
        }, requestId);
    }

    /**
     * 记录服务器生命周期事件
     * @param event - 事件名称（如 "started"、"stopped" 等）
     * @param details - 可选的事件详情
     */
    public logServerEvent(event: string, details?: Record<string, any>): void {
        this.info(`Server event: ${event}`, details);
    }

    /**
     * 获取最近的日志条目
     * @param count - 返回的最大条目数，默认 100
     * @returns 最近的 LogEntry 数组
     */
    public getRecentLogs(count: number = 100): LogEntry[] {
        return this.logEntries.slice(-count);
    }

    /**
     * 清空所有内存日志和输出频道内容
     */
    public clearLogs(): void {
        this.logEntries = [];
        this.outputChannel.clear();
        this.info('Log history cleared');
    }

    /**
     * 显示（聚焦）VS Code 输出频道面板
     */
    public show(): void {
        this.outputChannel.show();
    }

    /**
     * 释放输出频道资源
     * 应在扩展停用（deactivate）时调用。
     */
    public dispose(): void {
        this.outputChannel.dispose();
    }

    /**
     * 创建绑定特定请求 ID 的日志记录器
     *
     * 返回的 RequestLogger 对象在调用 debug/info/warn/error 时，
     * 自动附加 requestId，简化请求处理链路中的日志调用。
     *
     * @param requestId - 要绑定的请求追踪 ID
     * @returns 绑定了 requestId 的 RequestLogger 实例
     */
    public createRequestLogger(requestId: string): RequestLogger {
        return {
            debug: (message: string, context?: Record<string, any>) => 
                this.debug(message, context, requestId),
            info: (message: string, context?: Record<string, any>) => 
                this.info(message, context, requestId),
            warn: (message: string, context?: Record<string, any>) => 
                this.warn(message, context, requestId),
            error: (message: string, error?: Error, context?: Record<string, any>) => 
                this.error(message, error, context, requestId),
        };
    }
}

/** 全局单例日志记录器实例，供所有模块共享使用 */
export const logger = new Logger();