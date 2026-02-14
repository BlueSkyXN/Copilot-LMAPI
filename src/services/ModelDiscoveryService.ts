/**
 * 🚀 革命性模型发现服务
 * 动态发现、测试和管理所有可用的 VS Code 语言模型
 * 无硬编码限制 - 纯动态智能！
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
import { lookupModelCapabilities } from '../data/ModelCapabilityRegistry';

export class ModelDiscoveryService {
    private modelPool: ModelPool;
    private modelMetrics: Map<string, ModelMetrics>;
    private modelCache: Map<string, ModelCapabilities>;
    private eventEmitter: vscode.EventEmitter<ModelEvent>;
    private config: ModelDiscoveryConfig;
    private refreshTimer?: NodeJS.Timeout;
    private healthCheckTimer?: NodeJS.Timeout;
    
    public readonly onModelEvent: vscode.Event<ModelEvent>;
    
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
     * 🔍 发现所有可用模型（无限制！）
     */
    public async discoverAllModels(): Promise<ModelCapabilities[]> {
        logger.info('🚀 Starting dynamic model discovery...');
        
        try {
            // 从 VS Code LM API 获取所有模型
            const allModels = await vscode.lm.selectChatModels();
            logger.info(`📊 Found ${allModels.length} total models`);
            
            const discoveredModels: ModelCapabilities[] = [];
            
            // 测试每个模型的能力
            for (const vsCodeModel of allModels) {
                try {
                    const capabilities = await this.analyzeModelCapabilities(vsCodeModel);
                    discoveredModels.push(capabilities);
                    
                    // 缓存模型
                    this.modelCache.set(capabilities.id, capabilities);
                    
                    // 初始化指标
                    this.initializeModelMetrics(capabilities.id);
                    
                    // 发出发现事件
                    this.eventEmitter.fire({ type: 'model_discovered', model: capabilities });
                    
                    logger.info(`✅ Model ${capabilities.id} discovered with capabilities:`, {
                        vision: capabilities.supportsVision,
                        tools: capabilities.supportsTools,
                        tokens: capabilities.maxInputTokens
                    });
                    
                } catch (error) {
                    logger.warn(`⚠️ Failed to analyze model ${vsCodeModel.id}:`, { error: String(error) });
                }
            }
            
            // 更新模型池
            await this.updateModelPool(discoveredModels);
            
            logger.info(`🎉 Discovery complete! Found ${discoveredModels.length} usable models`);
            return discoveredModels;
            
        } catch (error) {
            logger.error('❌ Model discovery failed:', error as Error);
            throw new Error(`Model discovery failed: ${error}`);
        }
    }
    
    /**
     * 🔬 分析模型能力（魔法发生的地方）
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
        
        // 🔍 测试视觉能力
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
        
        // 🛠️ 测试工具/函数调用能力
        try {
            capabilities.supportsTools = await this.testToolCapability(vsCodeModel);
        } catch (error) {
            logger.debug(`Tool test failed for ${vsCodeModel.id}:`, { error: String(error) });
        }
        
        // 📈 测试性能
        const responseTime = Date.now() - startTime;
        capabilities.responseTime = responseTime;
        
        // 🧠 智能能力推理
        this.inferAdvancedCapabilities(capabilities);
        
        return capabilities;
    }
    
    /**
     * 👁️ 基于能力注册表检测模型视觉支持
     */
    private async testVisionCapability(model: vscode.LanguageModelChat): Promise<boolean> {
        const entry = lookupModelCapabilities(model.id);
        if (entry) {
            return entry.vision;
        }
        logger.debug(`Model ${model.id} not in capability registry, default vision=false`);
        return false;
    }

    /**
     * 🛠️ 基于能力注册表检测模型工具调用支持
     */
    private async testToolCapability(model: vscode.LanguageModelChat): Promise<boolean> {
        const entry = lookupModelCapabilities(model.id);
        if (entry) {
            return entry.toolCalls;
        }
        logger.debug(`Model ${model.id} not in capability registry, default toolCalls=false`);
        return false;
    }
    
    /**
     * 🧠 智能能力推理
     */
    private inferAdvancedCapabilities(capabilities: ModelCapabilities): void {
        const modelId = capabilities.id.toLowerCase();
        
        // 推断最大输出令牌数
        if (!capabilities.maxOutputTokens) {
            capabilities.maxOutputTokens = Math.min(capabilities.maxInputTokens * 0.5, 4096);
        }

        // 从注册表获取精确的视觉限制
        if (capabilities.supportsVision) {
            const entry = lookupModelCapabilities(capabilities.id);
            if (entry?.visionLimits) {
                capabilities.maxImageSize = entry.visionLimits.maxPromptImageSize;
                capabilities.maxImagesPerRequest = entry.visionLimits.maxPromptImages;
                capabilities.supportedImageFormats = entry.visionLimits.supportedMediaTypes.map(
                    mt => mt.replace('image/', '')
                );
                capabilities.supportedImageMediaTypes = entry.visionLimits.supportedMediaTypes;
            } else {
                // 注册表中没有精确限制时的保守默认值
                capabilities.maxImageSize = 3 * 1024 * 1024; // 3MB
                capabilities.maxImagesPerRequest = 1;
                capabilities.supportedImageFormats = ['jpeg', 'jpg', 'png', 'gif', 'webp'];
                capabilities.supportedImageMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            }
        }

        // 设置上下文窗口（目前与最大输入相同）
        capabilities.contextWindow = capabilities.maxInputTokens;
    }
    
    
    /**
     * 📈 计算能力评分用于排名
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
     * 🔄 更新模型池组织
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
        
        logger.info(`🎪 Model pool updated:`, {
            primary: this.modelPool.primary.length,
            secondary: this.modelPool.secondary.length,
            fallback: this.modelPool.fallback.length,
            unhealthy: this.modelPool.unhealthy.length
        });
    }
    
    /**
     * 📊 为模型初始化指标
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
     * 🔄 启动后台服务
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
     * 👩‍⚕️ 对所有模型执行健康检查
     */
    private async performHealthChecks(): Promise<void> {
        logger.debug('👩‍⚕️ Performing model health checks...');
        
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
     * 📋 获取当前模型池
     */
    public getModelPool(): ModelPool {
        return { ...this.modelPool };
    }
    
    /**
     * 📋 按 ID 获取模型
     */
    public getModel(modelId: string): ModelCapabilities | undefined {
        return this.modelCache.get(modelId);
    }
    
    /**
     * 📋 获取所有可用模型
     */
    public getAllModels(): ModelCapabilities[] {
        return Array.from(this.modelCache.values());
    }
    
    /**
     * 🧹 清理资源
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
