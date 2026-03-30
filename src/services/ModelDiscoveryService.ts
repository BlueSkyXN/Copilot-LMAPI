/**
 * @module ModelDiscoveryService
 * @description 模型发现服务 - 动态发现、测试和管理所有可用的 VS Code 语言模型。
 *
 * 本模块是服务层（services/）的核心组件，位于 RequestHandler 与 VS Code LM API 之间，
 * 负责在运行时动态扫描和管理所有可用的 Copilot 语言模型，不依赖任何硬编码的模型列表。
 *
 * 架构位置：
 *   RequestHandler --> ModelDiscoveryService --> vscode.lm.selectChatModels()
 *
 * 关键依赖：
 *   - vscode.lm API：通过 selectChatModels() 获取运行时可用模型
 *   - ModelCapabilities / ModelPool / ModelMetrics：类型定义来自 types/ModelCapabilities.ts
 *   - Logger：统一日志，支持请求级别追踪
 *
 * 设计要点：
 *   1. 零硬编码 - 所有模型信息均通过 vscode.lm API 动态获取
 *   2. 模型池分级管理 - 按能力评分将模型分为 primary / secondary / fallback / unhealthy 四级
 *   3. 后台定时刷新 - 通过 setInterval 定期执行模型发现与健康检查
 *   4. 事件驱动通知 - 通过 vscode.EventEmitter 发布模型发现、健康变化、池刷新等事件
 *   5. 性能指标追踪 - 为每个模型维护请求计数、响应时间、负载等运行时指标
 *
 * 函数/类清单：
 *
 * 【ModelDiscoveryService（类）】
 *   功能：动态发现、测试和管理所有可用的 VS Code 语言模型
 *   关键属性：modelPool (ModelPool), modelMetrics (Map<string, ModelMetrics>),
 *            modelCache (Map<string, ModelCapabilities>), config (ModelDiscoveryConfig),
 *            onModelEvent (vscode.Event<ModelEvent>)
 *
 *   1. constructor(config?: Partial<ModelDiscoveryConfig>)
 *      - 功能：初始化配置、模型池和后台服务
 *      - 输入：config — 可选的部分发现配置
 *      - 输出：ModelDiscoveryService 实例
 *
 *   2. discoverAllModels(): Promise<ModelCapabilities[]>
 *      - 功能：发现所有可用模型（带并发互斥锁，防止多个调用竞态写入缓存）
 *      - 输入：无
 *      - 输出：Promise<ModelCapabilities[]> — 所有已发现模型的能力列表
 *      - 关键变量：activeDiscoveryPromise — 进行中的发现 Promise，用于并发复用
 *
 *   2b. executeDiscovery(): Promise<ModelCapabilities[]>（私有）
 *      - 功能：模型发现的实际执行逻辑，由 discoverAllModels() 通过互斥锁调用
 *      - 输入：无
 *      - 输出：Promise<ModelCapabilities[]> — 所有已发现模型的能力列表
 *
 *   3. analyzeModelCapabilities(vsCodeModel: vscode.LanguageModelChat): Promise<ModelCapabilities>
 *      - 功能：分析单个模型的能力（视觉、工具调用、流式等）
 *      - 输入：vsCodeModel — VS Code 语言模型实例
 *      - 输出：Promise<ModelCapabilities> — 该模型的完整能力描述
 *
 *   4. testVisionCapability(model: vscode.LanguageModelChat): Promise<boolean>
 *      - 功能：测试模型是否支持视觉/图像输入
 *      - 输入：model — VS Code 语言模型实例
 *      - 输出：Promise<boolean> — 是否支持视觉能力
 *
 *   5. testToolCapability(model: vscode.LanguageModelChat): Promise<boolean>
 *      - 功能：测试模型是否支持工具/函数调用
 *      - 输入：model — VS Code 语言模型实例
 *      - 输出：Promise<boolean> — 是否支持工具调用
 *
 *   6. getCapabilityProbeText(model: vscode.LanguageModelChat): string
 *      - 功能：生成归一化的能力探测文本，用于缓存键
 *      - 输入：model — VS Code 语言模型实例
 *      - 输出：string — 归一化探测文本
 *
 *   7. inferAdvancedCapabilities(capabilities: ModelCapabilities): void
 *      - 功能：根据模型家族推理高级能力参数（如 token 上限）
 *      - 输入：capabilities — 模型能力对象（就地修改）
 *      - 输出：void
 *
 *   8. calculateCapabilityScore(model: ModelCapabilities): number
 *      - 功能：计算模型综合能力评分，用于模型池分级
 *      - 输入：model — 模型能力对象
 *      - 输出：number — 综合评分
 *
 *   9. updateModelPool(models: ModelCapabilities[]): Promise<void>
 *      - 功能：根据能力评分更新模型池的 primary/secondary/fallback/unhealthy 分级
 *      - 输入：models — 模型能力列表
 *      - 输出：Promise<void>
 *
 *   10. initializeModelMetrics(modelId: string): void
 *       - 功能：初始化指定模型的性能指标（请求计数、响应时间等）
 *       - 输入：modelId — 模型 ID
 *       - 输出：void
 *
 *   11. startBackgroundServices(): void
 *       - 功能：启动后台定时服务（模型发现刷新、健康检查）
 *       - 输入：无
 *       - 输出：void
 *
 *   12. performHealthChecks(): Promise<void>
 *       - 功能：对模型池中所有模型执行健康检查，更新健康状态
 *       - 输入：无
 *       - 输出：Promise<void>
 *
 *   13. getModelPool(): ModelPool
 *       - 功能：获取当前模型池快照
 *       - 输入：无
 *       - 输出：ModelPool — 模型池分级结构
 *
 *   14. getModel(modelId: string): ModelCapabilities | undefined
 *       - 功能：按模型 ID 获取模型能力
 *       - 输入：modelId — 模型 ID
 *       - 输出：ModelCapabilities | undefined
 *
 *   15. getAllModels(): ModelCapabilities[]
 *       - 功能：获取所有已发现模型的能力列表
 *       - 输入：无
 *       - 输出：ModelCapabilities[]
 *
 *   16. dispose(): void
 *       - 功能：释放所有资源（定时器、事件发射器等）
 *       - 输入：无
 *       - 输出：void
 */

