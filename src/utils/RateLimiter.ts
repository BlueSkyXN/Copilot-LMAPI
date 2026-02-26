/**
 * 频率限制工具类
 * 提供滑动窗口和令牌桶两种限流算法
 * 设计原则：被拒绝的请求不计入任何限制计数
 */

export interface RateLimitResult {
    allowed: boolean;
    retryAfterMs: number;
}

/**
 * 滑动窗口限流器
 * 在指定时间窗口内限制请求总数
 * 使用 peek/record 分离模式，保证被拒绝的请求不计入窗口
 * 使用 headIndex 指针替代 Array.shift()，避免 O(n) 性能退化
 */
export class SlidingWindowRateLimiter {
    private timestamps: number[] = [];
    private headIndex: number = 0;
    private readonly limit: number;
    private readonly windowMs: number;

    constructor(limit: number, windowMs: number) {
        this.limit = limit;
        this.windowMs = windowMs;
    }

    /**
     * 检查是否允许通过，不记录请求（配额只读语义）
     * 注意：会清理过期记录以维护窗口状态，该副作用不计入请求额度
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

        const activeCount = this.timestamps.length - this.headIndex;
        if (activeCount >= this.limit) {
            const retryAfterMs = this.timestamps[this.headIndex] + this.windowMs - now;
            return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
        }

        return { allowed: true, retryAfterMs: 0 };
    }

    /**
     * 记录一次请求（应在 peek() 返回 allowed=true 后调用）
     */
    record(): void {
        this.timestamps.push(Date.now());
    }
}

/**
 * 令牌桶限流器
 * 以固定速率补充令牌，支持短时间突发请求
 * 使用 peek/consume 分离模式，保证被拒绝的请求不消耗令牌
 */
export class TokenBucketRateLimiter {
    private tokens: number;
    private lastRefillTime: number;
    private readonly capacity: number;
    private readonly refillRate: number; // 每毫秒补充的令牌数

    constructor(capacity: number, refillPerSecond: number) {
        this.capacity = capacity;
        this.refillRate = refillPerSecond / 1000;
        this.tokens = capacity;
        this.lastRefillTime = Date.now();
    }

    /**
     * 检查是否有可用令牌，不消耗（只读）
     */
    peek(): RateLimitResult {
        this.refill();

        if (this.tokens < 1) {
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

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefillTime;
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
        this.lastRefillTime = now;
    }
}
