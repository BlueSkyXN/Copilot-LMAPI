/**
 * @module OpenAI
 * @description OpenAI Chat Completions API 完整类型定义。
 *
 * 本模块定义了与 OpenAI Chat Completions API 完全兼容的 TypeScript 类型，
 * 是整个桥接服务的对外契约层。所有从客户端接收的请求和向客户端返回的响应
 * 均遵循此处定义的类型结构。
 *
 * 架构位置：
 *   Client (OpenAI SDK) --> HTTP 请求/响应 --> 本模块定义的类型 --> Converter 转换 --> VS Code LM API
 *
 * 关键依赖：
 *   - 无外部依赖，纯类型定义模块
 *
 * 设计要点：
 *   1. 完整覆盖 OpenAI API 规范 - 包括普通响应、流式响应（SSE）、错误响应
 *   2. 多模态支持 - 消息内容支持文本和图片 URL 的混合数组
 *   3. 双格式工具调用 - 同时定义现代 tools 格式和旧版 functions 格式
 *   4. 动态模型支持 - ValidatedRequest 不限制 model 字段取值
 *   5. 完整的流式类型 - 通过 delta 增量结构支持流式工具调用
 *
 * 类型分组：
 *   - 消息类型：OpenAIMessage（含多模态内容）
 *   - 工具/函数类型：OpenAIFunction, OpenAIFunctionCall, OpenAIToolCall, OpenAITool
 *   - 选择控制类型：OpenAIFunctionCallChoice, OpenAIToolChoice
 *   - 请求类型：OpenAICompletionRequest, ValidatedRequest
 *   - 响应类型：OpenAICompletionResponse, OpenAIStreamResponse
 *   - 模型类型：OpenAIModel, OpenAIModelsResponse
 *   - 错误类型：OpenAIError, OpenAIErrorResponse
 *   - 事件类型：SSEEvent
 *
 * 接口/类型清单：
 *
 *   1. OpenAIMessage（接口）
 *      - 功能：聊天消息，支持 system/user/assistant/tool/function 角色
 *      - 关键字段：role (string), content (string | 多模态数组 | null),
 *                 tool_calls? (OpenAIToolCall[]), tool_call_id? (string), name? (string)
 *
 *   2. OpenAIFunction（接口）
 *      - 功能：函数定义
 *      - 关键字段：name (string), description? (string), parameters? (object)
 *
 *   3. OpenAIFunctionCall（接口）
 *      - 功能：函数调用信息
 *      - 关键字段：name (string), arguments (string — JSON 字符串)
 *
 *   4. OpenAIToolCall（接口）
 *      - 功能：工具调用
 *      - 关键字段：id (string), type ('function'), function (OpenAIFunctionCall), index? (number)
 *
 *   5. OpenAITool（接口）
 *      - 功能：工具定义
 *      - 关键字段：type ('function'), function (OpenAIFunction)
 *
 *   6. OpenAIFunctionCallChoice（类型）
 *      - 功能：function_call 选择控制
 *      - 取值：'none' | 'auto' | { name: string }
 *
 *   7. OpenAIToolChoice（类型）
 *      - 功能：tool_choice 选择控制
 *      - 取值：'none' | 'auto' | 'required' | { type: 'function', function: { name: string } }
 *
 *   8. OpenAICompletionRequest（接口）
 *      - 功能：聊天补全请求
 *      - 关键字段：model (string), messages (OpenAIMessage[]), stream? (boolean),
 *                 temperature? (number, 默认 0.7), max_tokens? (number),
 *                 tools? (OpenAITool[]), functions? (OpenAIFunction[])
 *
 *   9. OpenAIUsage（接口）
 *      - 功能：令牌用量统计
 *      - 关键字段：prompt_tokens (number), completion_tokens (number), total_tokens (number)
 *
 *   10. OpenAIChoice（接口）
 *       - 功能：非流式候选回复
 *       - 关键字段：index (number), message (object), finish_reason (string | null)
 *
 *   11. OpenAICompletionResponse（接口）
 *       - 功能：非流式完整响应
 *       - 关键字段：id (string), object ('chat.completion'), model (string),
 *                  choices (OpenAIChoice[]), usage (OpenAIUsage)
 *
 *   12. OpenAIStreamChoice（接口）
 *       - 功能：流式候选回复增量
 *       - 关键字段：index (number), delta (object), finish_reason (string | null)
 *
 *   13. OpenAIStreamResponse（接口）
 *       - 功能：流式响应
 *       - 关键字段：id (string), object ('chat.completion.chunk'), model (string),
 *                  choices (OpenAIStreamChoice[])
 *
 *   14. OpenAIModel（接口）
 *       - 功能：模型信息
 *       - 关键字段：id (string), object ('model'), owned_by (string)
 *
 *   15. OpenAIModelsResponse（接口）
 *       - 功能：模型列表响应
 *       - 关键字段：object ('list'), data (OpenAIModel[])
 *
 *   16. OpenAIError（接口）
 *       - 功能：错误信息
 *       - 关键字段：message (string), type (string), code (string | number | null)
 *
 *   17. OpenAIErrorResponse（接口）
 *       - 功能：错误响应
 *       - 关键字段：error (OpenAIError)
 *
 *   18. ValidatedRequest（接口，extends OpenAICompletionRequest）
 *       - 功能：经验证的请求，附加验证元数据
 *       - 附加字段：_validated (true), _requestId (string), _timestamp (number)
 *
 *   19. SSEEvent（类型）
 *       - 功能：SSE 事件类型
 *       - 取值：{ type: 'data', data: string } | { type: 'done' } | { type: 'error', error: string }
 */