import * as vscode from 'vscode';
import { 
    ModelCapabilities, 
    ModelMetrics, 
    ModelPool, 
    ModelEvent,
    DynamicModelConfig,
    ModelDiscoveryConfig
} from '../types/ModelCapabilities';
import { logger } from '../utils/Logger';

/**
 * 运行时模型能力扩展接口
 *
 * VS Code 运行时可能在 LanguageModelChat 对象上暴露 `capabilities` 属性，
 * 但其字段名因 API 版本不同而变化：
 *   - 旧版 proposed API: supportsToolCalling / supportsImageToText
 *   - 新版 stable API (1.110+): toolCalling / imageInput
 *     （对应 @types/vscode 中的 LanguageModelChatCapabilities）
 *
 * 本接口同时兼容两种命名，analyzeModelCapabilities 中取并集判断。
 */
interface RuntimeLanguageModelCapabilities {
    // -- 旧版 proposed 字段 --
    supportsToolCalling?: boolean;
    supportsImageToText?: boolean;
    editToolsHint?: readonly string[];
    // -- 新版 stable 字段 (对应 vscode.LanguageModelChatCapabilities) --
    /** @see vscode.LanguageModelChatCapabilities.toolCalling */
    toolCalling?: boolean | number;
    /** @see vscode.LanguageModelChatCapabilities.imageInput */
    imageInput?: boolean;
}

type RuntimeLanguageModelChat = vscode.LanguageModelChat & {
    capabilities?: RuntimeLanguageModelCapabilities;
};

/**
 * 模型发现服务类
 *
 * 负责动态发现所有可用的 VS Code 语言模型，分析其能力（视觉、工具调用、流式输出等），
 * 并将模型按能力评分组织到分级模型池中。同时提供后台定时刷新和健康检查机制，
 * 确保模型池始终反映最新的可用状态。
 *
 * 主要职责：
 * - 通过 vscode.lm.selectChatModels() 发现所有可用模型
 * - 分析每个模型的能力（视觉/工具/流式/多模态）
 * - 按能力评分将模型分配到 primary / secondary / fallback / unhealthy 池
 * - 后台定期刷新模型缓存和执行健康检查
 * - 维护每个模型的性能指标（请求数、响应时间、负载等）
 * - 通过事件机制通知外部订阅者模型状态变化
 */
