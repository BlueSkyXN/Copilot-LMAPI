/**
 * @module Config
 * @description 扩展的中心配置管理 -- 所有常量与默认值的唯一来源
 *
 * 职责:
 *   1. 提供服务器运行的默认配置 (端口、主机、超时、并发数等)
 *   2. 定义输入参数的合法范围 (端口范围、超时上下限、请求体大小等)
 *   3. 集中管理 HTTP 状态码、内容类型、API 端点路径、错误码
 *   4. 提供 CORS 与 SSE 响应头的动态生成函数
 *   5. 定义限流参数 (每分钟/每小时请求数、突发令牌桶大小)
 *   6. 定义健康检查的时间配置 (间隔、超时、启动延迟)
 *   7. 提供令牌估算的粗略参数 (字符/令牌比、上下文窗口大小)
 *   8. 管理开发/调试标志 (日志级别、详细错误、指标开关)
 *
 * 架构位置:
 *   本模块位于 src/constants/ 目录, 被几乎所有其他模块引用。
 *   它是 "无魔法数字" 原则的核心保障 -- 业务逻辑中不应出现
 *   硬编码的数值或字符串, 而应从本文件中导入对应常量。
 *
 * 关键依赖:
 *   - 无外部依赖; 仅使用 TypeScript 原生特性和 process.env
 *
 * 设计要点:
 *   - 所有导出对象均使用 `as const` 断言, 保证类型安全的字面量推断
 *   - CORS 头部通过函数动态生成, 仅允许 localhost / 127.0.0.1 来源,
 *     防止非本地请求访问 API
 *   - 限流参数与健康检查间隔经过实际调优, 兼顾响应性与资源开销
 *   - DEBUG 标志通过 process.env.NODE_ENV 区分开发与生产环境
 *
 * ═══════════════════════════════════════════════════════════════
 * 函数/常量组清单 (Function/Constant Index)
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. CONFIG_SECTION (const string)
 *    - 功能说明: VS Code 配置节名称, 对应 settings.json 中 "copilot-lmapi.*" 前缀
 *    - 类型: string
 *    - 默认值: 'copilot-lmapi'
 *
 * 2. DEFAULT_CONFIG (const object)
 *    - 功能说明: 服务器默认配置, 用户可在 VS Code 设置中覆盖
 *    - 类型: { port: number; host: string; autoStart: boolean; enableLogging: boolean;
 *             maxConcurrentRequests: number; requestTimeout: number }
 *    - 关键变量与默认值: port=8001, host='127.0.0.1', autoStart=true,
 *      enableLogging=true, maxConcurrentRequests=10, requestTimeout=120
 *
 * 3. LIMITS (const object)
 *    - 功能说明: 参数合法范围限制 (端口、超时、请求体大小等)
 *    - 类型: { PORT_MIN, PORT_MAX, TIMEOUT_MIN, TIMEOUT_MAX,
 *             MAX_BODY_SIZE, MAX_MESSAGES, MAX_MESSAGE_LENGTH, ... }
 *
 * 4. HTTP_STATUS (const object)
 *    - 功能说明: HTTP 状态码常量, 避免业务逻辑中出现硬编码数字
 *    - 类型: { OK, BAD_REQUEST, UNAUTHORIZED, NOT_FOUND,
 *             METHOD_NOT_ALLOWED, TOO_MANY_REQUESTS, INTERNAL_ERROR, SERVICE_UNAVAILABLE }
 *
 * 5. CONTENT_TYPES (const object)
 *    - 功能说明: HTTP 响应内容类型
 *    - 类型: { JSON, SSE, TEXT }
 *
 * 6. getCORSHeaders(origin?: string): Record<string, string>
 *    - 功能说明: 根据请求来源动态生成 CORS 响应头, 仅允许 localhost 来源
 *    - 输入参数: origin — string | undefined, 请求的 Origin 头
 *    - 返回值: Record<string, string>, CORS 响应头键值对
 *
 * 7. getSSEHeaders(origin?: string): Record<string, string>
 *    - 功能说明: 生成 SSE (Server-Sent Events) 流式响应头, 包含 CORS 头
 *    - 输入参数: origin — string | undefined, 请求的 Origin 头
 *    - 返回值: Record<string, string>, SSE + CORS 响应头键值对
 *
 * 8. API_ENDPOINTS (const object)
 *    - 功能说明: API 路由端点路径定义
 *    - 类型: { CHAT_COMPLETIONS, MODELS, MODELS_REFRESH, CAPABILITIES, HEALTH, STATUS }
 *
 * 9. ERROR_CODES (const object)
 *    - 功能说明: OpenAI 兼容的错误类型码
 *    - 类型: { INVALID_REQUEST, AUTHENTICATION_ERROR, NOT_FOUND,
 *             RATE_LIMIT_EXCEEDED, INTERNAL_ERROR, MODEL_NOT_FOUND, ... }
 *
 * 10. LOG_LEVELS (const object)
 *     - 功能说明: 日志级别常量
 *     - 类型: { ERROR, WARN, INFO, DEBUG }
 *
 * 11. COMMANDS (const object)
 *     - 功能说明: VS Code 命令 ID, 对应 package.json 中注册的命令
 *     - 类型: { START, STOP, RESTART, STATUS }
 *
 * 12. STATUS_BAR_PRIORITIES (const object)
 *     - 功能说明: 状态栏项的显示优先级
 *     - 类型: { MAIN }
 *
 * 13. NOTIFICATIONS (const object)
 *     - 功能说明: 用户通知消息模板
 *     - 类型: { SERVER_STARTED, SERVER_STOPPED, COPILOT_NOT_AVAILABLE, ... }
 *
 * 14. TOKEN_ESTIMATION (const object)
 *     - 功能说明: 令牌估算的粗略参数
 *     - 关键变量: CHARS_PER_TOKEN (字符/令牌比), DEFAULT_CONTEXT_WINDOW (上下文窗口大小)
 *
 * 15. RATE_LIMITS (const object)
 *     - 功能说明: 限流参数配置
 *     - 关键变量: REQUESTS_PER_MINUTE (60), REQUESTS_PER_HOUR (1000),
 *       BURST_SIZE (10), BURST_REFILL_RATE (1/秒)
 *
 * 16. HEALTH_CHECK (const object)
 *     - 功能说明: 健康检查时间配置
 *     - 关键变量: INTERVAL (检查间隔), TIMEOUT (超时), STARTUP_DELAY (启动延迟)
 *
 * 17. DEBUG (const object)
 *     - 功能说明: 开发/调试标志, 通过 NODE_ENV 自动区分环境
 *     - 关键变量: VERBOSE_LOGGING, DETAILED_ERRORS, ENABLE_METRICS
 */

