import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

const runCmd = (cmd, cwd = process.cwd()) => {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    return '';
  }
};

/**
 * Avalia deterministicamente o array de statusCheckRollup do GitHub Actions / CI
 */
export const evaluateCIPipeline = (statusCheckRollup = []) => {
  if (!statusCheckRollup || statusCheckRollup.length === 0) {
    return {
      configured: false,
      status: 'NO_CHECKS',
      total: 0,
      successful: 0,
      failed: [],
      timedOut: [],
      inProgress: [],
    };
  }

  const failed = statusCheckRollup.filter(
    (c) => c.conclusion === 'FAILURE' || c.conclusion === 'ACTION_REQUIRED' || c.conclusion === 'CANCELLED'
  );
  const timedOut = statusCheckRollup.filter((c) => c.conclusion === 'TIMED_OUT');
  const successful = statusCheckRollup.filter((c) => c.conclusion === 'SUCCESS');
  const inProgress = statusCheckRollup.filter(
    (c) => c.status === 'IN_PROGRESS' || c.status === 'QUEUED' || c.status === 'PENDING'
  );

  let status = 'SUCCESS';
  if (failed.length > 0) status = 'FAILURE';
  else if (timedOut.length > 0) status = 'TIMED_OUT';
  else if (inProgress.length > 0) status = 'IN_PROGRESS';

  return {
    configured: true,
    status,
    total: statusCheckRollup.length,
    successful: successful.length,
    failed,
    timedOut,
    inProgress,
  };
};

