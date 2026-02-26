/**
 * @module CopilotServer
 * @description Copilot LMAPI 核心 HTTP 服务器模块
 *
 * 本模块是整个扩展的网络服务核心，负责将 GitHub Copilot 的 Language Model API
 * 桥接为 OpenAI 兼容的 HTTP 接口，使标准 OpenAI 客户端库能够通过本地 HTTP 服务器
 * 访问 Copilot 模型。
 *
 * 在架构中的位置:
 *   Client (OpenAI SDK) -> HTTP :8001 -> CopilotServer -> RequestHandler -> vscode.lm API -> Response
 *
 * CopilotServer 作为请求的第一个接收者，负责网络层的所有横切关注点（速率限制、认证、
 * CORS、超时），然后将业务逻辑委托给 RequestHandler 处理。
 *
 * 主要职责:
 *   - HTTP 服务器生命周期管理（启动/停止/重启）
 *   - 请求路由（将 URL 路径映射到对应的处理器方法）
 *   - 三层速率限制（滑动窗口分钟/小时级 + 令牌桶突发控制）
 *   - Bearer Token 认证（使用 timingSafeEqual 防止时序攻击）
 *   - CORS 头部管理（仅允许 localhost 来源）
 *   - 请求超时处理（通过 CancellationToken 取消进行中的 LM 请求）
 *   - 活动请求追踪与优雅关闭
 *   - VS Code 配置变更监听与热重载
 *
 * 关键依赖:
 *   - RequestHandler: 业务逻辑处理（聊天补全、模型列表等端点的具体实现）
 *   - ModelDiscoveryService: 动态模型发现（通过 vscode.lm.selectChatModels() 发现可用模型）
 *   - RateLimiter: 速率限制实现（滑动窗口 + 令牌桶算法）
 *   - Validator: 请求参数校验（端口、主机地址等配置验证）
 *   - Config: 集中管理的常量和默认配置
 *
 * 设计要点:
 *   - peek/record 分离模式: 速率限制先用 peek() 检查所有层级，全部通过后再用 record()
 *     统一记录，确保被拒绝的请求不消耗任何配额
 *   - CancellationToken 链接: 客户端断开连接、请求超时或服务器停止时，通过
 *     CancellationToken 自动取消进行中的 LM 请求，避免资源浪费
 *   - 每个请求分配唯一 requestId (格式: req_<uuid>)，贯穿整个请求生命周期用于日志追踪
 *   - 资源通过 try-finally 和 dispose() 模式确保清理，防止内存泄漏
 *   - Node.js 单线程模型下 peek-then-record 无需加锁，天然线程安全
 *
 * ============================================================
 * 函数/类清单（TOCN File Header Index）
 * ============================================================
 *
 * 【接口】ActiveRequest
 *   - 功能说明: 活动请求的追踪信息，用于跟踪当前正在处理的请求及其生命周期
 *   - 关键属性:
 *     - req: http.IncomingMessage — 原始 HTTP 请求对象
 *     - res: http.ServerResponse — 原始 HTTP 响应对象
 *     - startTime: number — 请求开始时间戳
 *     - cancellation: vscode.CancellationTokenSource — 用于取消进行中请求的令牌源
 *
 * 【类】CopilotServer
 *   - 功能说明: 核心 HTTP 服务器，管理完整生命周期和请求处理流水线
 *   - 关键属性:
 *     - server: http.Server | null — HTTP 服务器实例
 *     - requestHandler: RequestHandler — 业务逻辑处理器
 *     - modelDiscovery: ModelDiscoveryService — 动态模型发现服务
 *     - config: ServerConfig — 当前服务器配置
 *     - state: ServerState — 运行时状态
 *     - activeRequests: Map<string, ActiveRequest> — 活动请求映射表
 *     - bearerToken: string — 认证令牌
 *     - slidingWindowMinute: RateLimiter — 每分钟滑动窗口限流器
 *     - slidingWindowHour: RateLimiter — 每小时滑动窗口限流器
 *     - tokenBucket: RateLimiter — 令牌桶突发控制限流器
 *     - unauthorizedRequestLimiter: RateLimiter — 未授权请求限流器
 *
 *   方法清单:
 *
 *   1. constructor()
 *      - 功能: 初始化服务器配置、限流器、请求处理器
 *      - 输入: 无
 *      - 输出: CopilotServer 实例
 *
 *   2. start(port?: number): Promise<void>
 *      - 功能: 启动 HTTP 服务器，生成 Bearer Token，注册事件处理
 *      - 输入: port — 可选端口号 (number | undefined)
 *      - 输出: Promise<void>
 *      - 关键变量: 默认端口由 config.port 决定
 *
 *   3. handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
 *      - 功能: 请求处理流水线入口（认证/限流/路由）
 *      - 输入: req — HTTP 请求; res — HTTP 响应
 *      - 输出: Promise<void>
 *
 *   4. validateAuth(req: http.IncomingMessage): boolean
 *      - 功能: Bearer Token 认证，使用 timingSafeEqual 防止时序攻击
 *      - 输入: req — HTTP 请求
 *      - 输出: boolean — 认证是否通过
 *
 *   5. routeRequest(method, pathname, req, res, requestId, cancellationToken): Promise<void>
 *      - 功能: URL 路径路由分发，将请求映射到对应处理器
 *      - 输入: method — HTTP 方法 (string); pathname — URL 路径 (string);
 *              req — HTTP 请求; res — HTTP 响应;
 *              requestId — 请求 ID (string); cancellationToken — 取消令牌
 *      - 输出: Promise<void>
 *
 *   6. handleModelRefresh(res: http.ServerResponse, requestId: string): Promise<void>
 *      - 功能: 处理模型缓存刷新请求 (/v1/models/refresh)
 *      - 输入: res — HTTP 响应; requestId — 请求 ID
 *      - 输出: Promise<void>
 *
 *   7. handleCapabilities(res: http.ServerResponse, requestId: string): Promise<void>
 *      - 功能: 处理服务器能力查询请求 (/v1/capabilities)
 *      - 输入: res — HTTP 响应; requestId — 请求 ID
 *      - 输出: Promise<void>
 *
 *   8. setupServerEventHandlers(): void
 *      - 功能: 注册 server error/close/connection 事件处理
 *      - 输入: 无
 *      - 输出: void
 *
 *   9. checkRateLimit(): RateLimitResult
 *      - 功能: 三层限流检查，使用 peek 语义（不消耗配额）
 *      - 输入: 无
 *      - 输出: RateLimitResult — 包含是否允许及拒绝原因
 *
 *   10. addCORSHeaders(req: http.IncomingMessage, res: http.ServerResponse): void
 *       - 功能: 为响应添加 CORS 头部（仅允许 localhost 来源）
 *       - 输入: req — HTTP 请求; res — HTTP 响应
 *       - 输出: void
 *
 *   11. handlePreflight(res: http.ServerResponse): void
 *       - 功能: 处理 OPTIONS 预检请求
 *       - 输入: res — HTTP 响应
 *       - 输出: void
 *
 *   12. handleRequestTimeout(requestId: string, res: http.ServerResponse): void
 *       - 功能: 请求超时处理与取消，触发 CancellationToken
 *       - 输入: requestId — 请求 ID; res — HTTP 响应
 *       - 输出: void
 *
 *   13. sendError(res: http.ServerResponse, statusCode: number, message: string, requestId?: string): void
 *       - 功能: 发送 JSON 格式错误响应
 *       - 输入: res — HTTP 响应; statusCode — HTTP 状态码;
 *               message — 错误信息; requestId — 可选请求 ID
 *       - 输出: void
 *
 *   14. generateRequestId(): string
 *       - 功能: 生成唯一请求 ID，格式为 req_<uuid>
 *       - 输入: 无
 *       - 输出: string — 唯一请求标识符
 *
 *   15. stop(): Promise<void>
 *       - 功能: 优雅停止服务器，取消所有活动请求并关闭连接
 *       - 输入: 无
 *       - 输出: Promise<void>
 *
 *   16. restart(): Promise<void>
 *       - 功能: 重启服务器（先停止再启动）
 *       - 输入: 无
 *       - 输出: Promise<void>
 *
 *   17. getState(): ServerState
 *       - 功能: 获取运行时状态快照
 *       - 输入: 无
 *       - 输出: ServerState — 服务器当前状态
 *
 *   18. getConfig(): ServerConfig
 *       - 功能: 获取当前配置快照
 *       - 输入: 无
 *       - 输出: ServerConfig — 当前配置对象
 *
 *   19. closeActiveRequests(): void
 *       - 功能: 取消所有活动请求，清空 activeRequests 映射表
 *       - 输入: 无
 *       - 输出: void
 *
 *   20. loadConfig(): ServerConfig
 *       - 功能: 从 VS Code 设置加载服务器配置
 *       - 输入: 无
 *       - 输出: ServerConfig — 加载后的配置对象
 *
 *   21. onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void
 *       - 功能: 配置变更监听与热重载，端口变更时自动重启
 *       - 输入: event — VS Code 配置变更事件
 *       - 输出: void
 *
 *   22. dispose(): void
 *       - 功能: 释放所有资源（服务器、限流器、事件监听等）
 *       - 输入: 无
 *       - 输出: void
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

/**
 * 活动请求的追踪信息
 *
 * 每个正在处理的 HTTP 请求都会被封装为 ActiveRequest 并存储在 Map 中，
 * 用于实现超时取消、优雅关闭时批量取消、以及活动连接数统计。
 */