/** VS Code 配置节名称, 对应 settings.json 中 "copilot-lmapi.*" 前缀 */
export const CONFIG_SECTION = 'copilot-lmapi';

/** 服务器运行的默认配置值, 用户可在 VS Code 设置中覆盖 */
export const DEFAULT_CONFIG = {
    /** HTTP 服务器监听端口 */
    port: 8001,
    /** HTTP 服务器绑定地址, 默认仅本地访问 */
    host: '127.0.0.1',
    /** 是否在扩展激活时自动启动服务器 */
    autoStart: false,
    /** 是否启用日志输出 */
    enableLogging: true,
    /** 最大并发请求数 */
    maxConcurrentRequests: 10,
    /** 单个请求的超时时间 (毫秒) */
    requestTimeout: 120000, // 2 分钟
} as const;

/** 各类输入参数的合法范围限制, 用于 Validator 校验 */
export const LIMITS = {
    /** 端口号下限 (避免使用系统保留端口 0-1023) */
    MIN_PORT: 1024,
    /** 端口号上限 */
    MAX_PORT: 65535,
    /** 最小并发请求数 */
    MIN_CONCURRENT_REQUESTS: 1,
    /** 最大并发请求数 */
    MAX_CONCURRENT_REQUESTS: 100,
    /** 请求超时下限 (毫秒) */
    MIN_TIMEOUT: 5000,  // 5 秒
    /** 请求超时上限 (毫秒) */
    MAX_TIMEOUT: 600000, // 10 分钟
    /** 单条消息内容的最大字符数 */
    MAX_MESSAGE_LENGTH: 1000000, // 1MB
    /** 单次请求中 messages 数组的最大长度 */
    MAX_MESSAGES_PER_REQUEST: 100,
    /** 请求体的最大字节数, 用于防止内存耗尽攻击 */
    MAX_REQUEST_BODY_BYTES: 10 * 1024 * 1024, // 10MB
} as const;