export class ModelDiscoveryService {
    /** 模型池，按能力分级存储所有已发现的模型 */
    private modelPool: ModelPool;
    /** 模型性能指标映射表，键为模型 ID */
    private modelMetrics: Map<string, ModelMetrics>;
    /** 模型能力缓存映射表，键为模型 ID，用于快速查找 */
    private modelCache: Map<string, ModelCapabilities>;
    /** 模型事件发射器，用于发布模型发现、健康变化等事件 */
    private eventEmitter: vscode.EventEmitter<ModelEvent>;
    /** 服务配置，包含缓存刷新间隔、健康检查间隔等参数 */
    private config: ModelDiscoveryConfig;
    /** 来自 ExtensionContext 的语言模型访问状态接口（可选） */
    private accessInformation?: vscode.LanguageModelAccessInformation;
    /** 后台模型缓存定时刷新器 */
    private refreshTimer?: NodeJS.Timeout;
    /** 后台健康检查定时器 */
    private healthCheckTimer?: NodeJS.Timeout;
    /** 并发发现互斥锁：存储进行中的发现 Promise，防止多个 discoverAllModels 并发执行导致缓存竞态 */
    private activeDiscoveryPromise?: Promise<ModelCapabilities[]>;
    
    /** 模型事件的公开可订阅接口，外部可通过此属性监听模型状态变化 */
    public readonly onModelEvent: vscode.Event<ModelEvent>;
    
    /**
     * 构造函数 - 初始化模型发现服务
     *
     * 合并用户提供的配置与 VS Code 工作区设置中的默认配置，
     * 初始化空的模型池、指标映射和缓存，并启动后台刷新与健康检查定时器。
     *
     * @param config - 可选的部分配置覆盖，未提供的字段将使用 VS Code 设置中的默认值
     */
    constructor(
        config?: Partial<ModelDiscoveryConfig>,
        accessInformation?: vscode.LanguageModelAccessInformation
    ) {
        const vsCodeConfig = vscode.workspace.getConfiguration('copilot-lmapi');
        
        this.config = {
            enableCaching: true,
            cacheRefreshInterval: vsCodeConfig.get('modelCacheRefreshInterval', 300000), // 5 minutes default
            healthCheckInterval: vsCodeConfig.get('modelHealthCheckInterval', 600000),  // 10 minutes default
            capabilityTestTimeout: 5000, // 5 seconds
            enablePerformanceTracking: true,
            enableAutoFailover: true,
            ...config
        };
        
        this.modelPool = {
            primary: [],
            secondary: [],
            fallback: [],
            unhealthy: [],
            lastUpdated: new Date()
        };
        
        this.modelMetrics = new Map();
        this.modelCache = new Map();
        this.eventEmitter = new vscode.EventEmitter<ModelEvent>();
        this.onModelEvent = this.eventEmitter.event;
        this.accessInformation = accessInformation;
        
        this.startBackgroundServices();
    }
    
    /**
     * 发现所有可用模型
     *
     * 通过 vscode.lm.selectChatModels() 获取运行时所有可用的语言模型，
     * 逐一分析其能力特征，初始化性能指标，更新模型缓存和模型池。
     * 不设任何硬编码模型限制，支持 VS Code LM API 提供的所有模型。
     *
     * 处理流程：
     * 1. 调用 vscode.lm.selectChatModels() 获取全部模型列表
     * 2. 对每个模型调用 analyzeModelCapabilities() 分析能力
     * 3. 将分析结果写入缓存并初始化性能指标
     * 4. 触发 model_discovered 事件通知订阅者
     * 5. 调用 updateModelPool() 按能力评分重新组织模型池
     *
     * @returns 所有已发现且可用的模型能力列表
     * @throws 当模型发现过程整体失败时抛出错误
     */
    public async discoverAllModels(): Promise<ModelCapabilities[]> {
        // 并发互斥：如果已有发现流程在执行中，直接复用其 Promise 避免竞态写入 modelCache
        if (this.activeDiscoveryPromise) {
            logger.info('Model discovery already in progress, reusing existing promise');
            return this.activeDiscoveryPromise;
        }

        this.activeDiscoveryPromise = this.executeDiscovery();
        try {
            return await this.activeDiscoveryPromise;
        } finally {
            this.activeDiscoveryPromise = undefined;
        }
    }