interface ActiveRequest {
    /** 原始 HTTP 请求对象 */
    req: http.IncomingMessage;
    /** HTTP 响应对象，用于发送响应或在超时/关闭时发送错误 */
    res: http.ServerResponse;
    /** 请求开始时间，用于计算请求处理耗时 */
    startTime: Date;
    /** 取消令牌源，触发 cancel() 可通知下游 LM 请求停止 */
    cancellation: vscode.CancellationTokenSource;
}

/**
 * Copilot LMAPI HTTP 服务器
 *
 * 核心服务器类，管理 HTTP 服务器的完整生命周期，并协调请求处理流水线中的
 * 各个横切关注点（认证、限流、CORS、超时、路由）。
 *
 * 请求处理流水线:
 *   1. 关闭检查 -> 若服务器正在关闭，立即拒绝请求
 *   2. CORS 头部 -> 所有响应（含错误响应）均添加 CORS 头
 *   3. OPTIONS 预检 -> 直接返回 200，不受限流和认证约束
 *   4. 认证检查 -> 非公开端点需验证 Bearer Token
 *   5. 速率限制 -> 四层限制全部通过后才允许请求继续
 *   6. 请求追踪 -> 分配 requestId，注册 CancellationToken
 *   7. 路由分发 -> 根据路径分发到 RequestHandler 对应方法
 *   8. 资源清理 -> finally 块确保取消令牌释放和追踪记录删除
 */
