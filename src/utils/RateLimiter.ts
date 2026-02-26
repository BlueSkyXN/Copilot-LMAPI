/**
 * @module RateLimiter
 * @description 请求频率限制工具模块
 *
 * 职责：
 * - 提供滑动窗口（SlidingWindowRateLimiter）和令牌桶（TokenBucketRateLimiter）两种限流算法
 * - 实现 peek/record（或 peek/consume）分离模式，确保被拒绝的请求不消耗配额
 * - 为 CopilotServer 的三层限流策略提供底层组件
 *
 * 架构位置：
 *   位于 src/utils/ 工具层。被 CopilotServer 直接调用，组合为：
 *   1. 每分钟滑动窗口（SlidingWindowRateLimiter）
 *   2. 每小时滑动窗口（SlidingWindowRateLimiter）
 *   3. 突发控制令牌桶（TokenBucketRateLimiter）
 *
 * 关键依赖：无外部依赖，纯算法实现
 *
 * 设计要点：
 * - peek() 为只读检查，不改变请求计数；record()/consume() 才真正计入
 * - 滑动窗口使用 headIndex 指针替代 Array.shift()，将过期清理从 O(n) 优化为 O(1) 均摊
 * - headIndex 超过 1000 时执行一次数组压缩，回收已跳过元素的内存
 * - 令牌桶通过惰性补充（lazy refill）避免定时器开销
 *
 * ═══════════════════════════════════════════════════════
 * 函数/类清单
 * ═══════════════════════════════════════════════════════
 *
 * 【RateLimitResult（接口）】
 *   - 功能说明：限流检查结果（allowed, retryAfterMs）
 *
 * 【SlidingWindowRateLimiter（类）】
 *   - 功能说明：滑动窗口限流器
 *   - 关键属性：timestamps (number[]), headIndex (number), limit (number), windowMs (number)
 *
 *   1. constructor(limit: number, windowMs: number)
 *      - 功能：初始化
 *      - 输入：limit — 窗口内最大请求数, windowMs — 窗口大小（毫秒）
 *
 *   2. peek(): RateLimitResult
 *      - 功能：只读检查是否允许
 *      - 输出：RateLimitResult
 *
 *   3. record(): void
 *      - 功能：记录一次请求
 *
 * 【TokenBucketRateLimiter（类）】
 *   - 功能说明：令牌桶限流器
 *   - 关键属性：tokens (number), lastRefillTime (number), capacity (number), refillRate (number)
 *
 *   1. constructor(capacity: number, refillPerSecond: number)
 *      - 功能：初始化
 *      - 输入：capacity — 桶容量, refillPerSecond — 每秒补充令牌数
 *
 *   2. peek(): RateLimitResult
 *      - 功能：只读检查是否有令牌
 *      - 输出：RateLimitResult
 *
 *   3. consume(): void
 *      - 功能：消耗一个令牌
 *
 *   4. refill(): void
 *      - 功能：惰性令牌补充
 */

/**
 * 限流检查结果
 * @property allowed - 是否允许通过
 * @property retryAfterMs - 如果被拒绝，建议等待的毫秒数（allowed 为 true 时为 0）
 */
export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs: number;
}

/**
 * 滑动窗口限流器
 *
 * 在指定的时间窗口（windowMs）内限制请求总数不超过 limit。
 * 采用 peek/record 分离模式：peek() 仅检查是否可通过，record() 才记录一次请求。
 * 内部使用 headIndex 指针跳过过期记录，避免 Array.shift() 导致的 O(n) 数组搬移。
 */
export class SlidingWindowRateLimiter {
    /** 请求时间戳数组，记录每次 record() 的时刻 */
    private timestamps: number[] = [];
    /** 指向数组中第一个未过期元素的索引，避免频繁的数组头部删除 */
    private headIndex: number = 0;
    /** 窗口内允许的最大请求数 */
    private readonly limit: number;
    /** 滑动窗口时长（毫秒） */
    private readonly windowMs: number;

