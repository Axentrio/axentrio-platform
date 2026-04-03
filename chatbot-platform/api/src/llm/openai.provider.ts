import OpenAI from 'openai';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse, ToolCall } from './llm.types';

type OpenAIMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAI.Chat.ChatCompletionMessageToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

function mapMessage(m: ChatMessage): OpenAIMessage {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId! };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const tools =
      options.tools && options.tools.length > 0
        ? options.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          }))
        : undefined;

    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: messages.map(mapMessage),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      response_format: options.jsonMode ? { type: 'json_object' as const } : undefined,
      tools,
    });

    const choice = response.choices[0];
    const rawFinish = choice.finish_reason as string;
    const finishReason: LLMResponse['finishReason'] =
      rawFinish === 'tool_calls' ? 'tool_calls' : rawFinish === 'length' ? 'length' : 'stop';

    let toolCalls: ToolCall[] | undefined;
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      toolCalls = choice.message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));
    }

    return {
      content: choice.message.content || '',
      usage: {
        promptTokens: response.usage?.prompt_tokens || 0,
        completionTokens: response.usage?.completion_tokens || 0,
      },
      finishReason,
      toolCalls,
    };
  }
}
