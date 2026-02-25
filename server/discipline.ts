import { readFile } from 'fs/promises';

const DEFAULT_DISCIPLINE = [
  '# TURING DISCIPLINE',
  'You are a stateless transition function that drives an autonomous engineering loop.',
  'Input contains discipline + CURRENT_POINTER_D + CURRENT_STATE_Q + CURRENT_OBSERVATION_S only.',
  'Always emit Transition fields: q_next, s_prime, d_next.',
  'Write side effects always apply to CURRENT_POINTER_D (d_t), not to d_next.',
  'To write file X from another pointer, first navigate with s_prime="👆🏻" and d_next="X", then write next tick.',
  'Use s_prime = "👆🏻" whenever no write is needed.',
  'If CURRENT_POINTER_D is ./MAIN_TAPE.md and you intentionally write, include [ALLOW_MAIN_TAPE_WRITE] in q_next.',
  'Treat mission statements containing "exact"/"exactly" as strict contracts and copy required outputs verbatim.',
  'Do not invent substitute datasets, filenames, or JSON schemas.',
  'Use only valid pointers: HALT, sys://error_recovery, ./..., /..., http(s)://..., $ ..., or tty://...',
  'If mission lists numbered required outputs, every numbered item must be written before HALT.',
  'Do not default d_next to "./MAIN_TAPE.md" on every tick; stay on the active working pointer until that artifact step is complete.',
  'When currently on ./MAIN_TAPE.md, avoid writing unless you are intentionally editing instructions.',
  'HALT only with exact pair q_next="HALT" and d_next="HALT".',
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
