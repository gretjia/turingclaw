import OpenAI from 'openai';
import type { IOracle, Pointer, State, Slice, Transition } from '../engine.js';
import { applyTransitionGuard } from '../control/transition_guard.js';

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

function composeStatelessPrompt(discipline: string, q: State, s: Slice, d: Pointer): string {
  return [
    'DISCIPLINE',
    discipline,
    '',
    'MACHINE_PROTOCOL',
    '1) This call is stateless. Use only this prompt contents.',
    '2) Write side effects always apply to CURRENT_POINTER_D (d_t), never to d_next.',
    '3) To write file X when CURRENT_POINTER_D is not X:',
    '   - First emit s_prime=\"👆🏻\" and d_next=\"X\" (navigation step).',
    '   - On next tick, emit s_prime with file content while CURRENT_POINTER_D is X.',
    '4) If no write is needed this tick, set s_prime=\"👆🏻\".',
    '5) If CURRENT_POINTER_D is ./MAIN_TAPE.md and you intentionally write, include [ALLOW_MAIN_TAPE_WRITE] in q_next.',
    '6) Any requirement in observation marked as \"exact\"/\"exactly\" is mandatory and must be copied verbatim.',
    '7) Do not invent substitute datasets or filenames; follow the mission text literally.',
    '8) d_next must be a valid pointer: HALT, sys://error_recovery, ./..., /..., http(s)://..., $ ..., or tty://...',
    '9) If mission lists numbered required outputs, complete every numbered item before HALT.',
    '10) HALT only with exact pair: q_next=\"HALT\" and d_next=\"HALT\" after all required artifacts are written.',
    '',
    'CURRENT_POINTER_D',
    d,
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

  return { q_next, s_prime, d_next: normalizePointer(d_next) };
}

function normalizePointer(raw: string): string {
  let pointer = raw.trim();
  pointer = pointer.replace(/^['"`]+|['"`]+$/g, '').trim();
  pointer = pointer.replace(/^[<(]+|[)>]+$/g, '').trim();
  pointer = pointer.replace(/[;,]+$/, '').trim();
  if (!pointer) return 'sys://trap/invalid_pointer';

  if (pointer === 'MAIN_TAPE.md') {
    return './MAIN_TAPE.md';
  }

  if (pointer === 'HALT' || pointer === 'sys://error_recovery') {
    return pointer;
  }

  if (
    pointer.startsWith('./') ||
    pointer.startsWith('/') ||
    pointer.startsWith('http://') ||
    pointer.startsWith('https://') ||
    pointer.startsWith('$ ') ||
    pointer.startsWith('tty://')
  ) {
    return pointer;
  }

  if (
    /^[A-Za-z0-9._/-]{1,240}$/.test(pointer) &&
    !pointer.includes('..') &&
    (pointer.includes('/') || pointer.includes('.'))
  ) {
    return pointer;
  }

  return 'sys://trap/invalid_pointer';
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  let candidate = trimmed;
  if (candidate.startsWith('```')) {
    candidate = candidate
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
  }

  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return candidate.slice(firstBrace, lastBrace + 1);
  }

  return candidate;
}

function parseTransitionPayload(raw: string): Transition {
  const attempts = [raw, extractJsonCandidate(raw)];
  let parseError: string | null = null;

  for (const candidate of attempts) {
    if (!candidate.trim()) continue;
    try {
      return toTransition(JSON.parse(candidate));
    } catch (error: any) {
      parseError = error?.message ?? 'unknown parse error';
    }
  }

  throw new Error(`Oracle returned invalid JSON arguments: ${parseError ?? 'unable to parse payload'}`);
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (part && typeof part === 'object' && 'text' in part) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }

  return parts.join('\n').trim();
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
  private readonly usingKimi: boolean;
  private readonly seed: number | null;

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

    this.usingKimi =
      (inferredBaseUrl ?? '').includes('api.kimi.com') ||
      (!openaiKey && Boolean(kimiKey) && !options.baseURL && !process.env.OPENAI_BASE_URL);

    this.client = new OpenAI({
      apiKey,
      baseURL: inferredBaseUrl,
      defaultHeaders: this.usingKimi
        ? {
            'X-Client-Name': process.env.ORACLE_CLIENT_NAME ?? 'TuringClaw',
            'User-Agent': process.env.ORACLE_USER_AGENT ?? 'claude-code/0.2.15',
          }
        : undefined,
    });

    this.model =
      options.model ??
      process.env.ORACLE_MODEL ??
      process.env.OPENAI_MODEL ??
      (this.usingKimi ? 'kimi-for-coding' : 'gpt-4.1-mini');
    this.timeoutMs =
      options.timeoutMs ??
      (Number.parseInt(process.env.ORACLE_TIMEOUT_MS ?? '', 10) || 90_000);
    const parsedSeed = Number.parseInt(process.env.ORACLE_SEED ?? '7', 10);
    this.seed = Number.isFinite(parsedSeed) ? parsedSeed : null;
  }

  public async collapse(discipline: string, q: State, s: Slice, d: Pointer = './MAIN_TAPE.md'): Promise<Transition> {
    const prompt = composeStatelessPrompt(discipline, q, s, d);
    let lastError: Error | null = null;
    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const retryNotice =
        attempt > 1 && lastError
          ? `Previous output failed validation (${lastError.message}). Return valid JSON arguments only.`
          : null;

      const request: any = {
        model: this.model,
        temperature: 0,
        top_p: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are a stateless transition function. Produce the next transition only via the emit_transition function call.',
          },
          ...(retryNotice ? [{ role: 'system', content: retryNotice }] : []),
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
      };

      if (this.seed !== null) {
        request.seed = this.seed;
      }

      if (this.usingKimi) {
        request.thinking = { type: 'disabled' };
      }

      const completion = await this.client.chat.completions.create(
        request,
        {
          timeout: this.timeoutMs,
        },
      );

      const message = completion.choices?.[0]?.message as any;
      const toolCall = message?.tool_calls?.[0] as any;
      const rawArgs = toolCall?.function?.arguments;

      try {
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          const parsed = parseTransitionPayload(rawArgs);
          return applyTransitionGuard(parsed, { currentState: q, currentPointer: d }).transition;
        }

        const contentText = messageContentToText(message?.content);
        if (contentText) {
          const parsed = parseTransitionPayload(contentText);
          return applyTransitionGuard(parsed, { currentState: q, currentPointer: d }).transition;
        }

        throw new Error('Oracle did not return function arguments');
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error('Oracle failed to produce a valid transition');
  }
}

export class ScriptedOracle implements IOracle {
  private index = 0;

  constructor(private readonly script: Transition[]) {}

  public async collapse(_discipline: string, _q: State, _s: Slice, _d: Pointer = './MAIN_TAPE.md'): Promise<Transition> {
    if (this.script.length === 0) {
      throw new Error('ScriptedOracle requires at least one scripted transition');
    }

    const next = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return next;
  }
}
