/**
 * 动态模型能力和发现系统
 * 🚀 革命性模型管理，无硬编码限制
 */

import * as vscode from 'vscode';
import type { OpenAIMessage, OpenAIToolCall } from './OpenAI';

// 🎯 动态模型能力
export interface ModelCapabilities {
    id: string;
    family?: string;
    vendor?: string;
    version?: string;
    
    // 核心能力
    maxInputTokens: number;
    maxOutputTokens?: number;
    contextWindow: number;
    
    // 功能支持检测
    supportsVision: boolean;
    supportsTools: boolean;
    supportsFunctionCalling: boolean;
    supportsStreaming: boolean;
    supportsMultimodal: boolean;
    
    // 性能指标
    lastTestedAt?: Date;
    responseTime?: number;
    successRate?: number;
    isHealthy: boolean;
    
    // 高级功能
    supportedImageFormats?: string[];
    maxImageSize?: number;
    maxImagesPerRequest?: number;
    
    // 原始 VS Code 模型引用
    vsCodeModel: vscode.LanguageModelChat;
}

// （已移除）模型自动选择相关类型

// 🎨 用于多模态的增强消息类型（复用 OpenAIMessage，避免重复定义）
export type EnhancedMessage = OpenAIMessage;

// 🛠️ 函数/工具调用支持
export type ToolCall = OpenAIToolCall;

export interface FunctionDefinition {
    name: string;
    description?: string;
    parameters: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
}

// 📈 模型性能指标
export interface ModelMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    lastUsed: Date;
    currentLoad: number;
}

// 🧠 模型发现配置
export interface ModelDiscoveryConfig {
    enableCaching: boolean;
    cacheRefreshInterval: number;
    healthCheckInterval: number;
    capabilityTestTimeout: number;
    enablePerformanceTracking: boolean;
    enableAutoFailover: boolean;
}

// 🎪 模型池管理
export interface ModelPool {
    primary: ModelCapabilities[];
    secondary: ModelCapabilities[];
    fallback: ModelCapabilities[];
    unhealthy: ModelCapabilities[];
    lastUpdated: Date;
}

// 📋 带有增强功能的请求上下文
export interface EnhancedRequestContext {
    requestId: string;
    model: string;
    isStream: boolean;
    startTime: Date;
    clientIP?: string;
    userAgent?: string;
    
    // 新能力
    hasImages: boolean;
    hasFunctions: boolean;
    requiredCapabilities: string[];
    estimatedTokens: number;
    selectedModel?: ModelCapabilities;
}

// 🎛️ 动态配置接口
export interface DynamicModelConfig {
    // 移除所有硬编码限制
    allowAllModels: boolean;
    
    // 智能模型选择
    enableSmartSelection: boolean;
    enableLoadBalancing: boolean;
    enableAutoFailover: boolean;
    
    // 性能优化
    enableModelCaching: boolean;
    enableCapabilityTesting: boolean;
    enablePerformanceMonitoring: boolean;
    
    // 功能门控
    enableVisionSupport: boolean;
    enableFunctionCalling: boolean;
    enableMultimodalRequests: boolean;
    
    // 限制（软性，非硬编码）
    preferredMaxTokens?: number;
    emergencyFallbackModel?: string;
}

// 🚀 模型发现事件
export type ModelEvent = 
    | { type: 'model_discovered'; model: ModelCapabilities }
    | { type: 'model_health_changed'; modelId: string; isHealthy: boolean }
    | { type: 'capability_updated'; modelId: string; capabilities: Partial<ModelCapabilities> }
    | { type: 'pool_refreshed'; pool: ModelPool }
    | { type: 'failover_triggered'; from: string; to: string; reason: string };

// 🎯 导出所有动态类型
export {
    vscode // 为方便起见重新导出
};
