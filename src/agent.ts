export type AgentEvent =
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'result'; tool: string; result: unknown }
  | { type: 'answer'; text: string };

export interface Message {
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
}

export type LlmReply =
  | { type: 'answer'; text: string }
  | { type: 'tool_call'; id: string; tool: string; args: unknown };

/** The model behind the agent (Claude Haiku 4.5 in production). Injected so tests can script it. */
export interface Llm {
  next(messages: Message[], tools: ToolSpec[]): Promise<LlmReply>;
}

export interface ToolSpec {
  name: string;
  description: string;
}

export interface Tool extends ToolSpec {
  run(args: unknown): Promise<unknown>;
}

export class StepLimitReached extends Error {
  constructor(readonly steps: number) {
    super(`Stopped after ${steps} steps without an answer`);
  }
}

/**
 * The investigation agent: it plans, calls tools such as the event search,
 * and answers. Every step is emitted as it happens and streamed to the screen
 * over Server-Sent Events.
 *
 * The step limit means a confused model ends in a clear error instead of an
 * endless bill, and an unknown tool is reported back so the model can recover.
 */
export async function investigate(
  question: string,
  llm: Llm,
  tools: Tool[],
  emit: (e: AgentEvent) => void,
  maxSteps = 8,
): Promise<string> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description }) => ({ name, description }));
  const messages: Message[] = [{ role: 'user', content: question }];

  for (let step = 0; step < maxSteps; step++) {
    const reply = await llm.next(messages, specs);
    if (reply.type === 'answer') {
      emit({ type: 'answer', text: reply.text });
      return reply.text;
    }

    emit({ type: 'tool_call', tool: reply.tool, args: reply.args });
    const tool = byName.get(reply.tool);
    const result = tool ? await tool.run(reply.args) : { error: `Unknown tool: ${reply.tool}` };
    emit({ type: 'result', tool: reply.tool, result });
    messages.push({ role: 'assistant', content: reply }, { role: 'tool', content: { id: reply.id, result } });
  }
  throw new StepLimitReached(maxSteps);
}

/** Server-Sent Events framing for one agent event. */
export function toSse(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