/** 标准 HTTP 状态码常量, 避免业务代码中出现魔法数字 */
export const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    REQUEST_TIMEOUT: 408,
    PAYLOAD_TOO_LARGE: 413,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
} as const;

/** HTTP 响应的 Content-Type 常量 */
export const CONTENT_TYPES = {
    JSON: 'application/json',
    SSE: 'text/event-stream',
    TEXT: 'text/plain',
} as const;

/**
 * 生成 CORS 响应头, 仅允许来自 localhost / 127.0.0.1 的跨域请求
 *
 * 安全策略: 通过正则校验 origin, 非本地来源一律回退为 'http://127.0.0.1',
 * 防止远程网页通过浏览器直接调用本地 API。
 *
 * @param origin - 请求中的 Origin 头部值 (可选)
 * @returns 包含 CORS 相关头部的键值对
 */
export function getCORSHeaders(origin?: string): Record<string, string> {
    // 仅当 origin 匹配 http(s)://localhost 或 http(s)://127.0.0.1 (可带端口) 时放行
    const allowedOrigin = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
        ? origin
        : 'http://127.0.0.1';
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
        'Access-Control-Max-Age': '86400',
    };
}

/**
 * 生成 SSE (Server-Sent Events) 流式响应的 HTTP 头部
 *
 * 在 CORS 头部基础上追加: Content-Type 为 text/event-stream,
 * 禁用缓存, 保持长连接, 并通过 X-Accel-Buffering 禁用 Nginx 代理缓冲。
 *
 * @param origin - 请求中的 Origin 头部值 (可选), 传递给 getCORSHeaders
 * @returns 包含 SSE 与 CORS 相关头部的键值对
 */
export function getSSEHeaders(origin?: string): Record<string, string> {
    return {
        ...getCORSHeaders(origin),
        'Content-Type': CONTENT_TYPES.SSE,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
    };
}

/** API 路由端点路径常量, CopilotServer 根据这些路径分发请求到 RequestHandler */
export const API_ENDPOINTS = {
    CHAT_COMPLETIONS: '/v1/chat/completions',
    MODELS: '/v1/models',
    MODELS_REFRESH: '/v1/models/refresh',
    CAPABILITIES: '/v1/capabilities',
    HEALTH: '/health',
    STATUS: '/status',
} as const;

/** OpenAI 兼容的错误类型码, 用于构建标准错误响应体中的 error.type 字段 */
export const ERROR_CODES = {
    INVALID_REQUEST: 'invalid_request_error',
    AUTHENTICATION_ERROR: 'authentication_error',
    PERMISSION_ERROR: 'permission_error',
    NOT_FOUND_ERROR: 'not_found_error',
    RATE_LIMIT_ERROR: 'rate_limit_error',
    API_ERROR: 'api_error',
    OVERLOADED_ERROR: 'overloaded_error',
    TIMEOUT_ERROR: 'timeout_error',
} as const;

/** 日志级别常量, 供 Logger 模块区分输出级别 */
export const LOG_LEVELS = {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
} as const;

/** VS Code 命令 ID, 对应 package.json 中 contributes.commands 的注册 */
export const COMMANDS = {
    START: 'copilot-lmapi.start',
    STOP: 'copilot-lmapi.stop',
    RESTART: 'copilot-lmapi.restart',
    STATUS: 'copilot-lmapi.status',
} as const;