    /**
     * 模型发现的实际执行逻辑（内部方法）
     *
     * 由 discoverAllModels() 调用，通过 activeDiscoveryPromise 互斥锁确保同一时间只有一个实例运行。
     *
     * @returns 所有已发现且可用的模型能力列表
     * @throws 当模型发现过程整体失败时抛出错误
     */
    private async executeDiscovery(): Promise<ModelCapabilities[]> {
        logger.info('Starting dynamic model discovery...');

        try {
            // 从 VS Code LM API 获取所有模型
            const allModels = await vscode.lm.selectChatModels();
            logger.info(`Found ${allModels.length} total models`);
            this.logRawModelDiscoverySnapshot(allModels);
            
            const nextModelCache = new Map<string, ModelCapabilities>();
            
            // 测试每个模型的能力
            for (const vsCodeModel of allModels) {
                try {
                    const capabilities = await this.analyzeModelCapabilities(vsCodeModel);
                    const existing = nextModelCache.get(capabilities.id);
                    if (existing) {
                        const preferred = this.selectPreferredModelVariant(existing, capabilities);
                        const replaced = preferred === capabilities;
                        nextModelCache.set(capabilities.id, preferred);
                        logger.debug('Deduplicated discovered model variant:', {
                            id: capabilities.id,
                            keptVendor: preferred.vendor,
                            keptVersion: preferred.version,
                            droppedVendor: replaced ? existing.vendor : capabilities.vendor,
                            droppedVersion: replaced ? existing.version : capabilities.version
                        });
                        continue;
                    }

                    nextModelCache.set(capabilities.id, capabilities);
                    
                } catch (error) {
                    logger.warn(`Failed to analyze model ${vsCodeModel.id}:`, { error: String(error) });
                }
            }

            const discoveredModels = Array.from(nextModelCache.values());

            for (const capabilities of discoveredModels) {
                this.initializeModelMetrics(capabilities.id);
                this.eventEmitter.fire({ type: 'model_discovered', model: capabilities });

                logger.info(`Model ${capabilities.id} discovered with capabilities:`, {
                    vision: capabilities.supportsVision,
                    visionState: capabilities.visionSupportState,
                    tools: capabilities.supportsTools,
                    toolState: capabilities.toolSupportState,
                    contextWindow: capabilities.contextWindow,
                    maxInputTokens: capabilities.maxInputTokens,
                    maxOutputTokens: capabilities.maxOutputTokens,
                    requestAccess: capabilities.canSendRequest,
                    metadataSource: capabilities.metadataSource
                });
            }
            
            // 更新模型池
            await this.updateModelPool(discoveredModels);
            this.modelCache = nextModelCache;
            
            logger.info(`Discovery complete! Found ${discoveredModels.length} usable models`);
            return discoveredModels;

        } catch (error) {
            logger.error('Model discovery failed:', error as Error);
            throw new Error(`Model discovery failed: ${error}`);
        }
    }

    /**
     * 输出 `selectChatModels()` 的原始快照和重复 id 分组，便于排查来源差异。
     */
    private logRawModelDiscoverySnapshot(models: readonly vscode.LanguageModelChat[]): void {
        const snapshot = models.map(model => ({
            id: model.id,
            family: model.family,
            vendor: model.vendor,
            version: model.version,
            maxInputTokens: model.maxInputTokens
        }));

        logger.debug('VS Code LM raw model snapshot:', { models: snapshot });

        const duplicateIds = Array.from(
            snapshot.reduce((groups, model) => {
                const group = groups.get(model.id) ?? [];
                group.push(model);
                groups.set(model.id, group);
                return groups;
            }, new Map<string, typeof snapshot>())
        )
            .filter(([, group]) => group.length > 1)
            .map(([id, group]) => ({
                id,
                entries: group
            }));

        if (duplicateIds.length > 0) {
            logger.debug('VS Code LM duplicate model ids detected:', { duplicateIds });
        }
    }
    
