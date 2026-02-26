/**
 * @module extension
 * @description VS Code 扩展入口点 -- Copilot-LMAPI 扩展的生命周期管理器
 *
 * 职责:
 *   1. 扩展激活 (activate) 与停用 (deactivate) 生命周期处理
 *   2. CopilotServer 实例的创建、启动、停止与资源释放
 *   3. VS Code 命令注册: 启动 / 停止 / 重启 / 查看状态
 *   4. 状态栏 (StatusBarItem) 的创建与实时更新
 *   5. GitHub Copilot 可用性的首次检查与定期健康检查
 *   6. 自动启动逻辑 (在 Copilot 就绪后根据配置决定是否自启)
 *
 * 架构位置:
 *   本模块是整个扩展的唯一入口, VS Code 通过 package.json 中的
 *   "main" 字段定位到编译后的此文件, 并在激活事件触发时调用 activate()。
 *   它持有 CopilotServer 单例, 并通过 VS Code API 向用户暴露操作界面。
 *
 * 关键依赖:
 *   - vscode           -- VS Code 扩展宿主 API
 *   - CopilotServer    -- HTTP 服务器, 负责实际的 API 桥接
 *   - Logger           -- 集中日志 (OutputChannel)
 *   - Config 常量      -- 命令 ID、状态栏优先级、健康检查间隔等
 *
 * 设计要点:
 *   - 使用 setTimeout 延迟首次健康检查, 确保 Copilot 扩展有足够时间初始化
 *   - 定时器与 StatusBarItem 均通过 context.subscriptions 注册,
 *     保证扩展停用时被 VS Code 自动 dispose
 *   - 所有命令回调捕获异常并通过 VS Code 通知展示, 不会导致扩展崩溃
 *
 * ═══════════════════════════════════════════════════════════════
 * 函数/类清单 (Function/Class Index)
 * ═══════════════════════════════════════════════════════════════
 *
 * 1. activate(context: vscode.ExtensionContext): void
 *    - 功能说明: 扩展激活入口, 由 VS Code 在激活事件触发时调用
 *    - 输入参数: context — vscode.ExtensionContext, 扩展上下文 (订阅、存储路径等)
 *    - 返回值: void
 *    - 关键变量: server (CopilotServer 单例), statusBarItem (状态栏组件)
 *
 * 2. deactivate(): void
 *    - 功能说明: 扩展停用, 释放服务器与相关资源
 *    - 输入参数: 无
 *    - 返回值: void
 *
 * 3. registerCommands(context: vscode.ExtensionContext): void
 *    - 功能说明: 注册 VS Code 命令 (启动/停止/重启/状态查看)
 *    - 输入参数: context — vscode.ExtensionContext, 用于将命令注册到 subscriptions
 *    - 返回值: void
 *    - 关键变量: COMMANDS 常量中定义的命令 ID
 *
 * 4. updateStatusBar(): void
 *    - 功能说明: 根据服务器当前状态更新状态栏图标与文字
 *    - 输入参数: 无
 *    - 返回值: void
 *    - 关键变量: statusBarItem (StatusBarItem 实例)
 *
 * 5. showServerStatus(): Promise<void>
 *    - 功能说明: 显示服务器状态的 QuickPick 菜单, 包含运行信息与操作项
 *    - 输入参数: 无
 *    - 返回值: Promise<void>
 *
 * 6. handleStatusAction(action: string): Promise<void>
 *    - 功能说明: 处理状态菜单中用户选择的操作 (启动/停止/重启/复制地址等)
 *    - 输入参数: action — string, 用户选择的操作标识
 *    - 返回值: Promise<void>
 *
 * 7. formatUptime(seconds: number): string
 *    - 功能说明: 将秒数格式化为可读的运行时间字符串 (如 "2h 30m 15s")
 *    - 输入参数: seconds — number, 运行秒数
 *    - 返回值: string, 格式化后的时间字符串
 *
 * 8. checkCopilotHealth(): Promise<boolean>
 *    - 功能说明: 检查 GitHub Copilot 扩展是否可用并正常工作
 *    - 输入参数: 无
 *    - 返回值: Promise<boolean>, true 表示 Copilot 可用
 *
 * 9. showCopilotSetupIfNeeded(): Promise<void>
 *    - 功能说明: 若 Copilot 不可用, 显示设置引导通知帮助用户安装/登录
 *    - 输入参数: 无
 *    - 返回值: Promise<void>
 */