    /**
     * @param limit - 窗口内允许的最大请求数
     * @param windowMs - 滑动窗口时长（毫秒）
     */
    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    /**
     * 检查当前是否允许新请求通过（只读语义，不计入配额）
     *
     * 内部会清理窗口外的过期记录（移动 headIndex 指针），
     * 该副作用仅维护窗口状态，不影响请求计数。
     * 当 headIndex 超过 1000 时执行数组压缩，回收内存。
     *
     * @returns 限流检查结果，包含是否允许及建议重试等待时间
     */
    peek(): RateLimitResult {
        const now = Date.now();
        const windowStart = now - this.windowMs;

        // 使用指针跳过窗口外的过期记录（O(1) 均摊）
        while (this.headIndex < this.timestamps.length && this.timestamps[this.headIndex] <= windowStart) {
            this.headIndex++;
        }

        // 定期压缩数组，回收已跳过的内存
        if (this.headIndex > 1000) {
            this.timestamps = this.timestamps.slice(this.headIndex);
            this.headIndex = 0;
        }

        // 计算窗口内活跃请求数
        const activeCount = this.timestamps.length - this.headIndex;
        if (activeCount >= this.limit) {
            // 计算最早过期记录离开窗口的时间作为重试等待时间
            const retryAfterMs = this.timestamps[this.headIndex] + this.windowMs - now;
            return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
        }

        return { allowed: true, retryAfterMs: 0 };
    }

    /**
     * 记录一次请求（应在 peek() 返回 allowed=true 后调用）
     *
     * 将当前时间戳追加到数组中，作为窗口内的一次有效请求。
     */
    record(): void {
        this.timestamps.push(Date.now());
    }
}

/**
 * 令牌桶限流器
 *
 * 以固定速率（refillPerSecond）向桶中补充令牌，桶容量为 capacity。
 * 每次请求消耗一个令牌，桶为空时拒绝请求。
 * 适合控制短时间内的突发请求量。
 * 采用 peek/consume 分离模式：peek() 仅检查令牌数，consume() 才真正消耗令牌。
 */
export class TokenBucketRateLimiter {
    /** 当前可用令牌数（可为小数，因惰性补充按时间比例计算） */
    private tokens: number;
    /** 上次令牌补充的时间戳 */
    private lastRefillTime: number;
    /** 桶的最大容量 */
    private readonly capacity: number;
    /** 每毫秒补充的令牌数（由 refillPerSecond / 1000 计算得出） */
    private readonly refillRate: number;

    /**
     * @param capacity - 令牌桶最大容量
     * @param refillPerSecond - 每秒补充的令牌数
     */
    constructor(capacity: number, refillPerSecond: number) {
        this.capacity = capacity;
        this.refillRate = refillPerSecond / 1000;
        this.tokens = capacity;
        this.lastRefillTime = Date.now();
    }

    /**
     * 检查是否有可用令牌（只读，不消耗）
     *
     * 内部先执行惰性补充（refill），然后检查令牌数是否 >= 1。
     * 如果不足，计算需要等待多少毫秒才能补充到 1 个令牌。
     *
     * @returns 限流检查结果，包含是否允许及建议重试等待时间
     */
    peek(): RateLimitResult {
        this.refill();

        if (this.tokens < 1) {
            // 计算补充到 1 个令牌所需的等待时间
            const retryAfterMs = Math.ceil((1 - this.tokens) / this.refillRate);
            return { allowed: false, retryAfterMs };
        }

        return { allowed: true, retryAfterMs: 0 };
    }

    /**
     * 消耗一个令牌（应在 peek() 返回 allowed=true 后调用）
     */
    consume(): void {
        this.tokens -= 1;
    }

    /**
     * 惰性令牌补充
     *
     * 根据距上次补充经过的时间计算应补充的令牌数，
     * 补充后总量不超过桶容量（capacity）。
     * 避免使用定时器，仅在需要检查时按需计算。
     */
    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefillTime;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
        this.lastRefillTime = now;
    }
}
