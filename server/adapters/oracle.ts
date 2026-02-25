import OpenAI from 'openai';
import type { IOracle, State, Slice, Transition } from '../engine.js';

const TRANSITION_SCHEMA = {
  type: 'object',
  properties: {
    q_next: { type: 'string', minLength: 1 },
    s_prime: { type: 'string' },
    d_next: { type: 'string', minLength: 1 },
  },
  required: ['q_next', 's_prime', 'd_next'],
  additionalProperties: false,
} as const;

function composeStatelessPrompt(discipline: string, q: State, s: Slice): string {
  return [
    'DISCIPLINE',
    discipline,
    '',
    'CURRENT_STATE_Q',
    q,
    '',
    'CURRENT_OBSERVATION_S',
    s,
  ].join('\n');
}

function toTransition(value: unknown): Transition {
  if (!value || typeof value !== 'object') {
    throw new Error('Oracle output is not an object');
  }

  const parsed = value as Record<string, unknown>;
  const q_next = parsed.q_next;
  const s_prime = parsed.s_prime;
  const d_next = parsed.d_next;

  if (typeof q_next !== 'string' || q_next.trim().length === 0) {
    throw new Error('Oracle output missing q_next');
  }
  if (typeof s_prime !== 'string') {
    throw new Error('Oracle output missing s_prime');
  }
  if (typeof d_next !== 'string' || d_next.trim().length === 0) {
    throw new Error('Oracle output missing d_next');
  }

  return { q_next, s_prime, d_next };
}

export interface StatelessOracleOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  timeoutMs?: number;
}

export class StatelessOracle implements IOracle {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: StatelessOracleOptions = {}) {
    const openaiKey = process.env.OPENAI_API_KEY;
    const kimiKey = process.env.KIMI_API_KEY;
    const apiKey = options.apiKey ?? openaiKey ?? kimiKey;
    if (!apiKey) {
      throw new Error('Missing OPENAI_API_KEY (or KIMI_API_KEY) for StatelessOracle');
    }

    const inferredBaseUrl =
      options.baseURL ??
      process.env.OPENAI_BASE_URL ??
      (!openaiKey && kimiKey ? 'https://api.kimi.com/coding/v1' : undefined);

    this.client = new OpenAI({
      apiKey,
      baseURL: inferredBaseUrl,
    });

    this.model = options.model ?? process.env.ORACLE_MODEL ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
    this.timeoutMs =
      options.timeoutMs ??
      (Number.parseInt(process.env.ORACLE_TIMEOUT_MS ?? '', 10) || 90_000);
  }

  public async collapse(discipline: string, q: State, s: Slice): Promise<Transition> {
    const prompt = composeStatelessPrompt(discipline, q, s);

    const completion = await this.client.chat.completions.create(
      {
        model: this.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are a stateless transition function. Produce the next transition only via the emit_transition function call.',
          },
          { role: 'user', content: prompt },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'emit_transition',
              description: 'Emit a strict Transition object for the next machine tick.',
              parameters: TRANSITION_SCHEMA as any,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: 'emit_transition' },
        },
      } as any,
      {
        timeout: this.timeoutMs,
      },
    );

    const toolCall = completion.choices?.[0]?.message?.tool_calls?.[0] as any;
    const rawArgs = toolCall?.function?.arguments;

    if (!rawArgs) {
      throw new Error('Oracle did not return function arguments');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch (error: any) {
      throw new Error(`Oracle returned invalid JSON arguments: ${error?.message ?? 'unknown parse error'}`);
    }

    return toTransition(parsed);
  }
}

export class ScriptedOracle implements IOracle {
  private index = 0;

  constructor(private readonly script: Transition[]) {}

  public async collapse(_discipline: string, _q: State, _s: Slice): Promise<Transition> {
    if (this.script.length === 0) {
      throw new Error('ScriptedOracle requires at least one scripted transition');
    }

    const next = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return next;
  }
}