import * as vscode from 'vscode';
import { CopilotServer } from './server/CopilotServer';
import { logger } from './utils/Logger';
import { COMMANDS, STATUS_BAR_PRIORITIES, HEALTH_CHECK } from './constants/Config';

/** CopilotServer 单例, 在 activate() 中初始化 */
let server: CopilotServer;
/** 状态栏项, 显示服务器运行状态与端口信息 */
let statusBarItem: vscode.StatusBarItem;
/** 定期健康检查定时器, 用于监控 Copilot 可用性 */
let healthCheckTimer: NodeJS.Timeout;

/**
 * 扩展激活入口 -- VS Code 在匹配激活事件时调用此函数
 *
 * 执行顺序:
 *   1. 创建 CopilotServer 实例
 *   2. 创建状态栏项并绑定状态查看命令
 *   3. 注册全部 VS Code 命令
 *   4. 延迟执行 Copilot 可用性检查与自动启动逻辑
 *   5. 启动定期健康检查定时器
 *   6. 更新状态栏为初始状态
 *
 * @param context - VS Code 扩展上下文, 用于注册可释放资源 (subscriptions)
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
 * 扩展停用 -- VS Code 在扩展卸载或窗口关闭时调用
 *
 * 按依赖倒序释放资源: 定时器 -> 服务器 -> 状态栏 -> 日志
 * 确保所有后台连接和系统资源被正确清理
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
 * 注册所有扩展命令到 VS Code 命令系统
 *
 * 注册的命令:
 *   - copilot-lmapi.start   -- 启动 HTTP 服务器
 *   - copilot-lmapi.stop    -- 停止 HTTP 服务器
 *   - copilot-lmapi.restart -- 重启 HTTP 服务器
 *   - copilot-lmapi.status  -- 显示服务器状态快捷菜单
 *
 * 每个命令回调内部都包含异常捕获, 错误通过 VS Code 通知展示给用户。
 *
 * @param context - VS Code 扩展上下文, 命令注册后推入 subscriptions 以便自动释放
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
 * 根据服务器当前状态更新状态栏的文本、提示和背景色
 *
 * 运行中: 显示端口号, 默认背景色
 * 已停止: 显示 "(stopped)", 警告色背景
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
 * 通过 QuickPick 菜单显示详细的服务器状态, 并提供操作选项
 *
 * 运行中时: 显示运行时间、请求计数, 提供停止/重启/日志/复制URL 操作
 * 已停止时: 提供启动/配置/日志 操作
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
 * 处理用户在状态 QuickPick 菜单中选择的操作
 *
 * @param action - 用户选择的操作标识:
 *   'start' | 'stop' | 'restart' | 'logs' | 'configure' | 'copy-url'
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
 * 将运行时间 (秒) 格式化为人类可读的字符串
 *
 * @param seconds - 运行时间总秒数
 * @returns 格式化字符串, 如 "2h 15m 30s"、"5m 10s" 或 "42s"
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
 * 检查 GitHub Copilot 语言模型是否可用
 *
 * 通过 vscode.lm.selectChatModels() 查询 vendor 为 'copilot' 的模型,
 * 若返回非空数组则认为 Copilot 可用。
 *
 * @returns 如果至少发现一个 Copilot 模型则返回 true, 否则返回 false
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
 * 检测 Copilot 是否可用, 若不可用则向用户展示引导提示
 *
 * 在扩展激活后的延迟检查阶段调用, 帮助用户了解需要订阅 Copilot 服务。
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