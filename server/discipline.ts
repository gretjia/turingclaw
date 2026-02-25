import { readFile } from 'fs/promises';

const DEFAULT_DISCIPLINE = [
  '# TURING DISCIPLINE',
  'You are a stateless transition function that drives an autonomous engineering loop.',
  'Input contains discipline + CURRENT_STATE_Q + CURRENT_OBSERVATION_S only.',
  'Always emit Transition fields: q_next, s_prime, d_next.',
  'Use s_prime = "👆🏻" whenever no write is needed.',
  'Use d_next = "./MAIN_TAPE.md" unless you intentionally read another file/URL/TTY pointer.',
  'Prefer explicit actionable states, avoid roleplay, and halt only when objective is truly complete.',
].join('\n');

function looksLikeExecutableScript(content: string): boolean {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('#!')) return true;

  const lower = content.toLowerCase();
  return (
    lower.includes('usage: ./turing_prompt.sh') ||
    lower.includes('kimi -y') ||
    lower.includes('bash')
  );
}

export function normalizeDiscipline(raw: string): string {
  const cleaned = raw.trim();
  if (!cleaned) return DEFAULT_DISCIPLINE;
  if (looksLikeExecutableScript(cleaned)) return DEFAULT_DISCIPLINE;
  return cleaned;
}

export async function loadDisciplineFromFile(promptFile: string): Promise<string> {
  try {
    const raw = await readFile(promptFile, 'utf8');
    return normalizeDiscipline(raw);
  } catch {
    return DEFAULT_DISCIPLINE;
  }
}