export class CopilotServer {
    /** Node.js HTTP 服务器实例，服务器未启动时为 undefined */
    private server?: http.Server;
    /** 请求处理器，负责各端点的业务逻辑实现 */
    private requestHandler: RequestHandler;
    /** 模型发现服务，运行时动态查询可用的 Copilot 模型 */
    private modelDiscovery: ModelDiscoveryService;
    /** VS Code 配置变更监听器，用于响应用户修改扩展设置 */
    private configChangeListener?: vscode.Disposable;
    /** 当前服务器配置（端口、主机、超时等） */
    private config: ServerConfig;
    /** 服务器运行时状态（是否运行、请求计数、错误计数等） */
    private state: ServerState;
    /** 活动请求映射表，键为 requestId，用于追踪和批量取消 */
    private activeRequests: Map<string, ActiveRequest>;
    /** 关闭标志，设为 true 后所有新请求将被立即拒绝 */
    private isShuttingDown: boolean = false;
    /** 分钟级滑动窗口限流器（默认 60 次/分钟） */
    private slidingWindowMinute: SlidingWindowRateLimiter;
    /** 小时级滑动窗口限流器（默认 1000 次/小时） */
    private slidingWindowHour: SlidingWindowRateLimiter;
    /** 令牌桶限流器，用于突发请求控制（默认桶容量 10，每秒补充 1 个令牌） */
    private tokenBucket: TokenBucketRateLimiter;
    /** 未授权请求的独立限流器，防止暴力破解 Token */
    private unauthorizedRequestLimiter: SlidingWindowRateLimiter;
    /** 服务器启动时生成的 Bearer Token，客户端需在请求头中携带此 Token */
    private bearerToken: string = '';