/** 状态栏项的显示优先级, 数值越大越靠左 */
export const STATUS_BAR_PRIORITIES = {
    SERVER_STATUS: 100,
} as const;

/** 用户通知消息模板, 集中管理以便统一措辞和未来国际化 */
export const NOTIFICATIONS = {
    SERVER_STARTED: 'LM API Server started successfully',
    SERVER_STOPPED: 'LM API Server stopped',
    SERVER_ERROR: 'Failed to start LM API Server',
    PORT_IN_USE: 'Port is already in use',
    NO_COPILOT_ACCESS: 'GitHub Copilot access required',
} as const;

/**
 * 令牌估算参数 (粗略近似)
 *
 * 用于在发送请求前预估消息的 token 消耗量,
 * 以便进行上下文窗口溢出的预检查。
 * 注意: 这是基于经验的近似值, 不同模型的实际分词结果会有差异。
 */
export const TOKEN_ESTIMATION = {
    /** 平均每个 token 对应的字符数 (英文约 4, 中文约 1-2) */
    CHARS_PER_TOKEN: 4,
    /** 模型支持的最大上下文窗口 (token 数) */
    MAX_CONTEXT_TOKENS: 128000,
    /** 为模型响应预留的 token 数量 */
    RESERVED_RESPONSE_TOKENS: 4096,
} as const;

/**
 * 三层限流参数配置
 *
 * RateLimiter 同时使用滑动窗口和令牌桶算法:
 *   1. 滑动窗口: 每分钟最大请求数 (REQUESTS_PER_MINUTE)
 *   2. 滑动窗口: 每小时最大请求数 (REQUESTS_PER_HOUR)
 *   3. 令牌桶: 突发控制 (BURST_SIZE 为桶容量, 每秒补充 1 个令牌)
 *
 * 采用 peek/record 分离设计: peek() 仅检查不计数, record() 在请求通过所有校验后才计数,
 * 确保被拒绝的请求不消耗配额。
 */
export const RATE_LIMITS = {
    /** 每分钟最大请求数 (滑动窗口) */
    REQUESTS_PER_MINUTE: 60,
    /** 每小时最大请求数 (滑动窗口) */
    REQUESTS_PER_HOUR: 1000,
    /** 令牌桶容量, 控制短时间内的突发请求数 */
    BURST_SIZE: 10,
} as const;

/**
 * 健康检查时间配置
 *
 * 定期通过 vscode.lm.selectChatModels() 探测 Copilot 可用性,
 * 在服务器运行期间若发现 Copilot 不可用则记录警告日志。
 */
export const HEALTH_CHECK = {
    /** 定期检查间隔 (毫秒), 10 分钟 -- 从 30 秒优化而来, 降低 API 调用频率 */
    INTERVAL: 600000, // 10 分钟 (从30秒优化)
    /** 单次健康检查的超时时间 (毫秒) */
    TIMEOUT: 5000,    // 5 秒
    /** 扩展激活后首次检查的延迟 (毫秒), 等待 Copilot 扩展完成初始化 */
    STARTUP_DELAY: 20000, // 启动延迟 20 秒，等待 Copilot 初始化
} as const;

/**
 * 开发与调试标志
 *
 * 通过 process.env.NODE_ENV 自动区分开发和生产环境。
 * 开发环境下启用请求/响应日志和详细错误信息, 生产环境仅保留指标采集。
 */
export const DEBUG = {
    /** 是否记录完整请求内容 (仅开发环境) */
    LOG_REQUESTS: process.env.NODE_ENV === 'development',
    /** 是否记录完整响应内容 (仅开发环境) */
    LOG_RESPONSES: process.env.NODE_ENV === 'development',
    /** 是否启用性能指标采集 (始终开启) */
    ENABLE_METRICS: true,
    /** 是否在错误响应中包含详细堆栈信息 (仅开发环境) */
    DETAILED_ERRORS: process.env.NODE_ENV === 'development',
} as const;