    /**
     * 分析单个模型的能力特征
     *
     * 从 VS Code LanguageModelChat 对象中提取基本信息（ID、厂商、版本、令牌上限等），
     * 然后分别测试该模型是否支持视觉输入和工具/函数调用，记录响应时间，
     * 最后通过智能推理补充高级能力参数。
     *
     * @param vsCodeModel - VS Code 语言模型聊天对象
     * @returns 完整的模型能力描述对象
     */
    private async analyzeModelCapabilities(vsCodeModel: vscode.LanguageModelChat): Promise<ModelCapabilities> {
        const startTime = Date.now();
        const existing = this.modelCache.get(vsCodeModel.id);
        const canSendRequest = this.accessInformation?.canSendRequest(vsCodeModel);
        const runtimeCapabilities = (vsCodeModel as RuntimeLanguageModelChat).capabilities;
        // 兼容新旧两套运行时能力字段名：
        //   旧版 proposed: supportsToolCalling / supportsImageToText
        //   新版 stable (1.110+): toolCalling / imageInput  (对应 LanguageModelChatCapabilities)
        const rawToolCalling = runtimeCapabilities?.supportsToolCalling
            ?? (runtimeCapabilities?.toolCalling !== undefined
                ? Boolean(runtimeCapabilities.toolCalling)
                : undefined);
        const rawImageInput = runtimeCapabilities?.supportsImageToText
            ?? runtimeCapabilities?.imageInput;
        const proposedToolState = this.toSupportState(rawToolCalling);
        const proposedVisionState = this.toSupportState(rawImageInput);
        const lmapiToolState = proposedToolState !== 'unknown' ? proposedToolState : undefined;
        const observedToolState = existing?.toolSupportSource === 'lmapi-observed-request'
            ? existing.toolSupportState
            : undefined;
        const toolSupportState = observedToolState ?? lmapiToolState ?? existing?.toolSupportState ?? 'unknown';
        const toolSupportSource = observedToolState
            ? 'lmapi-observed-request'
            : lmapiToolState
                ? 'lmapi-proposed-capabilities'
                : existing?.toolSupportSource ?? 'not-exposed-by-lmapi';
        // 运行时检测 LanguageModelDataPart 是否可用
        // @types/vscode 1.110+ 已将其列为 stable，但 engines.vscode ^1.92.0 仍需运行时兜底
        let canBridgeTransportNativeImages = false;
        try {
            canBridgeTransportNativeImages = typeof vscode.LanguageModelDataPart === 'function';
        } catch {
            // 保持 false — 老版本 VS Code 可能未导出此符号
        }
        const effectiveVisionState = proposedVisionState === 'supported' && !canBridgeTransportNativeImages
            ? 'unknown'
            : proposedVisionState;
        const visionSupportSource = proposedVisionState === 'supported' && !canBridgeTransportNativeImages
            ? 'runtime-capability-present-but-bridge-lacks-image-part-transport'
            : proposedVisionState !== 'unknown'
                ? 'lmapi-proposed-capabilities'
                : 'current-vscode-lmapi-user-message-parts';
        
        const capabilities: ModelCapabilities = {
            id: vsCodeModel.id,
            displayName: vsCodeModel.name,
            family: vsCodeModel.family,
            vendor: vsCodeModel.vendor,
            version: vsCodeModel.version,
            maxInputTokens: vsCodeModel.maxInputTokens,
            contextWindow: vsCodeModel.maxInputTokens,
            supportsVision: effectiveVisionState === 'supported',
            supportsTools: toolSupportState === 'supported',
            supportsStreaming: true,
            supportsMultimodal: effectiveVisionState === 'supported',
            toolSupportState,
            toolSupportSource,
            visionSupportState: effectiveVisionState,
            visionSupportSource,
            inputModalities: effectiveVisionState === 'supported' ? ['text', 'image'] : ['text'],
            outputModalities: ['text'],
            isHealthy: true,
            vsCodeModel: vsCodeModel,
            lastTestedAt: new Date(),
            canSendRequest: typeof canSendRequest === 'boolean' ? canSendRequest : undefined,
            metadataSource: existing?.metadataSource ?? 'lmapi-direct'
        };

        const responseTime = Date.now() - startTime;
        capabilities.responseTime = responseTime;

        logger.debug(`LMAPI capability surface for ${vsCodeModel.id}:`, {
            name: capabilities.displayName,
            vendor: capabilities.vendor,
            family: capabilities.family,
            version: capabilities.version,
            maxInputTokens: capabilities.maxInputTokens,
            canSendRequest: capabilities.canSendRequest,
            tools: {
                supported: capabilities.supportsTools,
                state: capabilities.toolSupportState,
                source: capabilities.toolSupportSource
            },
            vision: {
                supported: capabilities.supportsVision,
                state: capabilities.visionSupportState,
                source: capabilities.visionSupportSource
            },
            runtimeCapabilities: {
                supportsToolCalling: runtimeCapabilities?.supportsToolCalling,
                supportsImageToText: runtimeCapabilities?.supportsImageToText,
                toolCalling: runtimeCapabilities?.toolCalling,
                imageInput: runtimeCapabilities?.imageInput,
                editToolsHint: runtimeCapabilities?.editToolsHint
            }
        });
        
        return capabilities;
    }

