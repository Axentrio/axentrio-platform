import Anthropic from '@anthropic-ai/sdk';
import { LLMProvider, ChatMessage, LLMOptions, LLMResponse, ToolCall } from './llm.types';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
};

function mapMessagesToAnthropic(messages: ChatMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === 'system') {
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const blocks: Anthropic.ContentBlockParam[] = msg.toolCalls.map((tc) => ({
          type: 'tool_use' as const,
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        }));
        result.push({ role: 'assistant', content: blocks });
      } else {
        result.push({ role: 'assistant', content: msg.content });
      }
      i++;
      continue;
    }

    // Group consecutive tool results into a single user message
    if (msg.role === 'tool') {
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i];
        toolResultBlocks.push({
          type: 'tool_result' as const,
          tool_use_id: toolMsg.toolCallId ?? '',
          content: toolMsg.content,
        });
        i++;
      }
      result.push({ role: 'user', content: toolResultBlocks });
      continue;
    }

    // Regular user message
    result.push({ role: 'user', content: msg.content });
    i++;
  }

  return result;
}

function mapStopReason(stopReason: string | null | undefined): LLMResponse['finishReason'] {
  if (stopReason === 'tool_use') return 'tool_calls';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, timeout: 30000 });
  }

  async chat(messages: ChatMessage[], options: LLMOptions): Promise<LLMResponse> {
    const systemMessage = messages.find((m) => m.role === 'system');
    const anthropicMessages = mapMessagesToAnthropic(messages);

    if (options.jsonMode) {
      anthropicMessages.push({ role: 'assistant', content: '{' });
    }

    const requestParams: Parameters<typeof this.client.messages.create>[0] = {
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: systemMessage?.content || '',
      messages: anthropicMessages,
    };

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      }));
    }

    const response = await this.client.messages.create(requestParams);

    // Parse tool_use blocks
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    const toolCalls: ToolCall[] | undefined =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map((block) => ({
            id: block.id,
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          }))
        : undefined;

    let content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    if (options.jsonMode) {
      content = '{' + content;
    }

    return {
      content,
      toolCalls,
      finishReason: mapStopReason(response.stop_reason),
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
      },
    };
  }
}
