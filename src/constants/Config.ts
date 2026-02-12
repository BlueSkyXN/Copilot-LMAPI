/**
 * 配置常量
 * 扩展的中心配置管理
 */

export const CONFIG_SECTION = 'copilot-lmapi';

export const DEFAULT_CONFIG = {
    port: 8001,
    host: '127.0.0.1',
    autoStart: false,
    enableLogging: true,
    maxConcurrentRequests: 10,
    requestTimeout: 120000, // 2 分钟
} as const;

export const LIMITS = {
    MIN_PORT: 1024,
    MAX_PORT: 65535,
    MIN_CONCURRENT_REQUESTS: 1,
    MAX_CONCURRENT_REQUESTS: 100,
    MIN_TIMEOUT: 5000,  // 5 秒
    MAX_TIMEOUT: 600000, // 10 分钟
    MAX_MESSAGE_LENGTH: 1000000, // 1MB
    MAX_MESSAGES_PER_REQUEST: 100,
} as const;

export const HTTP_STATUS = {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    METHOD_NOT_ALLOWED: 405,
    REQUEST_TIMEOUT: 408,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
} as const;

export const CONTENT_TYPES = {
    JSON: 'application/json',
    SSE: 'text/event-stream',
    TEXT: 'text/plain',
} as const;

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
} as const;

export const SSE_HEADERS = {
    ...CORS_HEADERS,
    'Content-Type': CONTENT_TYPES.SSE,
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲
} as const;

export const API_ENDPOINTS = {
    CHAT_COMPLETIONS: '/v1/chat/completions',
    MODELS: '/v1/models',
    HEALTH: '/health',
    STATUS: '/status',
} as const;

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

export const LOG_LEVELS = {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR',
} as const;

export const COMMANDS = {
    START: 'copilot-lmapi.start',
    STOP: 'copilot-lmapi.stop',
    RESTART: 'copilot-lmapi.restart',
    STATUS: 'copilot-lmapi.status',
} as const;

export const STATUS_BAR_PRIORITIES = {
    SERVER_STATUS: 100,
} as const;

export const NOTIFICATIONS = {
    SERVER_STARTED: 'LM API Server started successfully',
    SERVER_STOPPED: 'LM API Server stopped',
    SERVER_ERROR: 'Failed to start LM API Server',
    PORT_IN_USE: 'Port is already in use',
    NO_COPILOT_ACCESS: 'GitHub Copilot access required',
} as const;

// 令牌估算（粗略近似）
export const TOKEN_ESTIMATION = {
    CHARS_PER_TOKEN: 4,
    MAX_CONTEXT_TOKENS: 128000,
    RESERVED_RESPONSE_TOKENS: 4096,
} as const;

// 限流
export const RATE_LIMITS = {
    REQUESTS_PER_MINUTE: 60,
    REQUESTS_PER_HOUR: 1000,
    BURST_SIZE: 10,
} as const;

// 健康检查配置
export const HEALTH_CHECK = {
    INTERVAL: 600000, // 10 分钟 (从30秒优化)
    TIMEOUT: 5000,    // 5 秒
    STARTUP_DELAY: 20000, // 启动延迟 20 秒，等待 Copilot 初始化
} as const;

// 开发/调试标志
export const DEBUG = {
    LOG_REQUESTS: process.env.NODE_ENV === 'development',
    LOG_RESPONSES: process.env.NODE_ENV === 'development',
    ENABLE_METRICS: true,
    DETAILED_ERRORS: process.env.NODE_ENV === 'development',
} as const;