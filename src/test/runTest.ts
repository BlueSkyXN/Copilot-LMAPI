import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { SlidingWindowRateLimiter, TokenBucketRateLimiter } from '../utils/RateLimiter';

type ValidatorModule = {
    Validator: {
        validateChatCompletionRequest: (request: any, availableModels?: any[]) => any;
    };
    ValidationError: new (...args: any[]) => Error;
};

function loadValidatorModule(): ValidatorModule {
    const Module = require('module') as {
        _load: (request: string, parent: unknown, isMain: boolean) => unknown;
    };

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
        Module._load = originalLoad;
    }
}

const { Validator, ValidationError } = loadValidatorModule();

type CheckCase = {
    name: string;
    run: () => void | Promise<void>;
};

function repoRoot(): string {
    // out/test/runTest.js -> ../../
    return path.resolve(__dirname, '..', '..');
}

function readRepoFile(relativePath: string): string {
    const absolutePath = path.join(repoRoot(), relativePath);
    return fs.readFileSync(absolutePath, 'utf8');
}

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

function expectValidationError(fn: () => void, messagePattern: RegExp): void {
    assert.throws(fn, (error: unknown) => {
        return error instanceof ValidationError && messagePattern.test(error.message);
    });
}

const checks: CheckCase[] = [
    {
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
    {
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
    {
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
    {
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
    {
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

runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
