import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

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
        name: 'WebConsole module exports generateConsoleHTML and getEndpointList',
        run: () => {
            const content = readRepoFile('src/server/WebConsole.ts');
            assert.ok(
                content.includes('export function generateConsoleHTML'),
                'WebConsole should export generateConsoleHTML'
            );
            assert.ok(
                content.includes('export function getEndpointList'),
                'WebConsole should export getEndpointList'
            );
        }
    },
    {
        name: 'WebConsole HTML contains essential dashboard elements',
        run: () => {
            const content = readRepoFile('src/server/WebConsole.ts');
            assert.ok(
                content.includes('Copilot LMAPI Console'),
                'Console HTML should contain the title'
            );
            assert.ok(
                content.includes('API_ENDPOINTS.CHAT_COMPLETIONS'),
                'Console should reference chat completions endpoint'
            );
            assert.ok(
                content.includes('API_ENDPOINTS.MODELS'),
                'Console should reference models endpoint'
            );
            assert.ok(
                content.includes('API_ENDPOINTS.HEALTH'),
                'Console should reference health endpoint'
            );
            assert.ok(
                content.includes('escapeHtml'),
                'Console should use HTML escaping for security'
            );
        }
    },
    {
        name: 'CopilotServer routes root path to web console',
        run: () => {
            const content = readRepoFile('src/server/CopilotServer.ts');
            assert.ok(
                content.includes("import { generateConsoleHTML, getEndpointList } from './WebConsole'"),
                'CopilotServer should import WebConsole functions'
            );
            assert.ok(
                content.includes('case API_ENDPOINTS.CONSOLE:'),
                'CopilotServer should route CONSOLE endpoint'
            );
            assert.ok(
                content.includes('handleConsole'),
                'CopilotServer should have handleConsole method'
            );
        }
    },
    {
        name: 'Config defines CONSOLE endpoint and HTML content type',
        run: () => {
            const content = readRepoFile('src/constants/Config.ts');
            assert.ok(
                content.includes("CONSOLE: '/'"),
                'API_ENDPOINTS should define CONSOLE as /'
            );
            assert.ok(
                content.includes("HTML: 'text/html'"),
                'CONTENT_TYPES should define HTML type'
            );
        }
    }
];
runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
