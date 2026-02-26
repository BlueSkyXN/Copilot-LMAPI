/**
 * @module runTest
 * @description 项目测试入口 —— 检查运行器
 *
 * 职责：
 * - 提供 vscode 模块的最小化 mock，使测试可以在 Node.js 环境下独立运行
 * - 动态加载依赖 vscode 的 Validator 模块
 * - 定义并运行一系列检查用例，覆盖以下模块的关键行为：
 *   - ModelCapabilities —— 类型字段合规性
 *   - ModelDiscoveryService —— 能力探测与缓存重建机制
 *   - Validator —— 工具调用关联、歧义检测、字段约束
 *   - RequestHandler —— SSE 延迟发送、取消令牌链接、状态标志、缓存 TTL
 *   - CopilotServer —— 未授权请求限流
 *   - Converter —— 必需工具模式下的流缓冲
 *   - RateLimiter —— 滑动窗口与令牌桶的行为验证
 * - 汇总检查结果并设置进程退出码
 *
 * 架构位置：
 *   位于 src/test/，编译后从 out/test/runTest.js 执行。
 *   通过 npm test 调用，不依赖 VS Code 扩展宿主。
 *
 * 关键依赖：
 * - assert —— Node.js 内置断言库
 * - fs / path —— 文件读取，用于源码内容检查
 * - RateLimiter —— 直接导入并做行为测试
 * - Validator —— 通过 mock vscode 后动态加载
 *
 * 设计要点：
 * - 使用 Module._load 拦截实现 vscode mock，避免对源码的侵入式修改
 * - 检查用例分为"源码内容检查"和"运行时行为检查"两类
 * - 源码内容检查通过读取 .ts 文件并匹配关键字符串，验证设计约束是否被遵守
 * - 运行时行为检查通过 mock Date.now 控制时间流逝，验证限流器的精确行为
 *
 * ═══════════════════════════════════════════════════════
 * 函数/类清单
 * ═══════════════════════════════════════════════════════
 *
 *   1. ValidatorModule（类型）
 *      - 功能说明：Validator 模块的类型定义
 *
 *   2. CheckCase（类型）
 *      - 功能说明：检查用例类型
 *
 *   3. loadValidatorModule(): ValidatorModule
 *      - 功能：加载并 mock Validator 模块
 *      - 输出：ValidatorModule
 *
 *   4. repoRoot(): string
 *      - 功能：获取仓库根目录路径
 *      - 输出：string
 *
 *   5. readRepoFile(relativePath: string): string
 *      - 功能：读取仓库文件
 *      - 输入：relativePath — 相对路径
 *      - 输出：string（文件内容）
 *
 *   6. runChecks(checks: CheckCase[]): Promise<void>
 *      - 功能：运行检查用例
 *      - 输入：checks — 检查用例数组
 *
 *   7. expectValidationError(fn: Function, messagePattern: RegExp): void
 *      - 功能：断言验证错误
 *      - 输入：fn — 待执行函数, messagePattern — 错误消息匹配模式
 *
 *   8. checks (const CheckCase[])
 *      - 功能说明：17 个检查用例定义
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SlidingWindowRateLimiter, TokenBucketRateLimiter } from '../utils/RateLimiter';

/**
 * Validator 模块的类型定义
 *
 * 因 Validator 依赖 vscode 模块，需要通过 mock 后动态加载，
 * 此处定义其导出的类型签名以便在测试中使用。
 */
type ValidatorModule = {
    /** Validator 类，包含静态验证方法 */
    Validator: {
        validateChatCompletionRequest: (request: any, availableModels?: any[]) => any;
    };
    /** ValidationError 构造函数 */
    ValidationError: new (...args: any[]) => Error;
};

/**
 * 加载 Validator 模块（需 mock vscode 依赖）
 *
 * 通过拦截 Node.js 的 Module._load 方法，将 'vscode' 模块替换为
 * 包含 window 和 workspace 最小化 mock 的对象，从而使 Validator
 * 及其传递依赖（如 Logger）能够在非 VS Code 环境下正常初始化。
 *
 * @returns 包含 Validator 类和 ValidationError 类的模块对象
 */
function loadValidatorModule(): ValidatorModule {
    const Module = require('module') as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };

    // 最小化的 vscode 模块 mock
    const mockVscode = {
        window: {
            createOutputChannel: () => ({
                appendLine: () => undefined,
                clear: () => undefined,
                show: () => undefined,
                dispose: () => undefined
            }),
            showErrorMessage: () => undefined
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key: string, defaultValue: unknown) => defaultValue
            })
        }
    };

    // 拦截模块加载：当请求 'vscode' 时返回 mock 对象
    const originalLoad = Module._load;
    Module._load = function(request: string, parent: unknown, isMain: boolean): unknown {
        if (request === 'vscode') {
            return mockVscode;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../utils/Validator') as ValidatorModule;
    } finally {
        // 恢复原始的模块加载函数，避免影响后续模块加载
        Module._load = originalLoad;
    }
}

