/** A text segment of a multimodal message. */
export interface TextPart {
  type: 'text';
  text: string;
}

/** An inline image segment of a multimodal message (base64-encoded bytes). */
export interface ImagePart {
  type: 'image';
  /** e.g. 'image/jpeg', 'image/png', 'image/gif', 'image/webp'. */
  mimeType: string;
  /** Base64-encoded image bytes (no data: URI prefix). */
  data: string;
}

export type ContentPart = TextPart | ImagePart;

/** Flatten message content to plain text, dropping any image parts. Use where a
 *  consumer only handles text (system/assistant/tool messages, KB retrieval). */
export function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Plain text, or multimodal parts (only user-role messages use the array form). */
  content: string | ContentPart[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  jsonMode: boolean;
  tools?: ToolDefinition[];
}

export interface LLMResponse {
  content: string;
  usage: { promptTokens: number; completionTokens: number };
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse>;
}
