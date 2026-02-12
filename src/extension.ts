/**
 * VS Code 扩展入口点
 * Copilot-LMAPI 扩展
 */

import * as vscode from 'vscode';
import { CopilotServer } from './server/CopilotServer';
import { logger } from './utils/Logger';
import { COMMANDS, STATUS_BAR_PRIORITIES, HEALTH_CHECK } from './constants/Config';

let server: CopilotServer;
let statusBarItem: vscode.StatusBarItem;
let healthCheckTimer: NodeJS.Timeout;

/**
 * 扩展激活
 */
export function activate(context: vscode.ExtensionContext) {
    logger.info('Copilot-LMAPI extension activating');

    // 初始化服务器
    server = new CopilotServer();

    // 创建状态栏项目
    statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        STATUS_BAR_PRIORITIES.SERVER_STATUS
    );
    statusBarItem.command = COMMANDS.STATUS;
    context.subscriptions.push(statusBarItem);

    // 注册命令
    registerCommands(context);

    // 延迟检查 Copilot 可用性和自动启动 - 给 Copilot 足够初始化时间
    setTimeout(() => {
        // 检查 Copilot 可用性
        showCopilotSetupIfNeeded();

        // 如果配置了则自动启动
        const config = vscode.workspace.getConfiguration('copilot-lmapi');
        if (config.get<boolean>('autoStart', false)) {
            // 自动启动前先做健康检查
            checkCopilotHealth().then(hasCopilot => {
                if (hasCopilot) {
                    vscode.commands.executeCommand(COMMANDS.START);
                } else {
                    logger.warn('Auto-start skipped: GitHub Copilot is not available.');
                }
            });
        }
    }, HEALTH_CHECK.STARTUP_DELAY);

    // 设置定期健康检查
    healthCheckTimer = setInterval(async () => {
        try {
            const hasCopilot = await checkCopilotHealth();
            if (!hasCopilot && server.getState().isRunning) {
                logger.warn('Copilot access lost while server is running');
            }
        } catch (error) {
            logger.error('Health check failed:', error as Error);
        }
    }, HEALTH_CHECK.INTERVAL);

    // 将定时器添加到订阅中以便正确清理
    context.subscriptions.push({
        dispose: () => {
            if (healthCheckTimer) {
                clearInterval(healthCheckTimer);
            }
        }
    });

    // 更新状态栏
    updateStatusBar();

    logger.info('Copilot-LMAPI extension activated');
}

/**
 * 扩展停用
 */
export function deactivate() {
    logger.info('Copilot-LMAPI extension deactivating');

    if (healthCheckTimer) {
        clearInterval(healthCheckTimer);
    }

    if (server) {
        server.dispose();
    }

    if (statusBarItem) {
        statusBarItem.dispose();
    }

    logger.dispose();
}

/**
 * 注册所有扩展命令
 */
function registerCommands(context: vscode.ExtensionContext) {
    // 启动服务器命令
    const startCommand = vscode.commands.registerCommand(COMMANDS.START, async () => {
        try {
            if (server.getState().isRunning) {
                vscode.window.showWarningMessage('Server is already running');
                return;
            }

            await server.start();
            updateStatusBar();
            
        } catch (error) {
            const errorMessage = `Failed to start server: ${(error as Error).message}`;
            logger.error(errorMessage, error as Error);
            vscode.window.showErrorMessage(errorMessage);
        }
    });

    // 停止服务器命令
    const stopCommand = vscode.commands.registerCommand(COMMANDS.STOP, async () => {
        try {
            if (!server.getState().isRunning) {
                vscode.window.showWarningMessage('Server is not running');
                return;
            }

            await server.stop();
            updateStatusBar();
            
        } catch (error) {
            const errorMessage = `Failed to stop server: ${(error as Error).message}`;
            logger.error(errorMessage, error as Error);
            vscode.window.showErrorMessage(errorMessage);
        }
    });

    // 重启服务器命令
    const restartCommand = vscode.commands.registerCommand(COMMANDS.RESTART, async () => {
        try {
            await server.restart();
            updateStatusBar();
            vscode.window.showInformationMessage('Server restarted successfully');
            
        } catch (error) {
            const errorMessage = `Failed to restart server: ${(error as Error).message}`;
            logger.error(errorMessage, error as Error);
            vscode.window.showErrorMessage(errorMessage);
        }
    });

    // 状态命令
    const statusCommand = vscode.commands.registerCommand(COMMANDS.STATUS, async () => {
        showServerStatus();
    });

    // 注册所有命令
    context.subscriptions.push(
        startCommand,
        stopCommand,
        restartCommand,
        statusCommand
    );

}

