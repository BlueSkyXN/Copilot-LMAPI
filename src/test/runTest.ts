import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

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
            assert.ok(
                content.includes("if (!res.headersSent) {") && content.includes("res.writeHead(HTTP_STATUS.OK, SSE_HEADERS);"),
                'Streaming handler should defer SSE header emission until first chunk'
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
    }
];

runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