/** 加载经 mock 处理的 Validator 模块并解构导出 */
const { Validator, ValidationError } = loadValidatorModule();

/**
 * 检查用例类型定义
 * @property name - 用例名称，用于在结果汇总中标识
 * @property run - 用例执行函数，可以是同步或异步
 */
type CheckCase = {
    name: string;
    run: () => void | Promise<void>;
};

/**
 * 获取项目仓库根目录的绝对路径
 *
 * 基于编译后的文件位置（out/test/runTest.js）向上回溯两级。
 *
 * @returns 仓库根目录绝对路径
 */
function repoRoot(): string {
    return path.resolve(__dirname, '..', '..');
}

/**
 * 读取仓库中指定相对路径的文件内容
 *
 * 用于源码内容检查类用例，直接读取 .ts 源文件以验证设计约束。
 *
 * @param relativePath - 相对于仓库根目录的文件路径
 * @returns 文件的 UTF-8 文本内容
 */
function readRepoFile(relativePath: string): string {
    const absolutePath = path.join(repoRoot(), relativePath);
    return fs.readFileSync(absolutePath, 'utf8');
}

/**
 * 检查用例运行器
 *
 * 依次执行所有检查用例，收集通过/失败结果，
 * 最后输出汇总信息并在有失败用例时设置非零退出码。
 *
 * @param checks - 要执行的检查用例数组
 */
