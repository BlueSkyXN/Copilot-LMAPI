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
    }
];

runChecks(checks).catch((error) => {
    console.error('Unexpected test runner error');
    console.error(error);
    process.exitCode = 1;
});
