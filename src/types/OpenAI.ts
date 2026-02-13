/**
 * OpenAI API 类型定义
 * OpenAI Chat Completions API 的完整类型定义
 */

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
    content: string | null | Array<{
        type: 'text' | 'image_url';
        text?: string;
        image_url?: {
            url: string;
            detail?: 'low' | 'high' | 'auto';
        };
    }>;
    name?: string;
    tool_calls?: OpenAIToolCall[];
    tool_call_id?: string;
    function_call?: OpenAIFunctionCall;
}

export interface OpenAIFunction {
    name: string;
    description?: string;
    parameters?: Record<string, any>;
}

export interface OpenAIFunctionCall {
    name: string;
    arguments: string;
}

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: OpenAIFunctionCall;
}

export interface OpenAITool {
    type: 'function';
    function: OpenAIFunction;
}

export type OpenAIFunctionCallChoice = 'none' | 'auto' | { name: string };
export type OpenAIToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } };

export interface OpenAICompletionRequest {
    model: string;
    messages: OpenAIMessage[];
    temperature?: number;
    top_p?: number;
    n?: number;
    stream?: boolean;
    stop?: string | string[];
    max_tokens?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    logit_bias?: Record<string, number>;
    user?: string;
    functions?: OpenAIFunction[];
    function_call?: OpenAIFunctionCallChoice;
    tools?: OpenAITool[];
    tool_choice?: OpenAIToolChoice;
}

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

export interface OpenAIChoice {
    index: number;
    message?: OpenAIMessage;
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAICompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: OpenAIChoice[];
    usage: OpenAIUsage;
    system_fingerprint?: string;
}

export interface OpenAIStreamChoice {
    index: number;
    delta: {
        role?: 'assistant';
        content?: string;
        function_call?: Partial<OpenAIFunctionCall>;
        tool_calls?: Array<{
            index: number;
            id?: string;
            type?: 'function';
            function: {
                name?: string;
                arguments?: string;
            };
        }>;
    };
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
}

export interface OpenAIStreamResponse {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: OpenAIStreamChoice[];
    system_fingerprint?: string;
}

export interface OpenAIModel {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
    permission?: Array<{
        id: string;
        object: 'model_permission';
        created: number;
        allow_create_engine: boolean;
        allow_sampling: boolean;
        allow_logprobs: boolean;
        allow_search_indices: boolean;
        allow_view: boolean;
        allow_fine_tuning: boolean;
        organization: string;
        group?: string;
        is_blocking: boolean;
    }>;
    root?: string;
    parent?: string;
}

export interface OpenAIModelsResponse {
    object: 'list';
    data: OpenAIModel[];
}

export interface OpenAIError {
    error: {
        message: string;
        type: string;
        param?: string;
        code?: string;
    };
}

export interface OpenAIErrorResponse {
    error: OpenAIError['error'];
}

// 🚀 革命性：不再有硬编码模型限制！
// 动态模型支持 - 支持 VS Code LM API 支持的任何模型！

export interface ValidatedRequest extends OpenAICompletionRequest {
    model: string; // ✨ 任何模型！无限制！
    messages: OpenAIMessage[];
    stream: boolean;
    temperature: number;
    max_tokens?: number;
}

// 服务器发送事件的事件类型
export type SSEEvent = 
    | { type: 'data'; data: OpenAIStreamResponse }
    | { type: 'done' }
    | { type: 'error'; error: OpenAIError['error'] };
