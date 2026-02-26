/**
 * Copilot HTTP API 服务器
 * 完全动态模型支持，多模态、函数调用
 */

import * as http from 'http';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { URL } from 'url';

import { logger } from '../utils/Logger';
import { Validator } from '../utils/Validator';
import { RequestHandler } from './RequestHandler';
import { ModelDiscoveryService } from '../services/ModelDiscoveryService';
import { SlidingWindowRateLimiter, TokenBucketRateLimiter, RateLimitResult } from '../utils/RateLimiter';
import { ServerConfig, ServerState } from '../types/VSCode';
import {
    DEFAULT_CONFIG,
    API_ENDPOINTS,
    HTTP_STATUS,
    getCORSHeaders,
    NOTIFICATIONS,
    LIMITS,
    RATE_LIMITS
} from '../constants/Config';

interface ActiveRequest {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    startTime: Date;
    cancellation: vscode.CancellationTokenSource;
}

export class CopilotServer {
    private server?: http.Server;
    private requestHandler: RequestHandler;
    private modelDiscovery: ModelDiscoveryService;
    private configChangeListener?: vscode.Disposable;
    private config: ServerConfig;
    private state: ServerState;
    private activeRequests: Map<string, ActiveRequest>;
    private isShuttingDown: boolean = false;
    private slidingWindowMinute: SlidingWindowRateLimiter;
    private slidingWindowHour: SlidingWindowRateLimiter;
    private tokenBucket: TokenBucketRateLimiter;
    private unauthorizedRequestLimiter: SlidingWindowRateLimiter;
    private bearerToken: string = '';