/**
 * OpenAI 聊天消息接口
 *
 * 表示对话中的单条消息，支持多种角色和多模态内容格式。
 * 不同角色的消息携带的字段有所不同：
 * - system：系统提示，仅 content
 * - user：用户输入，content 可为文本或多模态内容数组
 * - assistant：助手回复，可携带 tool_calls 或 function_call
 * - tool：工具调用结果，需携带 tool_call_id
 * - function：旧版函数调用结果，需携带 name
 */
export interface OpenAIMessage {
    /** 消息角色：system（系统）/ user（用户）/ assistant（助手）/ tool（工具结果）/ function（旧版函数结果） */
    role: 'system' | 'user' | 'assistant' | 'tool' | 'function';
    /**
     * 消息内容，支持三种格式：
     * - string：纯文本内容
     * - null：无文本内容（如纯工具调用的 assistant 消息）
     * - Array：多模态内容数组，每个元素为文本片段或图片 URL
     */
    content: string | null | Array<{
        /** 内容片段类型：text（文本）或 image_url（图片链接） */
        type: 'text' | 'image_url';
        /** 文本内容（当 type 为 'text' 时） */
        text?: string;
        /** 图片 URL 信息（当 type 为 'image_url' 时） */
        image_url?: {
            /** 图片的 URL 地址，支持 http/https 和 base64 data URI */
            url: string;
            /** 图片细节级别：low（低分辨率）/ high（高分辨率）/ auto（自动选择） */
            detail?: 'low' | 'high' | 'auto';
        };
    }>;
    /** 消息发送者的名称标识（可选），用于 function 角色消息标识函数名 */
    name?: string;
    /** assistant 消息中携带的工具调用列表（现代 tools 格式） */
    tool_calls?: OpenAIToolCall[];
    /** tool 角色消息关联的工具调用 ID，与 assistant 消息中的 tool_calls[].id 对应 */
    tool_call_id?: string;
    /** assistant 消息中携带的函数调用信息（旧版 functions 格式） */
    function_call?: OpenAIFunctionCall;
}

/**
 * OpenAI 函数定义接口
 *
 * 描述一个可被模型调用的函数，用于旧版 functions 参数
 * 或现代 tools 参数中 function 字段的定义。
 */
