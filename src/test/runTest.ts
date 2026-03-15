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
        /** 验证 ModelDiscoveryService 改为基于 LMAPI 直出字段与运行时观测，而非内置 registry */
        name: 'ModelDiscoveryService uses LMAPI direct fields instead of registry overlays',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('const runtimeCapabilities = (vsCodeModel as RuntimeLanguageModelChat).capabilities;') &&
                content.includes('const proposedToolState = this.toSupportState(runtimeCapabilities?.supportsToolCalling);') &&
                content.includes("toolSupportSource = observedToolState"),
                'supportsTools should derive from runtime LMAPI capability surfaces and prior observations instead of a hardcoded default'
            );
            assert.ok(
                content.includes('displayName: vsCodeModel.name') &&
                content.includes("visionSupportSource = proposedVisionState === 'supported' && !canBridgeTransportNativeImages") &&
                content.includes("'runtime-capability-present-but-bridge-lacks-image-part-transport'") &&
                !content.includes('lookupOfficialModelMetadata') &&
                !content.includes('this.applyOfficialMetadata('),
                'Model discovery should be based on live LMAPI fields and must not use embedded registry overlays'
            );
            assert.ok(
                !content.includes('supportsFunctionCalling'),
                'ModelDiscoveryService should not reference supportsFunctionCalling'
            );
        }
    },
    {
        /** 验证 ModelDiscoveryService 记录 LMAPI 直出能力面和权限信息 */
        name: 'ModelDiscoveryService logs LMAPI capability surface details',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('logger.debug(`LMAPI capability surface for ${vsCodeModel.id}:`, {') &&
                content.includes('canSendRequest: capabilities.canSendRequest') &&
                content.includes('toolSupportState') &&
                content.includes('visionSupportState') &&
                content.includes('runtimeCapabilities: {'),
                'Model discovery logs should expose live LMAPI fields, access state, and observed capability states'
            );
        }
    },
    {
        /** 验证 ModelDiscoveryService 不再用 heuristic 猜 vision/tools/reasoning 上限 */
        name: 'ModelDiscoveryService avoids heuristic model capability guesses',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                !content.includes('private evaluateToolCapability(') &&
                !content.includes('private evaluateVisionCapability(') &&
                !content.includes('maxInputTokens * 0.5'),
                'Model discovery should not keep heuristic capability probes or inferred output-token limits'
            );
            assert.ok(
                content.includes('canBridgeTransportNativeImages') &&
                content.includes('(vscode as any).LanguageModelDataPart') &&
                content.includes('supportsVision: effectiveVisionState === \'supported\'') &&
                content.includes('supportsMultimodal: effectiveVisionState === \'supported\''),
                'LMAPI-only discovery should detect DataPart at runtime to determine native image transport capability'
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
                content.includes('const discoveredModels = Array.from(nextModelCache.values());') &&
                content.includes('await this.updateModelPool(discoveredModels);') &&
                content.includes('this.modelCache = nextModelCache;'),
                'Discovery should deduplicate via cache before rebuilding the pool and replacing the cache'
            );
        }
    },
    {
        /** 验证 ModelDiscoveryService 会记录 selectChatModels 原始快照和重复 id 分组 */
        name: 'ModelDiscoveryService logs raw model snapshots and duplicates',
        run: () => {
            const content = readRepoFile('src/services/ModelDiscoveryService.ts');
            assert.ok(
                content.includes('this.logRawModelDiscoverySnapshot(allModels);') &&
                content.includes("logger.debug('VS Code LM raw model snapshot:'") &&
                content.includes("logger.debug('VS Code LM duplicate model ids detected:'"),
                'Discovery should log raw model snapshots and duplicate ids for debugging'
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
        /** 验证 CopilotServer 在 authToken 为空时关闭 HTTP 鉴权，并在请求时允许空认证 */
        name: 'CopilotServer disables auth when authToken is empty',
        run: () => {
            const content = readRepoFile('src/server/CopilotServer.ts');
            assert.ok(
                content.includes("authToken: config.get<string>('authToken', DEFAULT_CONFIG.authToken)") &&
                content.includes('if (!this.bearerToken) {') &&
                content.includes("return true;"),
                'Server should treat empty authToken as auth-disabled open mode'
            );
        }
    },
    {
        /** 验证 RequestHandler 会过滤并组装安全的 modelOptions 再发给 VS Code LM API */
        name: 'RequestHandler sanitizes model_options before LM request',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('const sanitizedModelOptions = this.buildModelOptions(requestData, requestLogger);') &&
                content.includes('requestOptions.modelOptions = sanitizedModelOptions;') &&
                content.includes('Dropping unsupported modelOptions before LM request'),
                'RequestHandler should sanitize modelOptions instead of blindly forwarding unknown keys'
            );
        }
    },
    {
        /** 验证 RequestHandler 在 modelOptions 兼容性错误时会去掉 modelOptions 重试 */
        name: 'RequestHandler retries modelOptions incompatibilities without modelOptions',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('withoutModelOptionsRequestOptions') &&
                content.includes('const likelyModelOptionsError = hasModelOptions && this.isLikelyModelOptionsError(error);') &&
                content.includes("label: 'without modelOptions'"),
                'RequestHandler should retry once without modelOptions when the runtime rejects them'
            );
            // 确保 isLikelyModelOptionsError 不会因泛化的 "invalid parameter" 误判
            assert.ok(
                !content.includes("message.includes('invalid parameter')") &&
                !content.includes("message.includes('unknown parameter')"),
                'isLikelyModelOptionsError should not use overly broad patterns that match generic parameter errors'
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
    {
        /** 验证 RequestHandler 会在流/聚合阶段的预头部失败时，去工具和 modelOptions 重试一次 */
        name: 'RequestHandler retries pre-header tool failures without tools',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('Tool-enabled LM stream failed before headers were sent, retrying once without tools') &&
                content.includes('Tool-enabled LM response processing failed before headers were sent, retrying once without tools') &&
                content.includes('const preHeaderFallbackOptions = this.withoutToolsRequestOptions('),
                'RequestHandler should retry once without tools and modelOptions when response processing fails before headers are sent'
            );
        }
    },
    {
        /** 验证 RequestHandler 会记录请求阶段的 tool 发送参数和失败分析 */
        name: 'RequestHandler logs request-time tool routing decisions',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes("requestLogger.debug('LM request with tool settings:'") &&
                content.includes("requestLogger.info('LM request compatibility failure analysis:'") &&
                content.includes('model: model.id'),
                'RequestHandler should log the chosen model and tool fallback analysis for debugging'
            );
        }
    },
    {
        /** 验证 RequestHandler 的流处理在响应头未发送前会向上抛错，并提供降级目录消息 */
        name: 'RequestHandler preserves pre-header stream fallback path',
        run: () => {
            const content = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                content.includes('throw error;') &&
                content.includes('if (res.headersSent && !res.writableEnded)') &&
                content.includes('Fallback tool catalog for this request.'),
                'Streaming handler should rethrow pre-header errors and fallback path should include a tool catalog'
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
    {
        /** 验证 Converter 不会因为 supportsVision=false 而拒绝 image_url，只会转成文本上下文继续发送 */
        name: 'Converter supports native DataPart image transport with text fallback',
        run: () => {
            const content = readRepoFile('src/utils/Converter.ts');
            // 验证运行时 DataPart 检测缓存
            assert.ok(
                content.includes('private static _dataPartCtor') &&
                content.includes('private static get DataPartCtor()') &&
                content.includes('(vscode as any).LanguageModelDataPart'),
                'Converter should have cached runtime detection for LanguageModelDataPart'
            );
            // 验证原生图片传输路径
            assert.ok(
                content.includes('DataPartCtor && url.startsWith(\'data:image/\')') &&
                content.includes('new DataPartCtor(new Uint8Array(binaryData), mimeType)'),
                'Converter should attempt native DataPart for base64 data URIs when available'
            );
            // 验证降级路径保留
            assert.ok(
                content.includes('const imageContent = await this.processImageContent(url)'),
                'Converter should fallback to text description when DataPart unavailable'
            );
        }
    },
    {
        /** 验证 Converter 在 /v1/models 中暴露 x_lmapi 扩展能力字段 */
        name: 'Converter enriches model list with x_lmapi metadata',
        run: () => {
            const content = readRepoFile('src/utils/Converter.ts');
            assert.ok(
                content.includes('x_lmapi: {') &&
                content.includes('metadata_source: model.metadataSource') &&
                content.includes('capability_states: {') &&
                content.includes('capability_sources: {') &&
                content.includes('limit_sources: {') &&
                content.includes('context_window_tokens: model.contextWindow') &&
                content.includes('x_lmapi.model_options'),
                'Model list response should expose live-known metadata plus state/source annotations via x_lmapi'
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
    },
    {
        /**
         * Converter.countTokensOfficial 存在且签名正确
         *
         * 验证 Converter 中包含公开静态方法 countTokensOfficial，
         * 接受 model + input 参数并返回 Promise<number>。
         */
        name: 'Converter exposes countTokensOfficial with fallback path',
        run: () => {
            const converterSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'utils', 'Converter.ts'),
                'utf-8'
            );
            // 验证公开方法存在
            assert.ok(
                converterSrc.includes('public static async countTokensOfficial('),
                'countTokensOfficial must be a public static async method'
            );
            // 验证接受 LanguageModelChat 模型参数
            assert.ok(
                converterSrc.includes('model: vscode.LanguageModelChat'),
                'countTokensOfficial must accept a LanguageModelChat model'
            );
            // 验证降级路径存在
            assert.ok(
                converterSrc.includes('estimateTokensFallback'),
                'countTokensOfficial must have estimateTokensFallback for graceful degradation'
            );
            // 验证 try-catch 保护（API 调用失败不应中断请求）
            assert.ok(
                converterSrc.includes('countTokens API call failed, falling back'),
                'countTokensOfficial must catch API errors and fall back'
            );
        }
    },
    {
        /**
         * RequestHandler 在 token 验证前先转换消息格式并使用精确计数
         *
         * 验证请求处理流水线中消息转换在 token 限制检查之前执行，
         * 且使用 countTokensOfficial 替代了粗略估算。
         */
        name: 'RequestHandler uses countTokensOfficial for prompt token validation',
        run: () => {
            const handlerSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'server', 'RequestHandler.ts'),
                'utf-8'
            );
            // 验证调用了 countTokensOfficial
            assert.ok(
                handlerSrc.includes('Converter.countTokensOfficial('),
                'RequestHandler must use Converter.countTokensOfficial for token counting'
            );
            // 验证 convertMessagesToVSCode 在 countTokensOfficial 之前执行
            const convertIdx = handlerSrc.indexOf('convertMessagesToVSCode(');
            const countIdx = handlerSrc.indexOf('countTokensOfficial(');
            assert.ok(
                convertIdx < countIdx,
                'Message conversion must happen before countTokensOfficial call'
            );
            // 验证 context.estimatedTokens 被精确值更新
            assert.ok(
                handlerSrc.includes('context.estimatedTokens = promptTokens'),
                'Must update context.estimatedTokens with precise countTokens result'
            );
        }
    },
    {
        /**
         * RequestHandler 对非流式响应使用精确 completion token 计数
         *
         * 验证非流式路径中使用 countTokensOfficial 计算 completion tokens
         * 并传给 createCompletionResponse。
         */
        name: 'RequestHandler uses precise completion tokens in non-streaming response',
        run: () => {
            const handlerSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'server', 'RequestHandler.ts'),
                'utf-8'
            );
            // 验证在 handleNonStreamingResponse 中使用了 countTokensOfficial
            const nonStreamIdx = handlerSrc.indexOf('handleNonStreamingResponse(');
            const afterNonStream = handlerSrc.substring(nonStreamIdx);
            assert.ok(
                afterNonStream.includes('preciseCompletionTokens'),
                'Non-streaming path must compute preciseCompletionTokens'
            );
            assert.ok(
                afterNonStream.includes('Converter.countTokensOfficial('),
                'Non-streaming path must call countTokensOfficial for completion tokens'
            );
        }
    },
    {
        /**
         * createCompletionResponse 接受可选的精确 completion token 参数
         *
         * 验证 createCompletionResponse 支持 preciseCompletionTokens 参数，
         * 并在提供时优先使用精确值。
         */
        name: 'Converter createCompletionResponse accepts precise token count',
        run: () => {
            const converterSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'utils', 'Converter.ts'),
                'utf-8'
            );
            assert.ok(
                converterSrc.includes('preciseCompletionTokens?: number'),
                'createCompletionResponse must accept optional preciseCompletionTokens'
            );
            // 验证优先使用精确值，降级到估算
            assert.ok(
                converterSrc.includes('preciseCompletionTokens ??'),
                'Must use nullish coalescing to prefer precise tokens over estimation'
            );
        }
    },
    {
        /**
         * RequestHandler 记录被忽略的 OpenAI 参数
         *
         * 验证 buildModelOptions 中检测并记录无法转发到 LMAPI 的参数（如 top_p, n, user）。
         */
        name: 'RequestHandler logs ignored OpenAI params not forwarded to LMAPI',
        run: () => {
            const handlerSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'server', 'RequestHandler.ts'),
                'utf-8'
            );
            // 验证对 top_p 的检测
            assert.ok(
                handlerSrc.includes("requestData.top_p !== undefined"),
                'buildModelOptions must detect top_p as an ignored param'
            );
            // 验证对 n 的检测（仅当 n != 1 时）
            assert.ok(
                handlerSrc.includes("requestData.n !== undefined && requestData.n !== 1"),
                'buildModelOptions must detect n>1 as an ignored param'
            );
            // 验证对 user 的检测
            assert.ok(
                handlerSrc.includes("requestData.user !== undefined"),
                'buildModelOptions must detect user as an ignored param'
            );
            // 验证有日志输出
            assert.ok(
                handlerSrc.includes('not forwarded to LMAPI'),
                'Must log that params are not forwarded'
            );
        }
    },
    {
        /**
         * disableTokenLimit 配置项控制 token 上限检查
         *
         * 验证 RequestHandler 中存在 disableTokenLimit 读取逻辑，
         * 且在开启时跳过 token 限制拒绝、仅输出警告日志。
         */
        name: 'RequestHandler supports disableTokenLimit config to bypass token check',
        run: () => {
            const handlerSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'server', 'RequestHandler.ts'),
                'utf-8'
            );
            // 验证读取配置
            assert.ok(
                handlerSrc.includes("get<boolean>('disableTokenLimit'"),
                'Must read disableTokenLimit from VS Code config'
            );
            // 验证跳过逻辑
            assert.ok(
                handlerSrc.includes('!disableTokenLimit && promptTokens > selectedModel.maxInputTokens'),
                'Must gate token limit rejection on disableTokenLimit being false'
            );
            // 验证超限时有警告日志
            assert.ok(
                handlerSrc.includes('token limit check is disabled'),
                'Must warn when exceeding limit with check disabled'
            );
            // 验证 Config.ts 有默认值
            const configSrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'constants', 'Config.ts'),
                'utf-8'
            );
            assert.ok(
                configSrc.includes('disableTokenLimit: false'),
                'DEFAULT_CONFIG must define disableTokenLimit as false'
            );
        }
    },
    {
        /**
         * ModelDiscoveryService 运行时 DataPart 检测
         *
         * 验证 canBridgeTransportNativeImages 不再硬编码为 false，
         * 而是通过运行时检测 LanguageModelDataPart 决定。
         */
        name: 'ModelDiscoveryService detects DataPart at runtime for vision support',
        run: () => {
            const discoverySrc = fs.readFileSync(
                path.join(repoRoot(), 'src', 'services', 'ModelDiscoveryService.ts'),
                'utf-8'
            );
            // 不应再硬编码 canBridgeTransportNativeImages = false
            assert.ok(
                !discoverySrc.includes('const canBridgeTransportNativeImages = false'),
                'Must NOT hardcode canBridgeTransportNativeImages = false'
            );
            // 应有运行时检测逻辑
            assert.ok(
                discoverySrc.includes('(vscode as any).LanguageModelDataPart') &&
                discoverySrc.includes('canBridgeTransportNativeImages'),
                'Must detect LanguageModelDataPart at runtime to determine bridge transport capability'
            );
        }
    },
    {
        /**
         * ThinkingPart 运行时检测与 reasoning_content 支持
         *
         * 验证 Converter 有 ThinkingPart 检测、流式/非流式均处理推理内容，
         * OpenAI 类型定义包含 reasoning_content 字段。
         */
        name: 'Converter supports ThinkingPart as reasoning_content in responses',
        run: () => {
            const converterSrc = readRepoFile('src/utils/Converter.ts');
            // 运行时检测
            assert.ok(
                converterSrc.includes('private static _thinkingPartCtor') &&
                converterSrc.includes('private static get ThinkingPartCtor()') &&
                converterSrc.includes('(vscode as any).LanguageModelThinkingPart'),
                'Converter must have cached runtime detection for LanguageModelThinkingPart'
            );
            // 流式处理
            assert.ok(
                converterSrc.includes('delta.reasoning_content = thinkingText'),
                'Streaming must emit ThinkingPart as reasoning_content in delta'
            );
            // 非流式处理
            assert.ok(
                converterSrc.includes('reasoningContent') &&
                converterSrc.includes('message.reasoning_content = reasoningContent'),
                'Non-streaming must include reasoning_content in completion message'
            );
            // OpenAI 类型
            const typesSrc = readRepoFile('src/types/OpenAI.ts');
            assert.ok(
                typesSrc.includes('reasoning_content?: string') &&
                typesSrc.includes('reasoning_tokens?: number'),
                'OpenAI types must define reasoning_content and reasoning_tokens fields'
            );
        }
    },
    {
        /**
         * stream_options.include_usage 支持
         *
         * 验证类型定义包含 stream_options，Validator 校验流式选项，
         * Converter 在启用时发送含 usage 的最终 chunk，RequestHandler 传递 includeUsage。
         */
        name: 'Streaming response supports stream_options.include_usage for token reporting',
        run: () => {
            // 类型定义
            const typesSrc = readRepoFile('src/types/OpenAI.ts');
            assert.ok(
                typesSrc.includes('stream_options?') &&
                typesSrc.includes('include_usage?: boolean'),
                'OpenAI types must define stream_options with include_usage field'
            );
            assert.ok(
                typesSrc.includes('usage?: OpenAIUsage | null'),
                'OpenAIStreamResponse must have optional usage field'
            );
            // Validator 校验
            const validatorSrc = readRepoFile('src/utils/Validator.ts');
            assert.ok(
                validatorSrc.includes('validateStreamOptions') &&
                validatorSrc.includes('stream_options.include_usage must be a boolean'),
                'Validator must validate stream_options.include_usage as boolean'
            );
            // Converter 流末尾 usage chunk
            const converterSrc = readRepoFile('src/utils/Converter.ts');
            assert.ok(
                converterSrc.includes('includeUsage') &&
                converterSrc.includes('choices: []') &&
                converterSrc.includes('completionTextLength'),
                'Converter must emit usage-only chunk with empty choices when includeUsage is true'
            );
            // RequestHandler 传递
            const handlerSrc = readRepoFile('src/server/RequestHandler.ts');
            assert.ok(
                handlerSrc.includes('includeUsage') &&
                handlerSrc.includes('stream_options?.include_usage'),
                'RequestHandler must extract and pass includeUsage from stream_options'
            );
        }
    },
    {
        /**
         * OpenAI 兼容错误响应格式
         *
         * 验证 CopilotServer 和 Converter 均使用标准 { error: { message, type, param, code } } 格式，
         * 不包含非标准字段（timestamp、requestId 作为顶级字段）。
         */
        name: 'Error responses use OpenAI-compatible format with proper type mapping',
        run: () => {
            const serverSrc = readRepoFile('src/server/CopilotServer.ts');
            // CopilotServer 导入 ERROR_CODES
            assert.ok(
                serverSrc.includes('ERROR_CODES'),
                'CopilotServer must import ERROR_CODES for proper error type mapping'
            );
            // mapStatusToErrorType 方法存在
            assert.ok(
                serverSrc.includes('mapStatusToErrorType') &&
                serverSrc.includes('ERROR_CODES.INVALID_REQUEST') &&
                serverSrc.includes('ERROR_CODES.AUTHENTICATION_ERROR') &&
                serverSrc.includes('ERROR_CODES.RATE_LIMIT_ERROR'),
                'CopilotServer must map HTTP status codes to OpenAI error types'
            );
            // sendError 使用标准格式: param: null, code: null
            assert.ok(
                serverSrc.includes('param: null') &&
                serverSrc.includes('code: null'),
                'CopilotServer sendError must use OpenAI format with null param and code'
            );
            // 不再使用非标准字段
            assert.ok(
                !serverSrc.includes("type: 'server_error'") &&
                !serverSrc.includes('code: statusCode'),
                'CopilotServer must not use legacy non-standard error fields'
            );
            // Converter.createErrorResponse 也输出 null 而非 undefined
            const converterSrc = readRepoFile('src/utils/Converter.ts');
            assert.ok(
                converterSrc.includes('param: param ?? null') &&
                converterSrc.includes('code: code ?? null'),
                'Converter createErrorResponse must default absent fields to null per OpenAI spec'
            );
        }
    }
];

/** 执行所有检查用例并处理运行器自身的未预期错误 */
runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