    private toSupportState(
        value: boolean | undefined
    ): 'supported' | 'unsupported' | 'unknown' {
        if (value === true) {
            return 'supported';
        }
        if (value === false) {
            return 'unsupported';
        }
        return 'unknown';
    }

    /**
     * 根据 vendor/version/maxInputTokens 选择同一 id 的首选运行时模型对象。
     */
    private selectPreferredModelVariant(
        existing: ModelCapabilities,
        candidate: ModelCapabilities
    ): ModelCapabilities {
        return this.getModelVariantPriority(candidate) > this.getModelVariantPriority(existing)
            ? candidate
            : existing;
    }

    private getModelVariantPriority(model: ModelCapabilities): number {
        const vendor = model.vendor?.toLowerCase() ?? '';
        const vendorPriority =
            vendor === 'copilot' ? 300 :
            vendor === 'claude-code' ? 200 :
            vendor === 'copilotcli' ? 100 :
            0;

        return vendorPriority + (model.version ? 10 : 0) + model.maxInputTokens / 1000;
    }

    /**
     * 计算模型的综合能力评分
     *
     * 根据多维度指标为模型生成数值评分，用于模型池内的排序。
     * 评分维度包括：
     * - 令牌容量（maxInputTokens / 1000）
     * - 已观测到可用的工具调用（+40 分）
     * - 已获得请求权限（+20 分）
     * - 健康/成功率（successRate * 100）
     *
     * @param model - 待评分的模型能力对象
     * @returns 综合能力评分（数值越大越优先）
     */
    private calculateCapabilityScore(model: ModelCapabilities): number {
        let score = 0;
        
        score += model.maxInputTokens / 1000; // 令牌容量
        if (model.supportsTools) {
            score += 40;
        }
        if (model.canSendRequest === true) {
            score += 20;
        }
        score += (model.successRate || 0.5) * 100; // 健康评分
        
        return score;
    }
    
    /**
     * 更新模型池的分级组织结构
     *
     * 将所有已发现的模型按健康状态和能力特征分配到四个池中：
     * - primary：已观测到工具调用可用，或超大上下文窗口的模型
     * - secondary：已确认可请求，或上下文窗口超过 64K 的模型
     * - fallback：其他健康的基础模型
     * - unhealthy：健康检查未通过的模型
     *
     * 每个池内按 calculateCapabilityScore() 降序排列，
     * 更新完成后触发 pool_refreshed 事件。
     *
     * @param models - 本次发现的所有模型能力列表
     */
    private async updateModelPool(models: ModelCapabilities[]): Promise<void> {
        // 重置池
        this.modelPool = {
            primary: [],
            secondary: [],
            fallback: [],
            unhealthy: [],
            lastUpdated: new Date()
        };
        
        // 按健康状态和能力组织模型
        for (const model of models) {
            if (!model.isHealthy) {
                this.modelPool.unhealthy.push(model);
            } else if (model.supportsTools || model.maxInputTokens > 128000) {
                this.modelPool.primary.push(model);
            } else if (model.canSendRequest !== false || model.maxInputTokens > 64000) {
                this.modelPool.secondary.push(model);
            } else {
                this.modelPool.fallback.push(model);
            }
        }
        
        // 按能力评分对每个池进行排序
        this.modelPool.primary.sort((a, b) => this.calculateCapabilityScore(b) - this.calculateCapabilityScore(a));
        this.modelPool.secondary.sort((a, b) => this.calculateCapabilityScore(b) - this.calculateCapabilityScore(a));
        this.modelPool.fallback.sort((a, b) => this.calculateCapabilityScore(b) - this.calculateCapabilityScore(a));
        
        // 发出池更新事件
        this.eventEmitter.fire({ type: 'pool_refreshed', pool: this.modelPool });
        
        logger.info(`Model pool updated:`, {
            primary: this.modelPool.primary.length,
            secondary: this.modelPool.secondary.length,
            fallback: this.modelPool.fallback.length,
            unhealthy: this.modelPool.unhealthy.length
        });
    }
    