async function runChecks(checks: CheckCase[]): Promise<void> {
    let passed = 0;
    const failed: Array<{ name: string; error: unknown }> = [];

    for (const check of checks) {
        try {
            await check.run();
            passed += 1;
            console.log(`PASS ${check.name}`);
        } catch (error) {
            failed.push({ name: check.name, error });
            console.error(`FAIL ${check.name}`);
            console.error(error);
        }
    }

    console.log(`\nSummary: ${passed}/${checks.length} checks passed`);
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

/**
 * 断言辅助函数：期望执行函数抛出 ValidationError 且消息匹配指定模式
 *
 * @param fn - 预期会抛出 ValidationError 的函数
 * @param messagePattern - 用于匹配错误消息的正则表达式
 */
function expectValidationError(fn: () => void, messagePattern: RegExp): void {
    assert.throws(fn, (error: unknown) => {
        return error instanceof ValidationError && messagePattern.test(error.message);
    });
}

/** 所有检查用例定义 */
const checks: CheckCase[] = [
    // --- ModelCapabilities 类型字段检查 ---
    {
        /** 验证 ModelCapabilities 已移除旧版 supportsFunctionCalling 字段，使用 supportsTools 替代 */
        name: 'ModelCapabilities removes supportsFunctionCalling',
        run: () => {
            const content = readRepoFile('src/types/ModelCapabilities.ts');
            assert.ok(
                !content.includes('supportsFunctionCalling'),
                'Legacy field supportsFunctionCalling should not exist in ModelCapabilities'
            );
            assert.ok(
                /supportsTools\s*:\s*boolean/.test(content),
                'supportsTools field should exist in ModelCapabilities'
            );
        }
    },
    // --- ModelDiscoveryService 能力探测检查 ---
    {
        /** 验证 ModelDiscoveryService 使用保守的提示词检测而非乐观默认值 */
        name: 'ModelDiscoveryService uses supportsTools capability probe',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('supportsTools: false'),
                'supportsTools should be initialized to false'
            );
            assert.ok(
                content.includes('capabilities.supportsTools = await this.testToolCapability(vsCodeModel);'),
                'supportsTools should be set from testToolCapability'
            );
            assert.ok(
                !content.includes('supportsFunctionCalling'),
                'ModelDiscoveryService should not reference supportsFunctionCalling'
            );
        }
    },
    {
        /** 验证 ModelDiscoveryService 使用基于提示词的保守检测，而非始终为 true 的乐观默认值 */
        name: 'ModelDiscoveryService avoids optimistic always-true capability defaults',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('const visionHints = [') && content.includes('const toolHints = ['),
                'Capability probes should use conservative hint-based detection'
            );
            assert.ok(
                content.includes('getCapabilityProbeText('),
                'Capability probes should normalize model metadata before matching'
            );
        }
    },
    {
        /** 验证 ModelDiscoveryService 在发现过程中重建缓存，避免残留过期模型条目 */
        name: 'ModelDiscoveryService rebuilds cache during discovery',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('const nextModelCache = new Map<string, ModelCapabilities>();'),
                'Discovery should rebuild model cache from current probe results'
            );
            assert.ok(
                content.includes('this.modelCache = nextModelCache;'),
                'Discovery should replace cache atomically to avoid stale model entries'
            );
        }
    },
    // --- Validator 运行时行为检查 ---
    {
        /** 验证 Validator 拒绝非 tool/function 角色的消息携带 tool_call_id */
        name: 'Validator rejects tool_call_id on non tool/function roles',
        run: () => {
            expectValidationError(
                () => Validator.validateChatCompletionRequest({
                    model: 'test-model',
                    messages: [
                        {
                            role: 'user',
                            content: 'hello',
                            tool_call_id: 'call_1'
                        }
                    ]
                }),
                /tool_call_id is only valid for tool\/function messages/i
            );
        }
    },
    {
        /** 验证当多个同名工具调用存在时，旧版 function 消息（无 tool_call_id）被拒绝为歧义 */
        name: 'Validator rejects ambiguous legacy function result mapping',
        run: () => {
            expectValidationError(
                () => Validator.validateChatCompletionRequest({
                    model: 'test-model',
                    messages: [
                        {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } },
                                { id: 'call_2', type: 'function', function: { name: 'foo', arguments: '{}' } }
                            ]
                        },
                        {
                            role: 'function',
                            name: 'foo',
                            content: 'ok'
                        }
                    ]
                }),
                /ambiguous/i
            );
        }
    },
    {
        /** 验证当仅有唯一匹配时，旧版 function 消息可以正常通过验证 */
        name: 'Validator allows unambiguous legacy function result mapping',
        run: () => {
            const validated = Validator.validateChatCompletionRequest({
                model: 'test-model',
                messages: [
                    {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            { id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } }
                        ]
                    },
                    {
                        role: 'function',
                        name: 'foo',
                        content: 'ok'
                    }
                ]
            });

            assert.strictEqual(validated.messages.length, 2);
            assert.strictEqual(validated.messages[1].role, 'function');
        }
    },
    {
        /** 验证 Validator 拒绝引用了不存在的 tool_call_id 的 function 消息 */
        name: 'Validator rejects unknown tool_call_id on function messages',
        run: () => {
            expectValidationError(
                () => Validator.validateChatCompletionRequest({
                    model: 'test-model',
                    messages: [
                        {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } }
                            ]
                        },
                        {
                            role: 'function',
                            name: 'foo',
                            tool_call_id: 'call_unknown',
                            content: 'ok'
                        }
                    ]
                }),
                /No matching assistant tool call found/i
            );
        }
    },
    {
        /** 验证当 function 消息的 name 与 tool_call_id 指向的函数名不匹配时被拒绝 */
        name: 'Validator rejects mismatched function name for explicit tool_call_id',
        run: () => {
            expectValidationError(
                () => Validator.validateChatCompletionRequest({
                    model: 'test-model',
                    messages: [
                        {
                            role: 'assistant',
                            content: null,
                            tool_calls: [
                                { id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } }
                            ]
                        },
                        {
                            role: 'function',
                            name: 'bar',
                            tool_call_id: 'call_1',
                            content: 'ok'
                        }
                    ]
                }),
                /maps to function "foo"/i
            );
        }
    },
    // --- RequestHandler 源码内容检查 ---
    {
        /** 验证 RequestHandler 延迟 SSE 响应头到第一个数据块时才发送 */
        name: 'RequestHandler delays SSE headers until first chunk',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            const hasDeferredHeaderGuard = content.includes('if (!res.headersSent) {');
            const hasSseWriteHead =
                content.includes('res.writeHead(HTTP_STATUS.OK);') ||
                content.includes('res.writeHead(HTTP_STATUS.OK, getSSEHeaders());') ||
                content.includes('res.writeHead(HTTP_STATUS.OK, SSE_HEADERS);');
            const hasSseContentType =
                content.includes("res.setHeader('Content-Type', CONTENT_TYPES.SSE);") ||
                content.includes('res.writeHead(HTTP_STATUS.OK, getSSEHeaders());') ||
                content.includes('res.writeHead(HTTP_STATUS.OK, SSE_HEADERS);');
            assert.ok(
                hasDeferredHeaderGuard && hasSseWriteHead && hasSseContentType,
                'Streaming handler should defer SSE header emission until first chunk'
            );
        }
    },
    {
        /** 验证 RequestHandler 将服务器取消令牌链接到 LM 请求的取消令牌 */
        name: 'RequestHandler links server cancellation token into LM request token',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('serverCancellationToken?: vscode.CancellationToken'),
                'Chat completions handler should accept an optional server cancellation token'
            );
            assert.ok(
                content.includes('serverCancellationToken.onCancellationRequested'),
                'Handler should subscribe to server cancellation and cancel LM request'
            );
        }
    },
    // --- CopilotServer 源码内容检查 ---
    {
        /** 验证 CopilotServer 为未授权请求配备了独立的限流器 */
        name: 'CopilotServer rate-limits unauthorized requests',
        run: () => {
            const content = readRepoFile('src/server/CopilotServer.ts');
            assert.ok(
                content.includes('private unauthorizedRequestLimiter: SlidingWindowRateLimiter;'),
                'Server should define a dedicated limiter for unauthorized requests'
            );
            assert.ok(
                content.includes('const unauthorizedRateLimit = this.unauthorizedRequestLimiter.peek();') &&
                content.includes('this.unauthorizedRequestLimiter.record();'),
                'Unauthorized requests should be checked and recorded in the dedicated limiter'
            );
        }
    },
    {
        /** 验证 RequestHandler 状态端点不暴露已移除的 autoModelSelection 标志 */
        name: 'RequestHandler status flags reflect explicit model routing',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                !content.includes('autoModelSelection:'),
                'Status endpoint should not expose removed autoModelSelection flag'
            );
            assert.ok(
                content.includes('loadBalancing: false'),
                'Status endpoint should keep loadBalancing flag aligned with implementation'
            );
        }
    },
    {
        /** 验证 RequestHandler 对 Copilot 访问探测使用短失败缓存 TTL（10秒）和长成功缓存 TTL（60秒） */
        name: 'RequestHandler uses short failure cache TTL for Copilot access probe',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('COPILOT_ACCESS_SUCCESS_CACHE_TTL = 60_000'),
                'Successful Copilot access checks should keep a longer cache TTL'
            );
            assert.ok(
                content.includes('COPILOT_ACCESS_FAILURE_CACHE_TTL = 10_000') &&
                content.includes('? RequestHandler.COPILOT_ACCESS_SUCCESS_CACHE_TTL') &&
                content.includes(': RequestHandler.COPILOT_ACCESS_FAILURE_CACHE_TTL'),
                'Copilot access cache should use success TTL only for available=true and short TTL otherwise'
            );
        }
    },
    // --- Converter 源码内容检查 ---
    {
        /** 验证 Converter 在必需工具模式下缓冲流输出，直到第一个工具调用出现 */
        name: 'Converter buffers stream output in required tool mode',
        run: () => {
            const content = readRepoFile('src/utils/Converter.ts');
            assert.ok(
                content.includes('const pendingEvents: string[] = [];') && content.includes('if (requiresToolCall && !hasToolCalls)'),
                'Converter should buffer events before first tool call in required mode'
            );
        }
    },
    // --- RateLimiter 运行时行为检查 ---
    {
        /**
         * 验证滑动窗口限流器的核心行为：
         * 1. 初始状态允许通过
         * 2. 达到上限后拒绝并返回正确的重试等待时间
         * 3. 窗口过期后恢复允许
         *
         * 通过 mock Date.now 精确控制时间流逝。
         */
        name: 'SlidingWindowRateLimiter enforces limit and recovers after window',
        run: () => {
            const originalNow = Date.now;
            let now = 1_000;
            (Date as { now: () => number }).now = () => now;
            try {
                const limiter = new SlidingWindowRateLimiter(2, 1_000);
                assert.deepStrictEqual(limiter.peek(), { allowed: true, retryAfterMs: 0 });

                limiter.record();
                limiter.record();
                const blocked = limiter.peek();
                assert.strictEqual(blocked.allowed, false);
                assert.strictEqual(blocked.retryAfterMs, 1_000);

                now += 1_000;
                assert.strictEqual(limiter.peek().allowed, true);
            } finally {
                (Date as { now: () => number }).now = originalNow;
            }
        }
    },
    {
        /**
         * 验证令牌桶限流器的核心行为：
         * 1. 初始满桶状态允许通过
         * 2. 消耗完令牌后拒绝并返回正确的重试等待时间
         * 3. 半补充后仍不足时返回剩余等待时间
         * 4. 完全补充后恢复允许
         *
         * 通过 mock Date.now 精确控制时间流逝。
         */
        name: 'TokenBucketRateLimiter refills tokens over time',
        run: () => {
            const originalNow = Date.now;
            let now = 2_000;
            (Date as { now: () => number }).now = () => now;
            try {
                const limiter = new TokenBucketRateLimiter(2, 1);
                assert.strictEqual(limiter.peek().allowed, true);

                limiter.consume();
                limiter.consume();
                const blocked = limiter.peek();
                assert.strictEqual(blocked.allowed, false);
                assert.strictEqual(blocked.retryAfterMs, 1_000);

                now += 500;
                const halfRefill = limiter.peek();
                assert.strictEqual(halfRefill.allowed, false);
                assert.strictEqual(halfRefill.retryAfterMs, 500);

                now += 500;
                assert.strictEqual(limiter.peek().allowed, true);
            } finally {
                (Date as { now: () => number }).now = originalNow;
            }
        }
    }
];

/** 执行所有检查用例并处理运行器自身的未预期错误 */
runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