export interface OpenAIFunction {
    /** 函数名称，模型在生成函数调用时引用此名称 */
    name: string;
    /** 函数功能的自然语言描述，帮助模型理解何时应调用此函数 */
    description?: string;
    /** 函数参数的 JSON Schema 定义 */
    parameters?: Record<string, any>;
}

/**
 * OpenAI 函数调用信息接口
 *
 * 表示模型生成的一次函数调用，包含函数名和序列化的参数。
 * 出现在 assistant 消息的 function_call 字段（旧版格式）
 * 或 tool_calls[].function 字段（现代格式）中。
 */
export interface OpenAIFunctionCall {
    /** 被调用的函数名称 */
    name: string;
    /** 函数参数的 JSON 字符串表示 */
    arguments: string;
}

/**
 * OpenAI 工具调用接口
 *
 * 表示模型生成的一次工具调用（现代 tools 格式），
 * 出现在 assistant 消息的 tool_calls 数组中。
 * 每个工具调用有唯一 ID，用于关联后续的 tool 角色回复消息。
 */
export interface OpenAIToolCall {
    /** 工具调用的唯一标识符，tool 角色回复消息通过此 ID 关联 */
    id: string;
    /** 工具类型，目前固定为 'function' */
    type: 'function';
    /** 具体的函数调用信息（名称和参数） */
    function: OpenAIFunctionCall;
}

/**
 * OpenAI 工具定义接口
 *
 * 包装 OpenAIFunction 为工具格式，用于请求中的 tools 参数。
 */
export interface OpenAITool {
    /** 工具类型，目前固定为 'function' */
    type: 'function';
    /** 工具对应的函数定义 */
    function: OpenAIFunction;
}

/**
 * OpenAI function_call 选择控制类型（旧版格式）
 *
 * 控制模型是否以及如何使用函数调用：
 * - 'none'：禁止模型调用任何函数
 * - 'auto'：模型自行决定是否调用函数
 * - { name: string }：强制模型调用指定名称的函数
 */
export type OpenAIFunctionCallChoice = 'none' | 'auto' | { name: string };

/**
 * OpenAI tool_choice 选择控制类型（现代格式）
 *
 * 控制模型是否以及如何使用工具：
 * - 'none'：禁止模型调用任何工具
 * - 'auto'：模型自行决定是否调用工具
 * - 'required'：强制模型必须调用至少一个工具
 * - { type: 'function', function: { name } }：强制模型调用指定名称的工具
 */
export type OpenAIToolChoice =
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function'; function: { name: string } };

/**
 * OpenAI Chat Completions 请求接口
 *
 * 对应 POST /v1/chat/completions 的请求体，
 * 包含模型选择、对话消息、生成参数、工具配置等所有字段。
 */
export interface OpenAICompletionRequest {
    /** 目标模型标识符（动态支持，不限制具体值） */
    model: string;
    /** 对话消息数组，按时间顺序排列 */
    messages: OpenAIMessage[];
    /** 采样温度，取值 0-2，越高越随机 */
    temperature?: number;
    /** 核采样参数，取值 0-1，与 temperature 二选一使用 */
    top_p?: number;
    /** 为每条消息生成的候选回复数量 */
    n?: number;
    /** 是否以 SSE 流式方式返回响应 */
    stream?: boolean;
    /** 停止生成的标记词，可为单个字符串或字符串数组 */
    stop?: string | string[];
    /** 最大生成令牌数 */
    max_tokens?: number;
    /** 存在惩罚系数，取值 -2.0 到 2.0 */
    presence_penalty?: number;
    /** 频率惩罚系数，取值 -2.0 到 2.0 */
    frequency_penalty?: number;
    /** 令牌偏置映射，键为令牌 ID，值为偏置分数（-100 到 100） */
    logit_bias?: Record<string, number>;
    /** 终端用户标识符，用于滥用检测 */
    user?: string;
    /** 可用的函数定义列表（旧版格式） */
    functions?: OpenAIFunction[];
    /** 函数调用控制（旧版格式） */
    function_call?: OpenAIFunctionCallChoice;
    /** 可用的工具定义列表（现代格式） */
    tools?: OpenAITool[];
    /** 工具调用控制（现代格式） */
    tool_choice?: OpenAIToolChoice;
}