    constructor() {
        // 单一 ModelDiscoveryService 实例，通过 DI 传递给 RequestHandler
        this.modelDiscovery = new ModelDiscoveryService();
        this.requestHandler = new RequestHandler(this.modelDiscovery);
        this.config = this.loadConfig();
        this.state = {
            isRunning: false,
            requestCount: 0,
            errorCount: 0,
            activeConnections: 0
        };
        this.activeRequests = new Map();
        this.slidingWindowMinute = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_MINUTE, 60_000);
        this.slidingWindowHour   = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_HOUR, 3_600_000);
        this.tokenBucket         = new TokenBucketRateLimiter(RATE_LIMITS.BURST_SIZE, 1);
        this.unauthorizedRequestLimiter = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_MINUTE, 60_000);

        // 监听配置更改
        this.configChangeListener = vscode.workspace.onDidChangeConfiguration(
            this.onConfigurationChanged.bind(this)
        );
    }

    /**
     * 启动 HTTP 服务器
     */
    public async start(port?: number): Promise<void> {
        if (this.state.isRunning) {
            throw new Error('Server is already running');
        }

        const serverPort = port || this.config.port;
        const serverHost = this.config.host;

        // 验证配置
        Validator.validatePort(serverPort);
        Validator.validateHost(serverHost);

        // 显式初始化（不在构造函数中异步调用）
        await this.modelDiscovery.discoverAllModels();
        await this.requestHandler.initialize();

        // 生成 Bearer Token 用于认证
        this.bearerToken = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer(this.handleRequest.bind(this));

                // 配置服务器设置
                this.server.keepAliveTimeout = 65000;
                this.server.headersTimeout = 66000;
                this.server.maxRequestsPerSocket = 1000;
                this.server.requestTimeout = this.config.requestTimeout;

                // 设置事件处理器
                this.setupServerEventHandlers();

                this.server.listen(serverPort, serverHost, () => {
                    this.state.isRunning = true;
                    this.state.port = serverPort;
                    this.state.host = serverHost;
                    this.state.startTime = new Date();

                    logger.logServerEvent('Server started', {
                        host: serverHost,
                        port: serverPort,
                        timeout: this.config.requestTimeout
                    });

                    vscode.window.showInformationMessage(
                        `${NOTIFICATIONS.SERVER_STARTED} on http://${serverHost}:${serverPort} | Token: ${this.bearerToken}`
                    );

                    resolve();
                });

                this.server.on('error', (error: NodeJS.ErrnoException) => {
                    this.state.isRunning = false;

                    if (error.code === 'EADDRINUSE') {
                        const message = `${NOTIFICATIONS.PORT_IN_USE}: ${serverPort}`;
                        logger.error(message, error);
                        vscode.window.showErrorMessage(message);
                        reject(new Error(message));
                    } else {
                        logger.error('Server startup error', error);
                        vscode.window.showErrorMessage(`${NOTIFICATIONS.SERVER_ERROR}: ${error.message}`);
                        reject(error);
                    }
                });

            } catch (error) {
                logger.error('Failed to create server', error as Error);
                reject(error);
            }
        });
    }

    /**
     * 请求处理主入口
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        if (this.isShuttingDown) {
            this.sendError(res, HTTP_STATUS.SERVICE_UNAVAILABLE, 'Server is shutting down');
            return;
        }

        const requestId = this.generateRequestId();
        const startTime = new Date();
        const method = req.method || 'GET';

        // 所有响应（含 429/401）均添加 CORS 头
        this.addCORSHeaders(req, res);

        let url: URL;
        try {
            const hostHeader = req.headers.host || `${this.config.host}:${this.config.port}`;
            url = new URL(req.url || '/', `http://${hostHeader}`);
        } catch (error) {
            logger.warn('Invalid request URL or host header', {
                host: req.headers.host,
                url: req.url,
                error: String(error)
            }, requestId);
            this.sendError(res, HTTP_STATUS.BAD_REQUEST, 'Invalid request URL', requestId);
            return;
        }

        // 预检请求不受速率限制和认证约束
        if (method === 'OPTIONS') {
            this.handlePreflight(res);
            return;
        }

        // 健康检查端点不需要认证
        const isPublicEndpoint = url.pathname === API_ENDPOINTS.HEALTH;

        // Bearer Token 认证（非公开端点）
        if (!isPublicEndpoint && !this.validateAuth(req)) {
            const unauthorizedRateLimit = this.unauthorizedRequestLimiter.peek();
            if (!unauthorizedRateLimit.allowed) {
                if (unauthorizedRateLimit.retryAfterMs > 0) {
                    res.setHeader('Retry-After', String(Math.ceil(unauthorizedRateLimit.retryAfterMs / 1000)));
                }
                this.sendError(res, HTTP_STATUS.TOO_MANY_REQUESTS, 'Rate limit exceeded', requestId);
                return;
            }
            this.unauthorizedRequestLimiter.record();
            this.sendError(res, HTTP_STATUS.UNAUTHORIZED, 'Invalid or missing Bearer token', requestId);
            return;
        }

        // 先检查速率限制，通过后再入队（被拒绝的请求不计入任何限制计数）
        const rateLimitResult = this.checkRateLimit();
        if (!rateLimitResult.allowed) {
            if (rateLimitResult.retryAfterMs > 0) {
                res.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
            }
            this.sendError(res, HTTP_STATUS.TOO_MANY_REQUESTS, 'Rate limit exceeded', requestId);
            return;
        }

        // 通过检查后追踪活动请求（含 CancellationToken 用于超时取消）
        const cancellation = new vscode.CancellationTokenSource();
        this.activeRequests.set(requestId, { req, res, startTime, cancellation });
        this.state.activeConnections = this.activeRequests.size;

        // 设置超时：取消进行中的请求
        req.setTimeout(this.config.requestTimeout, () => {
            this.handleRequestTimeout(requestId, res);
        });

        try {
            this.state.requestCount++;
            logger.logRequest(method, url.pathname, requestId);
            await this.routeRequest(url.pathname, method, req, res, requestId, cancellation.token);

        } catch (error) {
            this.state.errorCount++;
            logger.error('Request handling error', error as Error, {}, requestId);

            if (!res.headersSent) {
                this.sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Internal server error', requestId);
            }
        } finally {
            // 清理请求追踪和 CancellationToken
            const active = this.activeRequests.get(requestId);
            if (active) {
                active.cancellation.dispose();
                this.activeRequests.delete(requestId);
            }
            this.state.activeConnections = this.activeRequests.size;

            const duration = Date.now() - startTime.getTime();
            logger.logResponse(res.statusCode || 500, requestId, duration);
        }
    }

    /**
     * 验证 Bearer Token 认证
     */
    private validateAuth(req: http.IncomingMessage): boolean {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return false;
        }
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return false;
        }

        const providedToken = Buffer.from(match[1], 'utf8');
        const expectedToken = Buffer.from(this.bearerToken, 'utf8');

        if (providedToken.length !== expectedToken.length) {
            return false;
        }

        return crypto.timingSafeEqual(providedToken, expectedToken);
    }

    /**
     * 路由请求到处理器
     */
    private async routeRequest(
        pathname: string,
        method: string,
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string,
        cancellationToken: vscode.CancellationToken
    ): Promise<void> {
        switch (pathname) {
            case API_ENDPOINTS.CHAT_COMPLETIONS:
                if (method === 'POST') {
                    await this.requestHandler.handleChatCompletions(req, res, requestId, cancellationToken);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            case API_ENDPOINTS.MODELS:
                if (method === 'GET') {
                    await this.requestHandler.handleModels(req, res, requestId);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            case API_ENDPOINTS.HEALTH:
                if (method === 'GET') {
                    await this.requestHandler.handleHealth(req, res, requestId, this.state);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            case API_ENDPOINTS.STATUS:
                if (method === 'GET') {
                    await this.requestHandler.handleStatus(req, res, requestId, this.state);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            case API_ENDPOINTS.MODELS_REFRESH:
                if (method === 'POST') {
                    await this.handleModelRefresh(req, res, requestId);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            case API_ENDPOINTS.CAPABILITIES:
                if (method === 'GET') {
                    await this.handleCapabilities(req, res, requestId);
                } else {
                    this.sendError(res, HTTP_STATUS.METHOD_NOT_ALLOWED, 'Method not allowed', requestId);
                }
                break;

            default:
                this.sendError(res, HTTP_STATUS.NOT_FOUND, 'Endpoint not found', requestId);
        }
    }

    /**
     * 处理模型刷新端点
     */
    private async handleModelRefresh(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        try {
            logger.info('Manual model refresh requested', {}, requestId);

            const models = await this.modelDiscovery.discoverAllModels();

            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'Models refreshed successfully',
                modelCount: models.length,
                timestamp: new Date().toISOString()
            }, null, 2));

        } catch (error) {
            this.sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Model refresh failed', requestId);
        }
    }

    /**
     * 处理能力端点
     */
    private async handleCapabilities(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        try {
            const modelPool = this.modelDiscovery.getModelPool();

            const capabilities = {
                server: {
                    version: '2.0.0',
                    features: {
                        dynamicModelDiscovery: true,
                        multimodalSupport: true,
                        functionCalling: true,
                        realTimeModelRefresh: true
                    }
                },
                models: {
                    total: modelPool.primary.length + modelPool.secondary.length + modelPool.fallback.length,
                    withVision: modelPool.primary.filter(m => m.supportsVision).length,
                    withTools: modelPool.primary.filter(m => m.supportsTools).length,
                    withMultimodal: modelPool.primary.filter(m => m.supportsMultimodal).length,
                    maxContextTokens: Math.max(...modelPool.primary.map(m => m.maxInputTokens), 0)
                },
                supportedFormats: {
                    images: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
                    imageInput: ['base64', 'url'],
                    functions: true,
                    tools: true,
                    streaming: true
                }
            };

            res.writeHead(HTTP_STATUS.OK, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(capabilities, null, 2));

        } catch (error) {
            this.sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Capabilities check failed', requestId);
        }
    }

    /**
     * 服务器事件处理器
     */
    private setupServerEventHandlers(): void {
        if (!this.server) {
            return;
        }

        this.server.on('connection', (socket) => {
            socket.setKeepAlive(true, 60000);
            socket.setNoDelay(true);

            socket.on('error', (error) => {
                logger.error('Socket error', error);
            });
        });

        this.server.on('clientError', (error, socket) => {
            logger.error('Client error', error);
            if (socket.writable) {
                socket.end(
                    'HTTP/1.1 400 Bad Request\r\n' +
                    'Content-Type: text/plain\r\n' +
                    '\r\n' +
                    'Bad Request'
                );
            }
        });
    }

    /**
     * 四层速率限制检查
     * 使用 peek/record 分离模式：先检查所有层，全部通过后统一记录
     */
    private checkRateLimit(): RateLimitResult {
        // 层1：并发限制
        if (this.activeRequests.size >= this.config.maxConcurrentRequests) {
            return { allowed: false, retryAfterMs: 0 };
        }

        // 层2：滑动窗口（分钟级）
        const minuteResult = this.slidingWindowMinute.peek();
        if (!minuteResult.allowed) {
            return minuteResult;
        }

        // 层3：滑动窗口（小时级）
        const hourResult = this.slidingWindowHour.peek();
        if (!hourResult.allowed) {
            return hourResult;
        }

        // 层4：令牌桶突发控制
        const burstResult = this.tokenBucket.peek();
        if (!burstResult.allowed) {
            return burstResult;
        }

        // 全部通过，统一记录（Node.js 单线程，无并发问题）
        this.slidingWindowMinute.record();
        this.slidingWindowHour.record();
        this.tokenBucket.consume();

        return { allowed: true, retryAfterMs: 0 };
    }

    /**
     * 动态 CORS 头：仅允许 localhost 来源
     */
    private addCORSHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
        const origin = req.headers.origin;
        const corsHeaders = getCORSHeaders(origin);
        for (const [key, value] of Object.entries(corsHeaders)) {
            res.setHeader(key, value);
        }
        res.setHeader('X-API-Version', '2.0.0');
    }

    /**
     * 处理预检 OPTIONS 请求
     */
    private handlePreflight(res: http.ServerResponse): void {
        res.writeHead(HTTP_STATUS.OK);
        res.end();
    }

    /**
     * 处理请求超时：取消进行中的请求
     */
    private handleRequestTimeout(requestId: string, res: http.ServerResponse): void {
        logger.warn('Request timeout', {}, requestId);

        // 取消进行中的请求（通过 CancellationToken）
        const active = this.activeRequests.get(requestId);
        if (active && !active.cancellation.token.isCancellationRequested) {
            active.cancellation.cancel();
        }

        if (!res.headersSent) {
            this.sendError(res, HTTP_STATUS.REQUEST_TIMEOUT, 'Request timeout', requestId);
        }
    }

    /**
     * 发送错误响应
     */
    private sendError(res: http.ServerResponse, statusCode: number, message: string, requestId?: string): void {
        if (res.headersSent) {
            return;
        }

        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message,
                type: 'server_error',
                code: statusCode,
                timestamp: new Date().toISOString(),
                requestId
            }
        }, null, 2));

        if (requestId) {
            logger.error(`Error response: ${statusCode}`, new Error(message), {}, requestId);
        }
    }

    /**
     * 生成唯一请求 ID
     */
    private generateRequestId(): string {
        return `req_${crypto.randomUUID()}`;
    }

    /**
     * 停止服务器
     */
    public async stop(): Promise<void> {
        if (!this.state.isRunning || !this.server) {
            return;
        }

        this.isShuttingDown = true;

        return new Promise((resolve) => {
            let resolved = false;
            let forceCloseTimer: NodeJS.Timeout | undefined;

            const finalize = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                if (forceCloseTimer) {
                    clearTimeout(forceCloseTimer);
                    forceCloseTimer = undefined;
                }
                this.state.isRunning = false;
                this.state.port = undefined;
                this.state.host = undefined;
                this.state.startTime = undefined;
                this.isShuttingDown = false;

                logger.logServerEvent('Server stopped');
                vscode.window.showInformationMessage(NOTIFICATIONS.SERVER_STOPPED);

                resolve();
            };

            // 关闭所有活动请求
            this.closeActiveRequests();

            // 超时后强制关闭
            forceCloseTimer = setTimeout(() => {
                this.server?.closeAllConnections?.();
                finalize();
            }, 5000);

            this.server!.close(() => {
                finalize();
            });
        });
    }

    /**
     * 重启服务器
     */
    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * 获取当前服务器状态
     */
    public getState(): ServerState {
        return { ...this.state };
    }

    /**
     * 获取服务器配置
     */
    public getConfig(): ServerConfig {
        return { ...this.config };
    }

    /**
     * 关闭所有活动请求
     */
    private closeActiveRequests(): void {
        for (const [requestId, { res, cancellation }] of this.activeRequests.entries()) {
            try {
                cancellation.cancel();
                cancellation.dispose();
                if (!res.headersSent) {
                    this.sendError(res, HTTP_STATUS.SERVICE_UNAVAILABLE, 'Server shutting down', requestId);
                }
            } catch (error) {
                logger.error('Error closing request', error as Error, {}, requestId);
            }
        }
        this.activeRequests.clear();
    }

    /**
     * 加载配置
     */
    private loadConfig(): ServerConfig {
        const config = vscode.workspace.getConfiguration('copilot-lmapi');

        return {
            port: config.get<number>('port', DEFAULT_CONFIG.port),
            host: config.get<string>('host', DEFAULT_CONFIG.host),
            autoStart: config.get<boolean>('autoStart', DEFAULT_CONFIG.autoStart),
            enableLogging: config.get<boolean>('enableLogging', DEFAULT_CONFIG.enableLogging),
            maxConcurrentRequests: Math.min(
                config.get<number>('maxConcurrentRequests', DEFAULT_CONFIG.maxConcurrentRequests),
                LIMITS.MAX_CONCURRENT_REQUESTS
            ),
            requestTimeout: Math.min(
                config.get<number>('requestTimeout', DEFAULT_CONFIG.requestTimeout),
                LIMITS.MAX_TIMEOUT
            )
        };
    }

    /**
     * 处理配置更改
     */
    private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
        if (event.affectsConfiguration('copilot-lmapi')) {
            const newConfig = this.loadConfig();
            const oldConfig = this.config;

            this.config = newConfig;

            logger.logServerEvent('Configuration changed', {
                old: oldConfig,
                new: newConfig
            });

            // 如果关键设置更改则提示重启
            if (this.state.isRunning &&
                (oldConfig.port !== newConfig.port || oldConfig.host !== newConfig.host)) {

                vscode.window.showInformationMessage(
                    'Server configuration changed. Restart required.',
                    'Restart Now'
                ).then(selection => {
                    if (selection === 'Restart Now') {
                        this.restart().catch(error => {
                            logger.error('Failed to restart server after config change', error);
                        });
                    }
                });
            }
        }
    }

    /**
     * 释放资源
     */
    public dispose(): void {
        this.configChangeListener?.dispose();
        this.configChangeListener = undefined;

        this.stop().catch(error => {
            logger.error('Error during server disposal', error);
        });

        this.requestHandler.dispose();
        this.modelDiscovery.dispose();
    }
}