    /**
     * 为指定模型初始化性能指标
     *
     * 若该模型尚未在指标映射表中注册，则创建一条初始指标记录，
     * 所有计数器归零，lastUsed 设为当前时间。
     * 已存在的指标记录不会被覆盖，保留历史数据。
     *
     * @param modelId - 模型唯一标识符
     */
    private initializeModelMetrics(modelId: string): void {
        if (!this.modelMetrics.has(modelId)) {
            this.modelMetrics.set(modelId, {
                totalRequests: 0,
                successfulRequests: 0,
                failedRequests: 0,
                averageResponseTime: 0,
                lastUsed: new Date(),
                currentLoad: 0
            });
        }
    }
    
    /**
     * 启动后台定时服务
     *
     * 根据配置启动两个独立的定时任务：
     * 1. 模型缓存刷新定时器 - 按 cacheRefreshInterval 间隔重新执行模型发现
     * 2. 健康检查定时器 - 按 healthCheckInterval 间隔对所有活跃模型执行健康检查
     *
     * 定时器错误不会导致服务崩溃，仅记录日志。
     */
    private startBackgroundServices(): void {
        if (this.config.enableCaching) {
            this.refreshTimer = setInterval(() => {
                this.discoverAllModels().catch(error => {
                    logger.error('Background model refresh failed:', error);
                });
            }, this.config.cacheRefreshInterval);
        }
        
        if (this.config.enablePerformanceTracking) {
            this.healthCheckTimer = setInterval(() => {
                this.performHealthChecks().catch(error => {
                    logger.error('Health check failed:', error);
                });
            }, this.config.healthCheckInterval);
        }
    }
    
    /**
     * 对所有活跃模型执行健康检查
     *
     * 遍历 primary、secondary、fallback 池中的所有模型，
     * 通过检查 maxInputTokens 是否大于 0 判断模型是否仍然可用。
     * 当模型健康状态发生变化时，触发 model_health_changed 事件，
     * 以便外部订阅者及时响应（如触发故障转移）。
     */
    private async performHealthChecks(): Promise<void> {
        logger.debug('Performing model health checks...');
        
        const allModels = [...this.modelPool.primary, ...this.modelPool.secondary, ...this.modelPool.fallback];
        
        for (const model of allModels) {
            try {
                // 简单健康检查 - 尝试获取模型信息
                const isHealthy = model.vsCodeModel.maxInputTokens > 0;
                
                if (model.isHealthy !== isHealthy) {
                    model.isHealthy = isHealthy;
                    this.eventEmitter.fire({ 
                        type: 'model_health_changed', 
                        modelId: model.id, 
                        isHealthy 
                    });
                }
            } catch (error) {
                if (model.isHealthy) {
                    model.isHealthy = false;
                    this.eventEmitter.fire({ 
                        type: 'model_health_changed', 
                        modelId: model.id, 
                        isHealthy: false 
                    });
                }
            }
        }
    }
    
    /**
     * 获取当前模型池的快照副本
     *
     * 返回模型池的浅拷贝，避免外部代码直接修改内部状态。
     *
     * @returns 模型池的浅拷贝对象
     */
    public getModelPool(): ModelPool {
        return { ...this.modelPool };
    }
    
    /**
     * 按 ID 从缓存中获取模型能力信息
     *
     * @param modelId - 模型唯一标识符
     * @returns 对应的模型能力对象，若未找到则返回 undefined
     */
    public getModel(modelId: string): ModelCapabilities | undefined {
        return this.modelCache.get(modelId);
    }
    
    /**
     * 获取缓存中所有已发现的可用模型
     *
     * @returns 所有已缓存模型的能力数组
     */
    public getAllModels(): ModelCapabilities[] {
        return Array.from(this.modelCache.values());
    }

    /**
     * 写回运行时真实观测到的工具调用兼容性。
     */
    public recordToolCallingObservation(
        modelId: string,
        state: 'supported' | 'unsupported'
    ): void {
        const model = this.modelCache.get(modelId);
        if (!model) {
            return;
        }

        model.supportsTools = state === 'supported';
        model.toolSupportState = state;
        model.toolSupportSource = 'lmapi-observed-request';
        model.metadataSource = 'lmapi-observed';

        void this.updateModelPool(this.getAllModels());
    }
    
    /**
     * 清理服务占用的资源
     *
     * 停止后台定时刷新和健康检查定时器，释放事件发射器。
     * 应在扩展停用（deactivate）或服务器关闭时调用。
     */
    public dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
        }
        this.eventEmitter.dispose();
    }
}