export const runCodeReview = async (userOptions = {}) => {
  const options = {
    target: process.cwd(),
    base: 'origin/main',
    head: 'HEAD',
    task: '',
    author: 'auto',
    output: 'REVIEW_REPORT.md',
    patch: 'review-fixes.patch',
    dispatch: false,
    json: false,
    ...userOptions,
  };

  const targetDir = resolve(options.target);
  const appName = basename(targetDir);

  // 1. Carregar Configuração Local (agent.config.json) se existir
  let activeRules = [];
  const configPath = join(targetDir, 'agent.config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const r = config.rules || {};

      if (r.functions === 'arrow-only') {
        activeRules.push({
          id: 'arrow-functions-only',
          doc: 'agent.config.json § rules.functions',
          rule: 'Apenas arrow functions (const fn = () => {}) — nunca function tradicional.',
          severity: 'hard',
        });
      }

      if (r.typescript?.noExplicitAny) {
        activeRules.push({
          id: 'no-explicit-any',
          doc: 'agent.config.json § rules.typescript.noExplicitAny',
          rule: 'Nunca usar `any` em tipagens; utilizar `unknown` ou interfaces tipadas.',
          severity: 'hard',
        });
      }

      if (r.security?.blockInnerHTML) {
        activeRules.push({
          id: 'no-inner-html',
          doc: 'agent.config.json § rules.security.blockInnerHTML',
          rule: 'Nunca utilizar `innerHTML` com entradas de usuário (risco XSS).',
          severity: 'hard',
        });
      }

      if (r.ui?.requireDataTestId) {
        activeRules.push({
          id: 'require-data-testid',
          doc: 'agent.config.json § rules.ui.requireDataTestId',
          rule: 'Elementos interativos de UI devem conter atributo `data-testid`.',
          severity: 'medium',
        });
      }

      if (r.cleanCode?.blockConsoleLog) {
        activeRules.push({
          id: 'fowler-dead-code-console',
          doc: 'agent.config.json § rules.cleanCode.blockConsoleLog',
          rule: 'Remover `console.log` e depurações residuais.',
          severity: 'medium',
        });
      }
    } catch (err) {
      // Fallback para descoberta de arquivos quando agent.config.json não puder ser lido
    }
  }

  // Se não há agent.config.json ou poucas regras, inspeciona arquivos de documentação
  if (activeRules.length === 0) {
    const docFiles = ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', 'CODING_STANDARDS.md'];
    for (const df of docFiles) {
      const p = join(targetDir, df);
      if (existsSync(p)) {
        const text = readFileSync(p, 'utf-8');
        if (text.includes('arrow functions') || text.includes('arrow function')) {
          activeRules.push({ id: 'arrow-functions-only', doc: df, rule: 'Arrow functions obrigatórias', severity: 'hard' });
        }
        if (text.includes('any') && text.includes('NUNCA usar any')) {
          activeRules.push({ id: 'no-explicit-any', doc: df, rule: 'Proibido any', severity: 'hard' });
        }
        if (text.includes('innerHTML')) {
          activeRules.push({ id: 'no-inner-html', doc: df, rule: 'Proibido innerHTML', severity: 'hard' });
        }
      }
    }
  }

  // 2. Extrair Tarefa
  let taskTitle = 'Tarefa Geral';
  let taskSource = 'Branch / Git Log';
  let requirements = [];

  const branch = runCmd('git rev-parse --abbrev-ref HEAD', targetDir);
  const match = branch.match(/#(\d+)/);
  if (match) {
    const taskId = match[1];
    taskSource = `Issue #${taskId}`;
    const jsonStr = runCmd(`gh issue view ${taskId} --json title,body`, targetDir);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        taskTitle = parsed.title;
        const lines = parsed.body.split('\n');
        for (const l of lines) {
          const itemMatch = l.trim().match(/^(?:(?:\d+\.|\-|\*|\[\s*\])\s+)(.+)$/);
          if (itemMatch && itemMatch[1].length > 5) {
            requirements.push({ text: itemMatch[1].trim() });
          }
        }
      } catch (err) {
        // Ignora erro ao parsear JSON ou requisitos da issue
      }
    }
  }

  // 3. Capturar Diff
  let baseRef = options.base;
  if (!runCmd(`git rev-parse --verify ${baseRef}`, targetDir)) {
    baseRef = 'HEAD~1';
  }

  const diffText = runCmd(`git diff ${baseRef}...${options.head}`, targetDir) || runCmd('git diff HEAD', targetDir);
  const adherence = [];
  const divergences = [];

  if (diffText) {
    const fileDiffs = diffText.split(/^diff --git /m).filter(Boolean);
    for (const fDiff of fileDiffs) {
      const header = fDiff.split('\n')[0];
      const matchPath = header.match(/b\/(.+)/);
      const filePath = matchPath ? matchPath[1] : '';

      const lines = fDiff.split('\n');
      let lineNum = 0;

      for (const line of lines) {
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
          lineNum = parseInt(hunkMatch[1], 10) - 1;
          continue;
        }

        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineNum++;
          const content = line.substring(1);

          // Verificar regras ativas
          for (const rule of activeRules) {
            if (rule.id === 'arrow-functions-only' && /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.test(content)) {
              divergences.push({
                axis: 'Standards',
                file: filePath,
                line: lineNum,
                ruleId: rule.id,
                docRef: rule.doc,
                description: rule.rule,
                snippet: content,
                suggestion: content.replace(/function\s+([A-Za-z0-9_]+)\s*\((.*?)\)/, 'const $1 = ($2) =>'),
              });
            } else if (rule.id === 'no-explicit-any' && /:\s*any\b|<any>|\bas\s+any\b/.test(content)) {
              divergences.push({
                axis: 'Standards',
                file: filePath,
                line: lineNum,
                ruleId: rule.id,
                docRef: rule.doc,
                description: rule.rule,
                snippet: content,
                suggestion: content.replace(/:\s*any\b/, ': unknown'),
              });
            } else if (rule.id === 'no-inner-html' && content.includes('.innerHTML =')) {
              divergences.push({
                axis: 'Standards',
                file: filePath,
                line: lineNum,
                ruleId: rule.id,
                docRef: rule.doc,
                description: rule.rule,
                snippet: content,
                suggestion: 'Utilize textContent ou React nodes seguros.',
              });
            }
          }
        }
      }
    }
  }

  // 4. Inspecionar Pipeline de CI/CD (GitHub Actions / checks remotos)
  let pipelineInfo = null;
  const prJson = runCmd('gh pr view --json number,statusCheckRollup,url', targetDir);
  if (prJson) {
    try {
      const parsedPr = JSON.parse(prJson);
      const evalResult = evaluateCIPipeline(parsedPr.statusCheckRollup);
      if (evalResult.configured) {
        pipelineInfo = {
          ...evalResult,
          prNumber: parsedPr.number,
          prUrl: parsedPr.url,
        };

        if (evalResult.status === 'FAILURE' || evalResult.status === 'TIMED_OUT') {
          const blockingChecks = [...(evalResult.failed || []), ...(evalResult.timedOut || [])];
          for (const f of blockingChecks) {
            const isTimeout = f.conclusion === 'TIMED_OUT';
            divergences.push({
              axis: 'Pipeline',
              file: f.workflowName || 'CI',
              line: 1,
              ruleId: isTimeout ? 'ci-pipeline-timeout' : 'ci-pipeline-failed',
              docRef: 'GitHub Actions / CI Gate',
              description: isTimeout
                ? `A verificação "${f.name}" excedeu o tempo limite (TIMED_OUT) no GitHub Actions.`
                : `A verificação "${f.name}" falhou no GitHub Actions.`,
              snippet: null,
              suggestion: `Consulte os logs da falha em: ${f.detailsUrl}`,
            });
          }
        }
      }
    } catch (err) {
      // Ignora erro de consulta ou parse do PR para manter resiliência
    }
  }

  // 5. Gerar Relatório
  let pipeBadge = '⚪ Não configurado';
  let pipeDetails = 'Nenhum check remoto registrado';

  if (pipelineInfo && pipelineInfo.configured) {
    if (pipelineInfo.status === 'SUCCESS') {
      pipeBadge = '🟢 Passing';
      pipeDetails = `${pipelineInfo.successful}/${pipelineInfo.total} checks passando no PR #${pipelineInfo.prNumber}`;
    } else if (pipelineInfo.status === 'FAILURE') {
      pipeBadge = '🔴 Failing';
      pipeDetails = `${pipelineInfo.failed.length} check(s) falhando no PR #${pipelineInfo.prNumber}`;
    } else if (pipelineInfo.status === 'TIMED_OUT') {
      pipeBadge = '🔴 Timed Out';
      pipeDetails = `${pipelineInfo.timedOut.length} check(s) com timeout no PR #${pipelineInfo.prNumber}`;
    } else if (pipelineInfo.status === 'IN_PROGRESS') {
      pipeBadge = '🟡 In Progress';
      pipeDetails = `${pipelineInfo.inProgress.length} check(s) em execução no PR #${pipelineInfo.prNumber}`;
    }
  }

  let md = `# 🛡️ Relatório de Code Review — ${appName}\n\n`;
  md += `> **Data**: ${new Date().toLocaleString('pt-BR')}  \n`;
  md += `> **Status**: ${divergences.length === 0 ? '🟢 Aprovado' : '🔴 Requer Ajustes'}  \n`;
  md += `> **Tarefa**: ${taskTitle} (${taskSource})  \n\n`;

  md += `## 1. 📊 Resumo Executivo\n\n`;
  md += `| Eixo / Métrica | Status | Detalhes |\n`;
  md += `| :--- | :--- | :--- |\n`;
  md += `| **Status Geral** | ${divergences.length === 0 ? '🟢 Aprovado' : '🔴 Requer Ajustes'} | ${divergences.length === 0 ? 'Código aprovado para merge' : `${divergences.length} divergência(s) detectada(s)`} |\n`;
  md += `| **Pipeline CI/CD** | ${pipeBadge} | ${pipeDetails} |\n`;
  md += `| **Regras Ativas** | 🛡️ Conforme | ${activeRules.length} regra(s) aplicadas |\n`;
  md += `| **Divergências** | ${divergences.length === 0 ? '✅ 0' : `⚠️ ${divergences.length}`} | ${divergences.length === 0 ? 'Nenhum desvio detectado' : 'Requer resolução antes do merge'} |\n\n`;

  if (pipelineInfo && pipelineInfo.configured) {
    md += `## 2. 🚦 Pipeline de CI/CD (GitHub Actions)\n\n`;
    const blocking = [...(pipelineInfo.failed || []), ...(pipelineInfo.timedOut || [])];
    if (blocking.length > 0) {
      md += `### ❌ Checks Reprovados na Pipeline:\n\n`;
      for (const f of blocking) {
        md += `- 🔴 **${f.name}** (${f.workflowName || 'Workflow'}): [Ver logs no GitHub Actions](${f.detailsUrl})\n`;
      }
      md += `\n`;
    }

    if (pipelineInfo.inProgress && pipelineInfo.inProgress.length > 0) {
      md += `### 🟡 Checks em Andamento:\n\n`;
      for (const p of pipelineInfo.inProgress) {
        md += `- 🟡 **${p.name}** (${p.workflowName || 'Workflow'}): [Acompanhar execução no GitHub Actions](${p.detailsUrl})\n`;
      }
      md += `\n`;
    }

    if (pipelineInfo.successful > 0) {
      md += `### ✅ Jobs Aprovados:\n\n`;
      md += `> **${pipelineInfo.successful} de ${pipelineInfo.total}** checks concluídos com sucesso no [PR #${pipelineInfo.prNumber}](${pipelineInfo.prUrl}).\n\n`;
    }
  }

  if (divergences.length > 0) {
    md += `## 3. ❌ Divergências Detectadas\n\n`;
    for (const d of divergences) {
      md += `### 🔴 [\`${d.file}:${d.line}\`](file://${join(targetDir, d.file)}#L${d.line})\n`;
      md += `- **Eixo**: \`${d.axis || 'Standards'}\`\n`;
      md += `- **Regra**: \`${d.ruleId}\`\n`;
      md += `- **Fonte**: **${d.docRef}**\n`;
      md += `- **Detalhes**: ${d.description}\n`;
      if (d.snippet) {
        md += `\`\`\`typescript\n${d.snippet}\n\`\`\`\n`;
      }
      md += `- **Sugestão**: \`${d.suggestion}\`\n\n`;
    }
  } else {
    md += `## 3. 🎯 Conformidade de Padrões\n\n`;
    md += `> ✅ **Parabéns!** O código segue fielmente todos os padrões definidos pelo repositório.\n\n`;
  }

  writeFileSync(join(targetDir, options.output), md, 'utf-8');

  // Gerar patch se houver correções
  let patchCreated = false;
  let patchContent = '';
  for (const d of divergences) {
    if (d.snippet && d.suggestion && d.file && d.line) {
      patchContent += `--- a/${d.file}\n+++ b/${d.file}\n@@ -${d.line},1 +${d.line},1 @@\n-${d.snippet}\n+${d.suggestion}\n`;
    }
  }
  if (patchContent) {
    writeFileSync(join(targetDir, options.patch), patchContent, 'utf-8');
    patchCreated = true;
  }

  return {
    appName,
    status: divergences.length === 0 ? 'APPROVED' : 'NEEDS_CHANGES',
    divergencesCount: divergences.length,
    reportPath: join(targetDir, options.output),
    patchPath: patchCreated ? join(targetDir, options.patch) : null,
  };
};
