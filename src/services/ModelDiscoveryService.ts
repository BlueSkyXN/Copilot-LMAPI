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
 *      - 功能：发现所有可用模型，调用 vscode.lm.selectChatModels() 并分析能力
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
    /** 后台模型缓存定时刷新器 */
    private refreshTimer?: NodeJS.Timeout;
    /** 后台健康检查定时器 */
    private healthCheckTimer?: NodeJS.Timeout;
    
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
    constructor(config?: Partial<ModelDiscoveryConfig>) {
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
        logger.info('Starting dynamic model discovery...');

        try {
            // 从 VS Code LM API 获取所有模型
            const allModels = await vscode.lm.selectChatModels();
            logger.info(`Found ${allModels.length} total models`);
            
            const discoveredModels: ModelCapabilities[] = [];
            const nextModelCache = new Map<string, ModelCapabilities>();
            
            // 测试每个模型的能力
            for (const vsCodeModel of allModels) {
                try {
                    const capabilities = await this.analyzeModelCapabilities(vsCodeModel);
                    discoveredModels.push(capabilities);
                    
                    // 缓存模型
                    nextModelCache.set(capabilities.id, capabilities);
                    
                    // 初始化指标
                    this.initializeModelMetrics(capabilities.id);
                    
                    // 发出发现事件
                    this.eventEmitter.fire({ type: 'model_discovered', model: capabilities });
                    
                    logger.info(`Model ${capabilities.id} discovered with capabilities:`, {
                        vision: capabilities.supportsVision,
                        tools: capabilities.supportsTools,
                        tokens: capabilities.maxInputTokens
                    });
                    
                } catch (error) {
                    logger.warn(`Failed to analyze model ${vsCodeModel.id}:`, { error: String(error) });
                }
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
        
        // 基本模型信息
        const capabilities: ModelCapabilities = {
            id: vsCodeModel.id,
            family: vsCodeModel.family,
            vendor: vsCodeModel.vendor,
            version: vsCodeModel.version,
            maxInputTokens: vsCodeModel.maxInputTokens,
            contextWindow: vsCodeModel.maxInputTokens,
            supportsVision: false,
            supportsTools: false,
            supportsStreaming: true, // VS Code 模型默认为 true
            supportsMultimodal: false,
            isHealthy: true,
            vsCodeModel: vsCodeModel,
            lastTestedAt: new Date()
        };
        
        // 测试视觉能力
        try {
            capabilities.supportsVision = await this.testVisionCapability(vsCodeModel);
            if (capabilities.supportsVision) {
                capabilities.supportsMultimodal = true;
                capabilities.supportedImageFormats = ['jpeg', 'jpg', 'png', 'gif', 'webp'];
                capabilities.maxImagesPerRequest = 10; // 保守估计
            }
        } catch (error) {
            logger.debug(`Vision test failed for ${vsCodeModel.id}:`, { error: String(error) });
        }
        
        // 测试工具/函数调用能力
        try {
            capabilities.supportsTools = await this.testToolCapability(vsCodeModel);
        } catch (error) {
            logger.debug(`Tool test failed for ${vsCodeModel.id}:`, { error: String(error) });
        }
        
        // 测试性能
        const responseTime = Date.now() - startTime;
        capabilities.responseTime = responseTime;

        // 智能能力推理
        this.inferAdvancedCapabilities(capabilities);
        
        return capabilities;
    }
    
    /**
     * 测试模型是否支持视觉/图像输入
     *
     * 通过检查模型的 ID、family、vendor 等标识信息中是否包含已知的
     * 视觉模型关键词（如 vision、multimodal、gpt-4o、claude-3 等）来推断能力。
     * 采用基于名称的启发式匹配，而非实际发送图像进行探测。
     *
     * @param model - 待测试的 VS Code 语言模型
     * @returns 是否支持视觉输入
     */
    private async testVisionCapability(model: vscode.LanguageModelChat): Promise<boolean> {
        try {
            const probeText = this.getCapabilityProbeText(model);
            const visionHints = [
                'vision',
                'multimodal',
                'gpt-4o',
                'gpt-4.1',
                'gpt-4-turbo',
                'claude-3',
                'claude-sonnet-4',
                'gemini'
            ];
            return visionHints.some(hint => probeText.includes(hint));
        } catch (error) {
            return false;
        }
    }

    /**
     * 测试模型是否支持工具/函数调用
     *
     * 通过检查模型标识信息中是否包含已知的支持工具调用的模型关键词
     * （如 gpt-3.5、gpt-4、claude、gemini 等）来推断能力。
     * 同时支持字符串精确匹配和正则表达式匹配。
     *
     * @param model - 待测试的 VS Code 语言模型
     * @returns 是否支持工具/函数调用
     */
    private async testToolCapability(model: vscode.LanguageModelChat): Promise<boolean> {
        try {
            const probeText = this.getCapabilityProbeText(model);
            const toolHints = [
                'gpt-3.5',
                'gpt-4',
                'gpt-5',
                /\bo1\b/,
                /\bo3\b/,
                /\bo4\b/,
                'claude',
                'gemini',
                'tool',
                'function'
            ];
            return toolHints.some(hint =>
                typeof hint === 'string' ? probeText.includes(hint) : hint.test(probeText)
            );
        } catch (error) {
            return false;
        }
    }

    /**
     * 生成归一化的能力探测文本
     *
     * 将模型的 id、family、vendor 字段合并为统一的小写字符串，
     * 用于视觉和工具能力的关键词匹配，避免仅依赖单个字段导致误判。
     *
     * @param model - VS Code 语言模型对象
     * @returns 合并后的小写探测文本
     */
    private getCapabilityProbeText(model: vscode.LanguageModelChat): string {
        return [model.id, model.family, model.vendor]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
    }
    
    /**
     * 智能推理模型的高级能力参数
     *
     * 根据已知的基础能力信息推断额外参数：
     * - 若未设置 maxOutputTokens，按 maxInputTokens 的 50%（上限 4096）估算
     * - 若模型支持视觉，设置默认的最大图片大小（20MB）
     * - 将 contextWindow 与 maxInputTokens 保持同步
     *
     * @param capabilities - 待补充的模型能力对象（原地修改）
     */
    private inferAdvancedCapabilities(capabilities: ModelCapabilities): void {
        // 推断最大输出令牌数
        if (!capabilities.maxOutputTokens) {
            capabilities.maxOutputTokens = Math.min(capabilities.maxInputTokens * 0.5, 4096);
        }

        // 为视觉模型推断图像能力
        if (capabilities.supportsVision) {
            capabilities.maxImageSize = 20 * 1024 * 1024; // 20MB
        }

        // 设置上下文窗口（目前与最大输入相同）
        capabilities.contextWindow = capabilities.maxInputTokens;
    }
    
    
    /**
     * 计算模型的综合能力评分
     *
     * 根据多维度指标为模型生成数值评分，用于模型池内的排序。
     * 评分维度包括：
     * - 令牌容量（maxInputTokens / 1000）
     * - 视觉支持（+50 分）
     * - 工具调用支持（+30 分）
     * - 多模态支持（+20 分）
     * - 健康/成功率（successRate * 100）
     *
     * @param model - 待评分的模型能力对象
     * @returns 综合能力评分（数值越大越优先）
     */
    private calculateCapabilityScore(model: ModelCapabilities): number {
        let score = 0;
        
        score += model.maxInputTokens / 1000; // 令牌容量
        if (model.supportsVision) {
            score += 50;
        }
        if (model.supportsTools) {
            score += 30;
        }
        if (model.supportsMultimodal) {
            score += 20;
        }
        score += (model.successRate || 0.5) * 100; // 健康评分
        
        return score;
    }
    
    /**
     * 更新模型池的分级组织结构
     *
     * 将所有已发现的模型按健康状态和能力特征分配到四个池中：
     * - primary：同时支持视觉和工具调用的模型（最高优先级）
     * - secondary：支持工具调用或上下文窗口超过 64K 的模型
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
            } else if (model.supportsVision && model.supportsTools) {
                this.modelPool.primary.push(model);
            } else if (model.supportsTools || model.maxInputTokens > 64000) {
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
