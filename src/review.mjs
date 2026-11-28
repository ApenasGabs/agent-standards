import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import process from 'node:process';
import { applyProfile, ConfigError, configFromDocs, loadProfile, parseConfig, rulesForFile } from './review/config.mjs';
import { parseAddedLines } from './review/diff.mjs';
import { renderReport } from './review/report.mjs';
import { checkFile, isRuleEnabled, isSourceFile, isTestFile, isUiFile } from './review/rules.mjs';
import { extractRequirements, matchRequirements } from './review/spec.mjs';
import { runUxAudit, UX_REPORT_FILE, UxAuditError } from './ux/audit.mjs';
import { resolveAuditConfig, UxConfigError } from './ux/config.mjs';
import { discoverPreviewUrl } from './ux/discover.mjs';
import { groupFindings } from './ux/report.mjs';

const DOC_FILES = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CODING_STANDARDS.md'];

const execCommand = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });

/**
 * Avalia deterministicamente o statusCheckRollup do GitHub (CheckRun e StatusContext).
 */
export const evaluateCIPipeline = (statusCheckRollup = []) => {
  const checks = statusCheckRollup ?? [];
  if (checks.length === 0) {
    return { configured: false, status: 'NO_CHECKS', total: 0, successful: 0, failed: [], timedOut: [], inProgress: [] };
  }
  const is = (...values) => (c) => values.includes(c.conclusion) || values.includes(c.state);
  const failed = checks.filter(is('FAILURE', 'ERROR', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE', 'STALE'));
  const timedOut = checks.filter(is('TIMED_OUT'));
  const successful = checks.filter(is('SUCCESS'));
  const settled = (c) => failed.includes(c) || timedOut.includes(c) || is('SUCCESS', 'NEUTRAL', 'SKIPPED')(c);
  const inProgress = checks.filter((c) => !settled(c));

  let status = 'SUCCESS';
  if (failed.length > 0) status = 'FAILURE';
  else if (timedOut.length > 0) status = 'TIMED_OUT';
  else if (inProgress.length > 0) status = 'IN_PROGRESS';

  return { configured: true, status, total: checks.length, successful: successful.length, failed, timedOut, inProgress };
};

const attempt = (fn) => {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).trim().split('\n')[0] };
  }
};

