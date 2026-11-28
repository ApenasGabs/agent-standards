import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Despacho de retrabalho para o Paperclip quando um agente de IA entrega algo reprovado.
 * Toda a configuração vem do ambiente: nenhum endereço, ID ou token mora no repositório.
 */

// Palavras inteiras: o script legado casava "ai" dentro de qualquer palavra ("mais", "falhas").
const AI_MARKERS = /\b(?:bot|agent|agente|paperclip|forge|sentinel|mender|scribe|lens|kraken|claude|gemini|antigravity|copilot)\b|\[bot\]|\bAPE-\d+\b/i;

/**
 * @param {(command: string, args: string[]) => string} run executor git já posicionado no repositório
 * @param {'ai'|'human'|'auto'} forced valor de `--author`
 */
export const detectAuthor = (run, forced = 'auto') => {
  if (forced === 'ai' || forced === 'human') return { type: forced, evidence: '--author' };
  const read = (args) => {
    try {
      return run('git', args).trim();
    } catch {
      // Sem histórico legível: trata como humano para nunca despachar por engano.
      return '';
    }
  };
  const name = read(['log', '-1', '--format=%an']);
  const message = read(['log', '-1', '--format=%B']);
  const branch = read(['rev-parse', '--abbrev-ref', 'HEAD']);
  for (const [where, text] of [['autor', name], ['branch', branch], ['mensagem', message]]) {
    const hit = text.match(AI_MARKERS);
    if (hit) return { type: 'ai', evidence: `${where}: ${hit[0]}` };
  }
  return { type: 'human', evidence: 'nenhum marcador de agente no autor, branch ou mensagem' };
};

const REQUIRED = ['PAPERCLIP_URL', 'PAPERCLIP_COMPANY_ID', 'PAPERCLIP_PROJECT_ID', 'PAPERCLIP_DISPATCH_AGENT_ID'];

export const dispatchConfig = (env = process.env) => {
  let token = env.PAPERCLIP_API_KEY || '';
  if (!token && env.PAPERCLIP_TOKEN_FILE) {
    try {
      token = readFileSync(env.PAPERCLIP_TOKEN_FILE, 'utf-8').trim();
    } catch {
      // Arquivo ilegível conta como token ausente e aparece em `missing`.
    }
  }
  const missing = [...REQUIRED.filter((k) => !env[k]), ...(token ? [] : ['PAPERCLIP_API_KEY ou PAPERCLIP_TOKEN_FILE'])];
  return {
    missing,
    url: (env.PAPERCLIP_URL || '').replace(/\/+$/, ''),
    token,
    companyId: env.PAPERCLIP_COMPANY_ID,
    projectId: env.PAPERCLIP_PROJECT_ID,
    agentId: env.PAPERCLIP_DISPATCH_AGENT_ID,
  };
};

/** Corpo da issue: só o que bloqueia (graves, CI e motivos de inconclusivo), com arquivo e linha. */
export const buildReworkIssue = (result) => {
  const where = (d) => (d.line ? `${d.file}:${d.line}` : d.file);
  const hard = result.divergences.filter((d) => d.severity === 'hard');
  const ci = [...(result.ci?.failed ?? []), ...(result.ci?.timedOut ?? [])];
  const lines = [
    `O review de \`${result.appName}\` reprovou a entrega (${result.task?.source ?? 'sem tarefa'}).`,
    '',
    '## Bloqueios',
    ...hard.map((d) => `- [${d.axis}] \`${where(d)}\` **${d.ruleId}**: ${d.description}`),
    ...ci.map((c) => `- [CI] ${c.name ?? c.context}: ${c.detailsUrl ?? c.targetUrl ?? ''}`),
    ...(result.problems ?? []).map((p) => `- [Inconclusivo] ${p}`),
    '',
    `Relatório completo: \`${result.reportPath}\`. Corrija na mesma branch, rode os testes e o review de novo antes de devolver.`,
  ];
  return {
    title: `fix(review): corrigir bloqueios do review em ${result.appName}${result.task?.source ? ` (${result.task.source})` : ''}`,
    description: lines.join('\n'),
  };
};

const mask = (text) => String(text).replace(/(Bearer\s+)\S+/gi, '$1***');

/**
 * @returns {Promise<{ dispatched: boolean, reason?: string, issue?: string, warning?: string }>}
 */
export const dispatchRework = async ({ result, env = process.env, fetchImpl = globalThis.fetch }) => {
  const cfg = dispatchConfig(env);
  if (cfg.missing.length > 0) return { dispatched: false, reason: `faltam variáveis de ambiente: ${cfg.missing.join(', ')}` };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` };
  const issue = buildReworkIssue(result);
  try {
    const res = await fetchImpl(`${cfg.url}/api/companies/${cfg.companyId}/issues`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...issue, status: 'todo', priority: 'high', projectId: cfg.projectId, assigneeAgentId: cfg.agentId }),
    });
    if (!res.ok) return { dispatched: false, reason: `o Paperclip respondeu HTTP ${res.status} ao criar a issue` };
    const created = await res.json();
    const key = created.identifier ?? created.key ?? created.id ?? 'criada';
    const wake = await fetchImpl(`${cfg.url}/api/agents/${cfg.agentId}/wakeup`, { method: 'POST', headers, body: JSON.stringify({ reason: 'issue_assigned' }) }).catch((err) => ({ ok: false, status: mask(err.message) }));
    return { dispatched: true, issue: String(key), ...(wake.ok ? {} : { warning: `issue criada, mas o wakeup do agente falhou (${wake.status})` }) };
  } catch (err) {
    return { dispatched: false, reason: `falha ao contatar o Paperclip: ${mask(err.message)}` };
  }
};