/**
 * 更新状态栏显示
 */
function updateStatusBar() {
    const state = server.getState();

    if (state.isRunning) {
        statusBarItem.text = `$(server) LM API :${state.port}`;
        statusBarItem.tooltip = `LM API Server running on http://${state.host}:${state.port}\nClick for details`;
        statusBarItem.backgroundColor = undefined; // 默认（绿色）
    } else {
        statusBarItem.text = `$(server) LM API (stopped)`;
        statusBarItem.tooltip = 'LM API Server is stopped\nClick to start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }

    statusBarItem.show();
}

/**
 * 显示详细服务器状态
 */
async function showServerStatus() {
    const state = server.getState();
    const config = server.getConfig();

    if (state.isRunning) {
        const uptime = state.startTime ? Math.floor((Date.now() - state.startTime.getTime()) / 1000) : 0;
        const uptimeStr = formatUptime(uptime);

        const items = [
            {
                label: 'Stop Server',
                description: 'Stop the OpenAI API server',
                action: 'stop'
            },
            {
                label: 'Restart Server',
                description: 'Restart the OpenAI API server',
                action: 'restart'
            },
            {
                label: 'Show Logs',
                description: 'Open the extension logs',
                action: 'logs'
            },
            {
                label: 'Copy API URL',
                description: `http://${state.host}:${state.port}`,
                action: 'copy-url'
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'LM API Server Status',
            placeHolder: `Running on http://${state.host}:${state.port} | Uptime: ${uptimeStr} | Requests: ${state.requestCount}`
        });

        if (selected) {
            await handleStatusAction(selected.action);
        }
    } else {
        const items = [
            {
                label: 'Start Server',
                description: `Start on http://${config.host}:${config.port}`,
                action: 'start'
            },
            {
                label: 'Configure',
                description: 'Open extension settings',
                action: 'configure'
            },
            {
                label: 'Show Logs',
                description: 'Open the extension logs',
                action: 'logs'
            }
        ];

        const selected = await vscode.window.showQuickPick(items, {
            title: 'LM API Server Status',
            placeHolder: 'Server is stopped'
        });

        if (selected) {
            await handleStatusAction(selected.action);
        }
    }
}

/**
 * 处理状态面板操作
 */
async function handleStatusAction(action: string) {
    switch (action) {
        case 'start':
            await vscode.commands.executeCommand(COMMANDS.START);
            break;
        case 'stop':
            await vscode.commands.executeCommand(COMMANDS.STOP);
            break;
        case 'restart':
            await vscode.commands.executeCommand(COMMANDS.RESTART);
            break;
        case 'logs':
            logger.show();
            break;
        case 'configure':
            await vscode.commands.executeCommand('workbench.action.openSettings', 'copilot-lmapi');
            break;
        case 'copy-url':
            const state = server.getState();
            const url = `http://${state.host}:${state.port}`;
            await vscode.env.clipboard.writeText(url);
            vscode.window.showInformationMessage(`Copied ${url} to clipboard`);
            break;
    }
}

/**
 * 将运行时间格式化为可读格式
 */
function formatUptime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m ${remainingSeconds}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${remainingSeconds}s`;
    } else {
        return `${remainingSeconds}s`;
    }
}

/**
 * Copilot 可用性健康检查
 */
async function checkCopilotHealth(): Promise<boolean> {
    try {
        const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        return models.length > 0;
    } catch (error) {
        logger.warn('Copilot health check failed', { error: (error as Error).message });
        return false;
    }
}

/**
 * 如需要则显示 Copilot 设置说明
 */
async function showCopilotSetupIfNeeded() {
    const hasCopilot = await checkCopilotHealth();
    
    if (!hasCopilot) {
        const action = await vscode.window.showWarningMessage(
            'GitHub Copilot is not available. The extension requires an active Copilot subscription.',
            'Learn More',
            'Dismiss'
        );

        if (action === 'Learn More') {
            vscode.env.openExternal(vscode.Uri.parse('https://github.com/features/copilot'));
        }
    }
}