const loadTask = (run, requested, branch) => {
  const id = String(requested || branch.match(/#(\d+)/)?.[1] || '').replace(/^#/, '');
  if (!id) return { title: 'Tarefa não identificada', source: 'nenhuma issue vinculada', requirements: [] };
  if (!/^\d+$/.test(id)) return { title: 'Tarefa inválida', source: id, requirements: [], problem: `--task espera o número da issue, recebeu "${id}".` };
  const res = attempt(() => JSON.parse(run('gh', ['issue', 'view', id, '--json', 'title,body'])));
  if (!res.ok) {
    return { title: `Issue #${id}`, source: `Issue #${id}`, requirements: [], problem: `Não foi possível ler a issue #${id}: ${res.error}` };
  }
  return { title: res.value.title, source: `Issue #${id}`, requirements: extractRequirements(res.value.body ?? '') };
};

/**
 * Lê a configuração da base, para que a própria mudança não afrouxe as regras que a avaliam.
 */
const loadConfig = (run, mergeBase, head) => {
  const show = (ref, file) => attempt(() => run('git', ['show', `${ref}:${file}`]));
  const atBase = show(mergeBase, 'agent.config.json');
  const atHead = show(head, 'agent.config.json');
  const notes = [];
  if (atBase.ok && (!atHead.ok || atHead.value !== atBase.value)) {
    notes.push('agent.config.json mudou nesta entrega; a avaliação usou a versão da base. Confirme a mudança de regras.');
    if (atHead.ok) parseConfig(atHead.value);
  } else if (!atBase.ok && atHead.ok) {
    notes.push('agent.config.json foi criado nesta entrega. Confirme as regras adotadas.');
  }
  if (atBase.ok || atHead.ok) return { config: parseConfig(atBase.ok ? atBase.value : atHead.value), notes };
  const docs = DOC_FILES.map((file) => ({ file, res: show(head, file) }))
    .filter((d) => d.res.ok)
    .map((d) => ({ file: d.file, text: d.res.value }));
  return { config: configFromDocs(docs), notes: ['Sem agent.config.json: regras deduzidas da documentação.'] };
};

const collectFindings = (run, files, config, head, problems) => {
  const divergences = [];
  for (const [file, { lines }] of files) {
    if (lines.size === 0) continue;
    const content = attempt(() => run('git', ['show', `${head}:${file}`]));
    if (!content.ok) {
      problems.push(`Não foi possível ler ${file}: ${content.error}`);
      continue;
    }
    divergences.push(...checkFile({ file, content: content.value, addedLines: lines, rules: rulesForFile(config, file), source: config.source }));
  }
  const names = [...files.keys()];
  const source = names.filter(isSourceFile);
  if (source.length > 0 && !names.some(isTestFile)) {
    divergences.push({
      axis: 'Standards',
      ruleId: 'missing-tests',
      severity: 'medium',
      file: source[0],
      line: 1,
      docRef: 'baseline',
      description: `${source.length} arquivo(s) de código alterado(s) sem teste novo ou atualizado.`,
      snippet: null,
    });
  }
  return divergences;
};

const loadCI = (run, branch, headSha) => {
  const res = attempt(() => JSON.parse(run('gh', ['pr', 'view', branch, '--json', 'number,statusCheckRollup,url,headRefOid,state'])));
  if (!res.ok || res.value.state !== 'OPEN') return evaluateCIPipeline([]);
  const ci = { ...evaluateCIPipeline(res.value.statusCheckRollup), prNumber: res.value.number, prUrl: res.value.url };
  // Checks de outro commit não dizem nada sobre o código avaliado.
  return res.value.headRefOid === headSha ? ci : { ...ci, status: 'OUTDATED', failed: [], timedOut: [] };
};

/**
 * Eixo UX renderizado: com a seção `ux` na config da base, mudança de UI só passa com
 * auditoria (`agent-standards ux-audit`) do mesmo commit.
 */
const loadUxAudit = (targetDir, config, files, headSha) => {
  if (!config.ux) return { state: 'disabled' };
  const uiFiles = [...files.keys()].filter(isUiFile);
  if (uiFiles.length === 0) return { state: 'not-required' };
  const path = resolve(targetDir, typeof config.ux.outDir === 'string' ? config.ux.outDir : '.ux-review', UX_REPORT_FILE);
  const report = relative(targetDir, path);
  if (!existsSync(path)) return { state: 'missing', uiFiles: uiFiles.length, report };
  const parsed = attempt(() => JSON.parse(readFileSync(path, 'utf-8')));
  if (!parsed.ok || !Array.isArray(parsed.value?.matrix)) return { state: 'invalid', uiFiles: uiFiles.length, report };
  if (parsed.value.head !== headSha) return { state: 'outdated', uiFiles: uiFiles.length, report, auditedHead: parsed.value.head };
  return { state: 'ok', uiFiles: uiFiles.length, report, summary: parsed.value.summary, groups: groupFindings(parsed.value.matrix) };
};

const UX_NOTES = {
  missing: (a) => `A mudança altera ${a.uiFiles} arquivo(s) de UI e não há auditoria renderizada deste commit: rode \`agent-standards ux-audit\` e revise os screenshots.`,
  outdated: (a) => `A auditoria renderizada em \`${a.report}\` é de outro commit (${String(a.auditedHead).slice(0, 7)}); rode \`agent-standards ux-audit\` de novo.`,
  invalid: (a) => `\`${a.report}\` não é um relatório válido do ux-audit; rode \`agent-standards ux-audit\` de novo.`,
};

const uxDivergences = (audit) =>
  (audit.groups ?? []).map((g) => ({
    axis: 'UX',
    ruleId: g.ruleId,
    severity: g.severity,
    file: `render ${g.where[0]}${g.where.length > 1 ? ` (+${g.where.length - 1})` : ''}`,
    line: null,
    docRef: 'ux-audit',
    description: g.description,
    snippet: g.selector,
  }));

/**
 * `--ux-audit auto`: com UI alterada e sem auditoria deste commit, descobre o preview e audita antes de avaliar.
 * Quando não dá (sem preview, sem navegador), devolve o motivo para o relatório em vez de falhar o review.
 */
const autoUxAudit = async ({ run, targetDir, ux, head, options }) => {
  let url = typeof ux.baseUrl === 'string' && ux.baseUrl !== 'auto' ? ux.baseUrl : null;
  if (!url) {
    const found = attempt(() => discoverPreviewUrl(run, head));
    if (!found.ok) return { note: `ux-audit automático não rodou: falha ao consultar os deployments do GitHub (${found.error}).` };
    if (!found.value) return { note: 'ux-audit automático não rodou: nenhum preview publicado para este commit. Rode `agent-standards ux-audit --url <url>`.' };
    url = found.value.url;
  }
  try {
    const config = resolveAuditConfig(ux, { url, routes: options.uxRoutes });
    await (options.uxAuditRunner ?? runUxAudit)({ target: targetDir, config, env: options.env ?? process.env });
    return { url };
  } catch (err) {
    if (err instanceof UxAuditError || err instanceof UxConfigError) return { note: `ux-audit automático não rodou: ${err.message}` };
    throw err;
  }
};

const decideStatus = ({ problems, divergences, requirements, ci, notes, hasRules, unverified }) => {
  if (problems.length > 0) return 'INCONCLUSIVE';
  if (divergences.some((d) => d.severity === 'hard') || ci.failed.length > 0 || ci.timedOut.length > 0) return 'NEEDS_CHANGES';
  const pending =
    divergences.length > 0 ||
    requirements.length > 0 ||
    unverified.length > 0 ||
    notes.length > 0 ||
    !hasRules ||
    ci.status === 'IN_PROGRESS' ||
    ci.status === 'OUTDATED';
  return pending ? 'NEEDS_CONFIRMATION' : 'APPROVED';
};

export const runCodeReview = async (userOptions = {}) => {
  const options = { target: process.cwd(), base: 'origin/main', head: 'HEAD', task: '', output: 'REVIEW_REPORT.md', exec: execCommand, ...userOptions };
  const targetDir = resolve(options.target);
  const run = (command, args) => options.exec(command, args, targetDir);
  const problems = [];
  const notes = [];
  let config = configFromDocs([]);
  let files = new Map();
  let divergences = [];
  let uxAudit = { state: 'disabled' };
  const profileName = options.profile ?? process.env.AGENT_STANDARDS_PROFILE;
  const profile = attempt(() => loadProfile(profileName, targetDir));
  if (!profile.ok) problems.push(profile.error);

  const branch = attempt(() => run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).value ?? '';
  const refs = attempt(() => {
    const head = run('git', ['rev-parse', '--verify', '--end-of-options', `${options.head}^{commit}`]).trim();
    const base = run('git', ['rev-parse', '--verify', '--end-of-options', `${options.base}^{commit}`]).trim();
    return { head, mergeBase: run('git', ['merge-base', base, head]).trim() };
  });

  if (!refs.ok) {
    problems.push(`Não foi possível comparar ${options.base} com ${options.head}: ${refs.error}`);
  } else {
    const { head, mergeBase } = refs.value;
    const diff = attempt(() =>
      run('git', ['-c', 'core.quotePath=off', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, head, '--'])
    );
    if (!diff.ok) problems.push(`Falha ao gerar o diff: ${diff.error}`);
    else if (!diff.value.trim()) problems.push('O diff está vazio: não há mudança commitada para avaliar.');
    else files = parseAddedLines(diff.value);
    try {
      const loaded = loadConfig(run, mergeBase, head);
      config = applyProfile(loaded.config, profile.value);
      notes.push(...loaded.notes);
      divergences = collectFindings(run, files, config, head, problems);
      uxAudit = loadUxAudit(targetDir, config, files, head);
      if (options.uxAudit === 'auto' && ['missing', 'outdated', 'invalid'].includes(uxAudit.state)) {
        const ran = await autoUxAudit({ run, targetDir, ux: config.ux, head, options });
        if (ran.note) notes.push(ran.note);
        else uxAudit = { ...loadUxAudit(targetDir, config, files, head), url: ran.url };
      }
      if (UX_NOTES[uxAudit.state]) notes.push(UX_NOTES[uxAudit.state](uxAudit));
      divergences.push(...uxDivergences(uxAudit));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(err.message);
    }
    const dirty = attempt(() => run('git', ['status', '--porcelain', '--untracked-files=no']).trim());
    if (options.head === 'HEAD' && dirty.value) notes.push('Há alterações não commitadas, que não foram avaliadas.');
  }

  const task = loadTask(run, options.task, branch);
  if (task.problem) problems.push(task.problem);
  const requirements = matchRequirements(task.requirements, files);
  const ci = refs.ok ? loadCI(run, branch, refs.value.head) : evaluateCIPipeline([]);
  const hasRules = [config.rules, ...config.overrides.map((o) => o.rules)].some(isRuleEnabled);
  const { unverified } = config;
  const status = decideStatus({ problems, divergences, requirements, ci, notes, hasRules, unverified });

  const result = {
    appName: basename(targetDir),
    status,
    base: options.base,
    head: options.head,
    task: { title: task.title, source: task.source },
    ruleSource: config.source,
    requirements,
    divergences,
    unverified,
    problems,
    notes,
    ci,
    uxAudit: { state: uxAudit.state, report: uxAudit.report ?? null, summary: uxAudit.summary ?? null, url: uxAudit.url ?? null },
    profile: profile.value?.name ?? null,
  };
  const reportPath = resolve(targetDir, options.output);
  writeFileSync(reportPath, renderReport(result), 'utf-8');
  return { ...result, divergencesCount: divergences.length, reportPath };
};
