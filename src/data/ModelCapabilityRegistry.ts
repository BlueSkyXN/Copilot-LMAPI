/**
 * 模型能力注册表
 * 基于 GitHub Copilot 官方 REST API 数据
 *
 * 更新方式：获取 Copilot Models API 数据，对照更新下方注册表
 * 最后更新：2026-02-14
 */

export interface ModelCapabilityEntry {
    /** 模型 ID（用于匹配） */
    id: string;
    /** 是否支持视觉/图像输入 */
    vision: boolean;
    /** 是否支持 tool/function calling */
    toolCalls: boolean;
    /** 是否支持流式响应 */
    streaming: boolean;
    /** 是否支持并行工具调用 */
    parallelToolCalls: boolean;
    /** 是否支持结构化输出 */
    structuredOutputs: boolean;
    /** 视觉相关限制（仅当 vision=true） */
    visionLimits?: {
        maxPromptImageSize: number;
        maxPromptImages: number;
        supportedMediaTypes: string[];
    };
}

// ============================================================
// 注册表定义 — 基于 Copilot REST API capabilities.supports
// ============================================================

const VISION_LIMITS_STANDARD: ModelCapabilityEntry['visionLimits'] = {
    maxPromptImageSize: 3145728,
    maxPromptImages: 1,
    supportedMediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
};

const VISION_LIMITS_CLAUDE: ModelCapabilityEntry['visionLimits'] = {
    maxPromptImageSize: 3145728,
    maxPromptImages: 5,
    supportedMediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

const VISION_LIMITS_CLAUDE_OPUS_46: ModelCapabilityEntry['visionLimits'] = {
    maxPromptImageSize: 3145728,
    maxPromptImages: 1,
    supportedMediaTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

const VISION_LIMITS_GEMINI: ModelCapabilityEntry['visionLimits'] = {
    maxPromptImageSize: 3145728,
    maxPromptImages: 10,
    supportedMediaTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'],
};

export const MODEL_CAPABILITY_REGISTRY: Record<string, ModelCapabilityEntry> = {

    // ===== OpenAI GPT-4.1 =====
    'gpt-4.1': {
        id: 'gpt-4.1',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },

    // ===== OpenAI GPT-4o 系列 =====
    'gpt-4o': {
        id: 'gpt-4o',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        vision: false,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
    },

    // ===== OpenAI GPT-4 旧版 =====
    'gpt-4-turbo': {
        id: 'gpt-4-turbo',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-4': {
        id: 'gpt-4',
        vision: false,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
    },
    'gpt-3.5-turbo': {
        id: 'gpt-3.5-turbo',
        vision: false,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
    },

    // ===== OpenAI GPT-5 系列 =====
    'gpt-5': {
        id: 'gpt-5',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5-mini': {
        id: 'gpt-5-mini',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5-codex': {
        id: 'gpt-5-codex',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },

    // ===== OpenAI GPT-5.1 系列 =====
    'gpt-5.1': {
        id: 'gpt-5.1',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5.1-codex': {
        id: 'gpt-5.1-codex',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5.1-codex-mini': {
        id: 'gpt-5.1-codex-mini',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5.1-codex-max': {
        id: 'gpt-5.1-codex-max',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },

    // ===== OpenAI GPT-5.2 系列 =====
    'gpt-5.2': {
        id: 'gpt-5.2',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },
    'gpt-5.2-codex': {
        id: 'gpt-5.2-codex',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },

    // ===== OpenAI GPT-5.3 系列 =====
    'gpt-5.3-codex': {
        id: 'gpt-5.3-codex',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_STANDARD,
    },

    // ===== Anthropic Claude 系列 =====
    'claude-opus-4.6': {
        id: 'claude-opus-4.6',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: true,
        visionLimits: VISION_LIMITS_CLAUDE_OPUS_46,
    },
    'claude-opus-4.5': {
        id: 'claude-opus-4.5',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_CLAUDE,
    },
    'claude-sonnet-4.5': {
        id: 'claude-sonnet-4.5',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_CLAUDE,
    },
    'claude-sonnet-4': {
        id: 'claude-sonnet-4',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_CLAUDE,
    },
    'claude-haiku-4.5': {
        id: 'claude-haiku-4.5',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_CLAUDE,
    },
    // 旧版 Claude-3 系列（兼容）
    'claude-3': {
        id: 'claude-3',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_CLAUDE,
    },

    // ===== Google Gemini 系列 =====
    'gemini-3-pro': {
        id: 'gemini-3-pro',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },
    'gemini-3-pro-preview': {
        id: 'gemini-3-pro-preview',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },
    'gemini-3-flash': {
        id: 'gemini-3-flash',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },
    'gemini-3-flash-preview': {
        id: 'gemini-3-flash-preview',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },
    'gemini-2.5-pro': {
        id: 'gemini-2.5-pro',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: true,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },
    // 旧版 Gemini（兼容）
    'gemini': {
        id: 'gemini',
        vision: true,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
        visionLimits: VISION_LIMITS_GEMINI,
    },

    // ===== xAI Grok 系列 =====
    'grok-code-fast-1': {
        id: 'grok-code-fast-1',
        vision: false,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: true,
    },

    // ===== 特殊模型 =====
    'gpt-41-copilot': {
        id: 'gpt-41-copilot',
        vision: false,  // completion 类型，非 chat
        toolCalls: false,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
    },
    'copilot-fast': {
        id: 'copilot-fast',
        vision: false,
        toolCalls: true,
        streaming: true,
        parallelToolCalls: false,
        structuredOutputs: false,
    },
};

// ============================================================
// 查找函数
// ============================================================

/**
 * 查找模型能力。
 * 匹配策略：精确匹配 → 最长前缀匹配。
 * 例如 "gpt-4.1-2025-04-14" 精确匹配不到，会前缀匹配到 "gpt-4.1"。
 */
export function lookupModelCapabilities(modelId: string): ModelCapabilityEntry | undefined {
    const id = modelId.toLowerCase();

    // 精确匹配
    if (MODEL_CAPABILITY_REGISTRY[id]) {
        return MODEL_CAPABILITY_REGISTRY[id];
    }

    // 最长前缀匹配
    let bestMatch: ModelCapabilityEntry | undefined;
    let bestLen = 0;

    for (const [key, entry] of Object.entries(MODEL_CAPABILITY_REGISTRY)) {
        if (!id.startsWith(key) || key.length <= bestLen) {
            continue;
        }

        const nextChar = id[key.length];
        const hasBoundary = !nextChar || nextChar === '-' || nextChar === '.';
        if (hasBoundary) {
            bestMatch = entry;
            bestLen = key.length;
        }
    }

    return bestMatch;
}