/**
 * OpenAI 令牌用量统计接口
 *
 * 记录单次请求的令牌消耗情况。
 */
export interface OpenAIUsage {
    /** 输入提示消耗的令牌数 */
    prompt_tokens: number;
    /** 生成回复消耗的令牌数 */
    completion_tokens: number;
    /** 总令牌消耗数（prompt_tokens + completion_tokens） */
    total_tokens: number;
}

/**
 * OpenAI 非流式响应中的候选回复接口
 *
 * 表示模型生成的一个完整候选回复。
 */
export interface OpenAIChoice {
    /** 候选回复的索引号（从 0 开始） */
    index: number;
    /** 完整的回复消息对象 */
    message?: OpenAIMessage;
    /**
     * 生成停止的原因：
     * - 'stop'：正常结束（遇到停止标记或自然结束）
     * - 'length'：达到 max_tokens 限制
     * - 'function_call'：模型生成了函数调用（旧版）
     * - 'tool_calls'：模型生成了工具调用（现代）
     * - 'content_filter'：内容被安全过滤器拦截
     * - null：生成尚未完成
     */
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI Chat Completions 非流式响应接口
 *
 * 对应 stream=false 时的完整 JSON 响应体。
 */
export interface OpenAICompletionResponse {
    /** 响应的唯一标识符，格式为 chatcmpl-xxx */
    id: string;
    /** 对象类型，固定为 'chat.completion' */
    object: 'chat.completion';
    /** 响应创建的 Unix 时间戳（秒） */
    created: number;
    /** 实际使用的模型标识符 */
    model: string;
    /** 候选回复数组 */
    choices: OpenAIChoice[];
    /** 令牌用量统计 */
    usage: OpenAIUsage;
    /** 系统指纹，标识后端配置版本（可选） */
    system_fingerprint?: string;
}

/**
 * OpenAI 流式响应中的候选回复增量接口
 *
 * 表示流式 SSE 中的单个增量片段。
 */
export interface OpenAIStreamChoice {
    /** 候选回复的索引号 */
    index: number;
    /** 增量内容对象，每次只包含新增的部分 */
    delta: {
        /** 角色标识（仅在首个 chunk 中出现） */
        role?: 'assistant';
        /** 新增的文本内容片段 */
        content?: string;
        /** 函数调用的增量信息（旧版格式，可能分多个 chunk 传输） */
        function_call?: Partial<OpenAIFunctionCall>;
        /**
         * 工具调用的增量信息（现代格式）
         * 通过 index 字段关联同一工具调用的多个增量片段
         */
        tool_calls?: Array<{
            /** 工具调用在 tool_calls 数组中的索引，用于增量拼接 */
            index: number;
            /** 工具调用 ID（仅在该工具调用的首个 chunk 中出现） */
            id?: string;
            /** 工具类型（仅在首个 chunk 中出现） */
            type?: 'function';
            /** 函数信息增量 */
            function: {
                /** 函数名称（仅在首个 chunk 中出现） */
                name?: string;
                /** 参数 JSON 字符串的增量片段 */
                arguments?: string;
            };
        }>;
    };
    /** 生成停止的原因（仅在最后一个 chunk 中非 null） */
    finish_reason: 'stop' | 'length' | 'function_call' | 'tool_calls' | 'content_filter' | null;
}

/**
 * OpenAI Chat Completions 流式响应接口
 *
 * 对应 stream=true 时每个 SSE data 事件中的 JSON 对象。
 */
export interface OpenAIStreamResponse {
    /** 响应的唯一标识符，同一次请求的所有 chunk 共享同一 ID */
    id: string;
    /** 对象类型，固定为 'chat.completion.chunk' */
    object: 'chat.completion.chunk';
    /** 响应创建的 Unix 时间戳（秒） */
    created: number;
    /** 实际使用的模型标识符 */
    model: string;
    /** 候选回复增量数组 */
    choices: OpenAIStreamChoice[];
    /** 系统指纹（可选） */
    system_fingerprint?: string;
}

/**
 * OpenAI 模型信息接口
 *
 * 描述单个可用模型的元数据，对应 GET /v1/models 响应中的模型条目。
 */
export interface OpenAIModel {
    /** 模型唯一标识符 */
    id: string;
    /** 对象类型，固定为 'model' */
    object: 'model';
    /** 模型创建的 Unix 时间戳（秒） */
    created: number;
    /** 模型所属组织 */
    owned_by: string;
    /** 模型权限列表（可选） */
    permission?: Array<{
        /** 权限条目 ID */
        id: string;
        /** 对象类型，固定为 'model_permission' */
        object: 'model_permission';
        /** 权限创建时间戳 */
        created: number;
        /** 是否允许创建引擎 */
        allow_create_engine: boolean;
        /** 是否允许采样 */
        allow_sampling: boolean;
        /** 是否允许获取对数概率 */
        allow_logprobs: boolean;
        /** 是否允许搜索索引 */
        allow_search_indices: boolean;
        /** 是否允许查看 */
        allow_view: boolean;
        /** 是否允许微调 */
        allow_fine_tuning: boolean;
        /** 所属组织 */
        organization: string;
        /** 所属分组（可选） */
        group?: string;
        /** 是否为阻塞权限 */
        is_blocking: boolean;
    }>;
    /** 根模型标识符（可选） */
    root?: string;
    /** 父模型标识符（可选） */
    parent?: string;
}

/**
 * OpenAI 模型列表响应接口
 *
 * 对应 GET /v1/models 的完整响应体。
 */
export interface OpenAIModelsResponse {
    /** 对象类型，固定为 'list' */
    object: 'list';
    /** 模型信息数组 */
    data: OpenAIModel[];
}

/**
 * OpenAI 错误信息接口
 *
 * API 错误响应的标准结构。
 */
export interface OpenAIError {
    /** 错误详情对象 */
    error: {
        /** 人类可读的错误描述 */
        message: string;
        /** 错误类型标识（如 invalid_request_error, authentication_error 等） */
        type: string;
        /** 导致错误的请求参数名（可选） */
        param?: string;
        /** 机器可读的错误代码（可选） */
        code?: string;
    };
}

/**
 * OpenAI 错误响应接口
 *
 * 与 OpenAIError 结构相同，用于需要直接访问 error 字段的场景。
 */
export interface OpenAIErrorResponse {
    /** 错误详情对象 */
    error: OpenAIError['error'];
}

// 动态模型支持 - 支持 VS Code LM API 提供的任何模型，无硬编码限制

/**
 * 经验证的请求接口
 *
 * 继承自 OpenAICompletionRequest，在 Validator 验证通过后使用，
 * 确保关键字段（model、messages、stream、temperature）已填充默认值。
 * model 字段接受任何模型标识符，不设硬编码限制。
 */
export interface ValidatedRequest extends OpenAICompletionRequest {
    /** 目标模型标识符，接受任何值，由 ModelDiscoveryService 动态解析 */
    model: string;
    /** 经验证的消息数组，至少包含一条消息 */
    messages: OpenAIMessage[];
    /** 是否流式返回，已填充默认值 */
    stream: boolean;
    /** 采样温度，已填充默认值 */
    temperature: number;
    /** 最大生成令牌数（可选） */
    max_tokens?: number;
}

/**
 * 服务器发送事件（SSE）的事件类型
 *
 * 用于流式响应中 SSE 事件的类型化表示：
 * - data：正常的流式响应数据块
 * - done：流式传输结束标记（对应 [DONE]）
 * - error：流式传输中的错误信息
 */
export type SSEEvent = 
    | { type: 'data'; data: OpenAIStreamResponse }
    | { type: 'done' }
    | { type: 'error'; error: OpenAIError['error'] };