    /**
     * 构造函数
     *
     * 初始化所有依赖服务和限流器。注意模型发现和请求处理器的异步初始化
     * 延迟到 start() 方法中执行，避免在构造函数中进行异步操作。
     */
    constructor() {
        // 创建单一 ModelDiscoveryService 实例，通过依赖注入传递给 RequestHandler，
        // 确保两者共享同一份模型缓存
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

        // 初始化三类限流器：分钟级滑动窗口、小时级滑动窗口、令牌桶
        this.slidingWindowMinute = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_MINUTE, 60_000);
        this.slidingWindowHour   = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_HOUR, 3_600_000);
        this.tokenBucket         = new TokenBucketRateLimiter(RATE_LIMITS.BURST_SIZE, 1);
        // 未授权请求使用独立的限流器，与正常请求的限流互不影响
        this.unauthorizedRequestLimiter = new SlidingWindowRateLimiter(RATE_LIMITS.REQUESTS_PER_MINUTE, 60_000);

        // 监听 VS Code 配置更改，支持端口/主机等设置的热更新
        this.configChangeListener = vscode.workspace.onDidChangeConfiguration(
            this.onConfigurationChanged.bind(this)
        );
    }

    /**
     * 启动 HTTP 服务器
     *
     * 执行以下初始化步骤:
     *   1. 检查服务器是否已在运行，避免重复启动
     *   2. 验证端口和主机配置的合法性
     *   3. 异步初始化模型发现服务和请求处理器
     *   4. 生成随机 Bearer Token 用于客户端认证
     *   5. 创建 HTTP 服务器并配置连接参数
     *   6. 绑定端口并开始监听
     *
     * @param port - 可选的监听端口号，不指定时使用配置文件中的端口
     * @returns 服务器成功启动后 resolve 的 Promise；启动失败时 reject 并携带错误信息
     * @throws 当服务器已在运行时抛出错误
     * @throws 当端口被占用（EADDRINUSE）时 reject 并显示错误通知
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

        // 显式初始化模型发现和请求处理器（不在构造函数中异步调用，
        // 因为构造函数不支持 await，且初始化可能依赖 VS Code API 的就绪状态）
        await this.modelDiscovery.discoverAllModels();
        await this.requestHandler.initialize();

        // 生成随机 UUID 作为 Bearer Token，每次启动生成新的 Token，
        // Token 会在 VS Code 通知中展示给用户
        this.bearerToken = crypto.randomUUID();

        return new Promise((resolve, reject) => {
            try {
                this.server = http.createServer(this.handleRequest.bind(this));

                // 配置 HTTP 服务器的连接参数:
                // keepAliveTimeout: 空闲连接保持时间（65秒，略大于常见反向代理的60秒超时）
                // headersTimeout: 接收完整请求头的超时（比 keepAliveTimeout 大1秒，确保顺序正确）
                // maxRequestsPerSocket: 单个连接最大请求数，防止连接滥用
                // requestTimeout: 单个请求的整体超时时间，由用户配置决定
                this.server.keepAliveTimeout = 65000;
                this.server.headersTimeout = 66000;
                this.server.maxRequestsPerSocket = 1000;
                this.server.requestTimeout = this.config.requestTimeout;

                // 设置服务器级别的事件处理器（连接建立、客户端错误等）
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
     *
     * 所有 HTTP 请求的统一入口点，按照固定的处理流水线依次执行:
     * 关闭检查 -> CORS -> URL 解析 -> 预检处理 -> 认证 -> 限流 -> 追踪注册 -> 路由分发 -> 清理
     *
     * 设计要点:
     *   - CORS 头在流水线最早期添加，确保即使 401/429 错误响应也包含 CORS 头，
     *     避免浏览器端因缺少 CORS 头而无法读取错误信息
     *   - 速率限制使用 peek/record 分离: 先 peek 检查所有限流层，全部通过后才 record，
     *     确保被拒绝的请求不消耗配额
     *   - finally 块确保无论请求成功或失败，都会清理 CancellationToken 和追踪记录
     *
     * @param req - Node.js HTTP 请求对象
     * @param res - Node.js HTTP 响应对象
     * @returns 无返回值的 Promise，请求处理完成后 resolve
     */
    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        // 服务器正在关闭时，立即拒绝所有新请求
        if (this.isShuttingDown) {
            this.sendError(res, HTTP_STATUS.SERVICE_UNAVAILABLE, 'Server is shutting down');
            return;
        }

        // 为每个请求分配唯一的 requestId，格式为 req_<uuid>，
        // 贯穿整个请求生命周期用于日志关联和追踪
        const requestId = this.generateRequestId();
        const startTime = new Date();
        const method = req.method || 'GET';

        // 所有响应（含 429/401）均添加 CORS 头
        this.addCORSHeaders(req, res);

        // 解析请求 URL，使用 host 头构造完整 URL 以正确解析路径和查询参数
        let url: URL;
        try {
            const hostHeader = req.headers.host || `${this.config.host}:${this.config.port}`;
            url = new URL(req.url || '/', `http://${hostHeader}`);
        } catch (error) {
            // URL 解析失败通常由恶意或畸形的请求导致
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

        // Bearer Token 认证检查（公开端点如 /health 跳过认证）
        if (!isPublicEndpoint && !this.validateAuth(req)) {
            // 对未授权请求应用独立的限流器，防止暴力猜测 Token
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

        // 速率限制检查: 使用 peek/record 分离模式，先检查所有限流层是否允许，
        // 通过后再统一记录。被拒绝的请求不会消耗任何限流配额
        const rateLimitResult = this.checkRateLimit();
        if (!rateLimitResult.allowed) {
            if (rateLimitResult.retryAfterMs > 0) {
                res.setHeader('Retry-After', String(Math.ceil(rateLimitResult.retryAfterMs / 1000)));
            }
            this.sendError(res, HTTP_STATUS.TOO_MANY_REQUESTS, 'Rate limit exceeded', requestId);
            return;
        }

        // 限流检查通过后，创建 CancellationToken 并注册到活动请求映射表中。
        // CancellationToken 用于在超时或服务器关闭时通知下游的 LM 请求取消
        const cancellation = new vscode.CancellationTokenSource();
        this.activeRequests.set(requestId, { req, res, startTime, cancellation });
        this.state.activeConnections = this.activeRequests.size;

        // 设置请求级别的超时: 超时后触发 CancellationToken 取消，
        // 进而中止进行中的 vscode.lm 请求
        req.setTimeout(this.config.requestTimeout, () => {
            this.handleRequestTimeout(requestId, res);
        });

        try {
            // 请求计数递增（用于服务器状态统计）
            this.state.requestCount++;
            logger.logRequest(method, url.pathname, requestId);
            // 将请求路由到对应的处理器方法
            await this.routeRequest(url.pathname, method, req, res, requestId, cancellation.token);

        } catch (error) {
            // 请求级别的错误在此捕获，不会导致服务器崩溃
            this.state.errorCount++;
            logger.error('Request handling error', error as Error, {}, requestId);

            if (!res.headersSent) {
                this.sendError(res, HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Internal server error', requestId);
            }
        } finally {
            // 无论请求成功或失败，都必须清理 CancellationToken 和追踪记录，
            // 防止内存泄漏和活动连接数统计不准确
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
     *
     * 从请求的 Authorization 头中提取 Bearer Token，与服务器生成的 Token 进行比较。
     * 使用 crypto.timingSafeEqual 进行常量时间比较，防止时序攻击（timing attack）:
     * 攻击者无法通过测量响应时间来逐字符推断正确的 Token。
     *
     * @param req - HTTP 请求对象，从中读取 Authorization 头
     * @returns 认证通过返回 true，缺少头部/格式错误/Token 不匹配返回 false
     */
    private validateAuth(req: http.IncomingMessage): boolean {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return false;
        }

        // 匹配 "Bearer <token>" 格式，不区分大小写
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (!match) {
            return false;
        }

        // 将 Token 转换为 Buffer 进行比较:
        // timingSafeEqual 要求两个 Buffer 长度相同，因此先检查长度
        const providedToken = Buffer.from(match[1], 'utf8');
        const expectedToken = Buffer.from(this.bearerToken, 'utf8');

        if (providedToken.length !== expectedToken.length) {
            return false;
        }

        // 常量时间比较，无论 Token 在哪个位置不匹配，比较耗时都相同
        return crypto.timingSafeEqual(providedToken, expectedToken);
    }

    /**
     * 路由请求到对应的处理器方法
     *
     * 根据 URL 路径和 HTTP 方法，将请求分发到 RequestHandler 的对应方法。
     * 每个端点只允许特定的 HTTP 方法，不匹配时返回 405 Method Not Allowed。
     * 未匹配任何已注册路径的请求返回 404 Not Found。
     *
     * 端点映射:
     *   POST /v1/chat/completions -> handleChatCompletions (聊天补全，支持流式/多模态/工具调用)
     *   GET  /v1/models           -> handleModels (列出可用模型及其能力)
     *   GET  /health              -> handleHealth (健康检查，无需认证)
     *   GET  /status              -> handleStatus (详细服务器指标)
     *   POST /v1/models/refresh   -> handleModelRefresh (强制刷新模型缓存)
     *   GET  /v1/capabilities     -> handleCapabilities (服务器能力信息)
     *
     * @param pathname - 请求的 URL 路径
     * @param method - HTTP 方法（GET/POST 等）
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 请求的唯一标识符，用于日志追踪
     * @param cancellationToken - 取消令牌，客户端断开或超时时触发取消
     * @returns 无返回值的 Promise
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
     * 处理模型刷新端点 (POST /v1/models/refresh)
     *
     * 手动触发模型缓存刷新，重新通过 vscode.lm.selectChatModels() 发现所有可用模型。
     * 适用于新模型上线或模型列表变更后需要立即更新的场景。
     *
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 请求的唯一标识符
     * @returns 无返回值的 Promise
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
     * 处理能力端点 (GET /v1/capabilities)
     *
     * 返回服务器的详细能力信息，包括支持的功能特性、模型统计和支持的格式。
     * 客户端可通过此端点在运行时发现服务器能力，实现自适应的功能调用。
     *
     * @param req - HTTP 请求对象
     * @param res - HTTP 响应对象
     * @param requestId - 请求的唯一标识符
     * @returns 无返回值的 Promise
     */
    private async handleCapabilities(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        requestId: string
    ): Promise<void> {
        try {
            // 从模型发现服务获取当前模型池（按优先级分为 primary/secondary/fallback 三层）
            const modelPool = this.modelDiscovery.getModelPool();

            // 构建能力描述对象，汇总服务器功能和模型统计信息
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
     * 设置服务器级别的事件处理器
     *
     * 为 HTTP 服务器注册底层网络事件的处理回调:
     *   - connection: 新 TCP 连接建立时配置 Keep-Alive 和 TCP_NODELAY
     *   - clientError: 客户端发送畸形请求时返回 400 错误
     *
     * 这些事件在请求处理流水线之前触发，属于传输层的错误处理。
     */
    private setupServerEventHandlers(): void {
        if (!this.server) {
            return;
        }

        this.server.on('connection', (socket) => {
            // 启用 TCP Keep-Alive，每 60 秒发送探测包，检测死连接
            socket.setKeepAlive(true, 60000);
            // 禁用 Nagle 算法，减少小数据包的发送延迟（对 SSE 流式响应尤为重要）
            socket.setNoDelay(true);

            socket.on('error', (error) => {
                logger.error('Socket error', error);
            });
        });

        // 客户端错误（如发送畸形 HTTP 请求），直接在 socket 层面返回 400
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
     *
     * 采用 peek/record 分离模式: 依次用 peek() 检查所有限流层，任何一层不通过则
     * 立即返回拒绝结果；只有全部四层都通过后，才调用 record()/consume() 统一记录。
     * 这确保了被拒绝的请求不会消耗任何限流配额。
     *
     * 四层检查顺序:
     *   1. 并发请求数限制 -- 当前活动请求数不超过配置上限
     *   2. 分钟级滑动窗口 -- 每分钟请求数不超过阈值（默认 60 次/分钟）
     *   3. 小时级滑动窗口 -- 每小时请求数不超过阈值（默认 1000 次/小时）
     *   4. 令牌桶突发控制 -- 限制短时间内的突发请求量（默认桶容量 10）
     *
     * 线程安全说明: Node.js 单线程事件循环模型下，peek 和 record 之间不会被
     * 其他请求打断，因此无需加锁即可保证原子性。
     *
     * @returns 速率限制检查结果，包含是否允许和建议的重试等待时间
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
     * 为响应添加动态 CORS 头
     *
     * 根据请求的 Origin 头动态生成 CORS 响应头。仅允许 localhost 来源
     * （包括 127.0.0.1 和 ::1），防止远程站点通过浏览器访问本地服务。
     * 同时附加 API 版本头，供客户端识别服务器版本。
     *
     * @param req - HTTP 请求对象，从中读取 Origin 头
     * @param res - HTTP 响应对象，向其设置 CORS 相关头
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
     * 处理 CORS 预检 OPTIONS 请求
     *
     * 浏览器在发送跨域请求前会先发送 OPTIONS 预检请求。
     * 此方法直接返回 200 响应（CORS 头已在 handleRequest 中统一添加），
     * 预检请求不受速率限制和认证约束。
     *
     * @param res - HTTP 响应对象
     */
    private handlePreflight(res: http.ServerResponse): void {
        res.writeHead(HTTP_STATUS.OK);
        res.end();
    }

    /**
     * 处理请求超时
     *
     * 当请求处理时间超过配置的 requestTimeout 时触发。通过触发 CancellationToken
     * 的 cancel() 方法，通知下游的 vscode.lm.sendChatRequest() 中止正在进行的
     * LM 请求，避免资源浪费。
     *
     * @param requestId - 超时请求的唯一标识符
     * @param res - HTTP 响应对象，用于发送 408 超时错误
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
     * 发送 JSON 格式的错误响应
     *
     * 统一的错误响应格式，兼容 OpenAI API 的错误响应结构。
     * 包含 headersSent 检查，避免在响应已发送后重复写入导致异常。
     *
     * @param res - HTTP 响应对象
     * @param statusCode - HTTP 状态码（如 400、401、429、500 等）
     * @param message - 人类可读的错误描述信息
     * @param requestId - 可选的请求标识符，包含在错误响应体中便于客户端调试
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
     * 生成唯一的请求标识符
     *
     * 使用 crypto.randomUUID() 生成符合 RFC 4122 的 v4 UUID，
     * 并添加 "req_" 前缀以便在日志中快速识别。
     *
     * @returns 格式为 "req_<uuid>" 的唯一请求标识符
     */
    private generateRequestId(): string {
        return `req_${crypto.randomUUID()}`;
    }

    /**
     * 停止 HTTP 服务器
     *
     * 执行优雅关闭流程:
     *   1. 设置 isShuttingDown 标志，使新请求被立即拒绝
     *   2. 取消所有活动请求（通过 CancellationToken 通知下游 LM 请求中止）
     *   3. 调用 server.close() 停止接受新连接并等待现有连接完成
     *   4. 设置 5 秒强制关闭超时，防止连接无法正常关闭时服务器挂起
     *   5. 重置服务器状态
     *
     * 使用 finalize 函数和 resolved 标志确保清理逻辑只执行一次，
     * 无论是正常关闭还是超时强制关闭触发。
     *
     * @returns 服务器完全停止后 resolve 的 Promise
     */
    public async stop(): Promise<void> {
        if (!this.state.isRunning || !this.server) {
            return;
        }

        this.isShuttingDown = true;

        return new Promise((resolve) => {
            // resolved 标志确保 finalize 只执行一次（正常关闭和超时强制关闭可能同时触发）
            let resolved = false;
            let forceCloseTimer: NodeJS.Timeout | undefined;

            // 统一的清理和状态重置逻辑
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

            // 先取消并关闭所有活动请求，释放相关资源
            this.closeActiveRequests();

            // 设置 5 秒强制关闭超时: 如果 server.close() 的回调未在 5 秒内触发
            // （例如存在长连接不释放），则强制关闭所有连接
            forceCloseTimer = setTimeout(() => {
                this.server?.closeAllConnections?.();
                finalize();
            }, 5000);

            // 停止接受新连接，等待现有请求完成后触发回调
            this.server!.close(() => {
                finalize();
            });
        });
    }

    /**
     * 重启 HTTP 服务器
     *
     * 先停止当前运行的服务器，再重新启动。重启会重新初始化模型发现、
     * 生成新的 Bearer Token，并使用最新的配置。
     *
     * @returns 服务器重启完成后 resolve 的 Promise
     */
    public async restart(): Promise<void> {
        await this.stop();
        await this.start();
    }

    /**
     * 获取当前服务器状态的快照
     *
     * 返回状态对象的浅拷贝，防止外部代码直接修改内部状态。
     *
     * @returns 包含运行状态、请求计数、错误计数、活动连接数等信息的状态对象副本
     */
    public getState(): ServerState {
        return { ...this.state };
    }

    /**
     * 获取当前服务器配置的快照
     *
     * 返回配置对象的浅拷贝，防止外部代码直接修改内部配置。
     *
     * @returns 包含端口、主机、超时等设置的配置对象副本
     */
    public getConfig(): ServerConfig {
        return { ...this.config };
    }

    /**
     * 关闭所有活动请求
     *
     * 在服务器关闭时调用，遍历所有活动请求并:
     *   1. 触发 CancellationToken 取消，通知下游 LM 请求中止
     *   2. 释放 CancellationToken 资源
     *   3. 对未发送响应的请求发送 503 Service Unavailable 错误
     *
     * 每个请求的清理在 try-catch 中执行，单个请求的清理失败不影响其他请求。
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
     * 从 VS Code 配置中加载服务器设置
     *
     * 读取 copilot-lmapi.* 命名空间下的所有配置项，未配置的项使用 DEFAULT_CONFIG 中的默认值。
     * 对 maxConcurrentRequests 和 requestTimeout 应用上限约束（取用户配置值和系统限制的较小值），
     * 防止用户设置不合理的过大值导致资源耗尽。
     *
     * @returns 经过验证和约束的服务器配置对象
     */
    private loadConfig(): ServerConfig {
        const config = vscode.workspace.getConfiguration('copilot-lmapi');

        return {
            port: config.get<number>('port', DEFAULT_CONFIG.port),
            host: config.get<string>('host', DEFAULT_CONFIG.host),
            autoStart: config.get<boolean>('autoStart', DEFAULT_CONFIG.autoStart),
            enableLogging: config.get<boolean>('enableLogging', DEFAULT_CONFIG.enableLogging),
            // 并发请求数取用户配置和系统上限的较小值
            maxConcurrentRequests: Math.min(
                config.get<number>('maxConcurrentRequests', DEFAULT_CONFIG.maxConcurrentRequests),
                LIMITS.MAX_CONCURRENT_REQUESTS
            ),
            // 请求超时取用户配置和系统上限的较小值
            requestTimeout: Math.min(
                config.get<number>('requestTimeout', DEFAULT_CONFIG.requestTimeout),
                LIMITS.MAX_TIMEOUT
            )
        };
    }

    /**
     * 处理 VS Code 配置变更事件
     *
     * 当用户在 VS Code 设置中修改 copilot-lmapi.* 相关配置时触发。
     * 重新加载配置并记录变更日志。如果端口或主机地址发生变化且服务器正在运行，
     * 提示用户重启服务器以使新配置生效（端口/主机变更无法热更新）。
     *
     * @param event - VS Code 配置变更事件，用于判断哪些配置项发生了变化
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

            // 端口或主机地址变更需要重启服务器才能生效
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
     * 释放所有资源
     *
     * 在扩展停用（deactivate）时调用，按以下顺序释放资源:
     *   1. 取消配置变更监听器
     *   2. 停止 HTTP 服务器（包括关闭所有活动请求）
     *   3. 释放 RequestHandler 和 ModelDiscoveryService 的资源
     *
     * stop() 的错误被 catch 吞掉并记录日志，确保后续的 dispose 调用不会被跳过。
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
