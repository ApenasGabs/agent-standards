const LABELS = {
  APPROVED: '🟢 Aprovado',
  NEEDS_CONFIRMATION: '🟡 Pendente de Confirmação',
  NEEDS_CHANGES: '🔴 Reprovado / Requer Ajustes',
  INCONCLUSIVE: '🔴 Reprovado / Revisão Inconclusiva',
};

const CI_LABELS = {
  SUCCESS: '🟢 Passing',
  FAILURE: '🔴 Failing',
  TIMED_OUT: '🔴 Timed Out',
  IN_PROGRESS: '🟡 In Progress',
  OUTDATED: '🟡 Outdated',
  NO_CHECKS: '⚪ Sem checks',
};

export const statusLabel = (status) => LABELS[status];

const list = (items, empty) => (items.length > 0 ? items.join('\n') : empty);

const UX_AUDIT_LABELS = {
  disabled: 'Auditoria renderizada desativada (sem seção `ux` no agent.config.json da base).',
  'not-required': 'Nenhum arquivo de UI alterado: auditoria renderizada não exigida.',
  missing: '🟡 Mudança de UI sem auditoria renderizada deste commit (`agent-standards ux-audit`).',
  outdated: '🟡 Auditoria renderizada desatualizada (outro commit).',
  invalid: '🟡 Relatório do ux-audit inválido.',
};

const formatDivergence = (d) =>
  `- ${d.severity === 'hard' ? '🔴' : '🟡'} \`${d.line ? `${d.file}:${d.line}` : d.file}\` — **${d.ruleId}** (${d.docRef}): ${d.description}` +
  (d.snippet ? `\n\n  ~~~~text\n  ${d.snippet}\n  ~~~~\n` : '');

const uxAuditLine = (a = { state: 'disabled' }) =>
  a.state === 'ok'
    ? `Auditoria renderizada${a.url ? ` de ${a.url}` : ''}: \`${a.report}\` — ${a.summary?.combinations ?? 0} combinação(ões), 🔴 ${a.summary?.hard ?? 0} · 🟡 ${a.summary?.medium ?? 0}. Screenshots em \`${a.report.replace(/[^/]+$/, '')}\`.`
    : UX_AUDIT_LABELS[a.state];

const formatPrRef = (ci) => (ci.prNumber ? (ci.prUrl ? `[PR #${ci.prNumber}](${ci.prUrl})` : `PR #${ci.prNumber}`) : '');

const ciSummaryDetails = (ci = {}) => {
  const prRef = formatPrRef(ci);
  const suffix = prRef ? ` no ${prRef}` : '';
  const total = ci.total ?? 0;
  const successful = ci.successful ?? 0;
  if (ci.status === 'SUCCESS') return `${successful}/${total} check(s) aprovado(s)${suffix}`;
  if (ci.status === 'FAILURE') return `${ci.failed?.length ?? 0} check(s) falhando (${successful}/${total} aprovado(s))${suffix}`;
  if (ci.status === 'TIMED_OUT') return `${ci.timedOut?.length ?? 0} check(s) com tempo excedido (${successful}/${total} aprovado(s))${suffix}`;
  if (ci.status === 'IN_PROGRESS') return `${ci.inProgress?.length ?? 0} check(s) em execução (${successful}/${total} aprovado(s))${suffix}`;
  if (ci.status === 'OUTDATED') return `Checks de outro commit${ci.outdatedSha ? ` (${String(ci.outdatedSha).slice(0, 7)})` : ''}${suffix}`;
  return 'Nenhum check remoto registrado';
};

const formatCheckItem = (icon, check) => {
  const name = check.name ?? check.context ?? 'Check';
  const workflow = check.workflowName ? ` (${check.workflowName})` : '';
  const url = check.detailsUrl ?? check.targetUrl ?? '';
  const link = url ? ` — [Ver detalhes](${url})` : '';
  return `- ${icon} **${name}**${workflow}${link}`;
};

const renderCISection = (ci = {}) => {
  const prRef = formatPrRef(ci);
  const label = CI_LABELS[ci.status] ?? ci.status;
  const lines = [`${label}${prRef ? ` — ${prRef}` : ''}`];
  const blocking = [...(ci.failed ?? []), ...(ci.timedOut ?? [])];
  const inProgress = ci.inProgress ?? [];
  const passed = ci.passed ?? [];
  const successful = ci.successful ?? passed.length;
  const total = ci.total ?? 0;

  if (ci.status === 'OUTDATED') {
    lines.push('', `Os checks remotos do PR pertencem a outro commit${ci.outdatedSha ? ` (\`${String(ci.outdatedSha).slice(0, 7)}\`)` : ''} e não validam o commit avaliado.`);
    return lines;
  }
  if (!ci.configured) {
    lines.push('', 'Nenhum check remoto configurado ou PR aberto encontrado para esta branch.');
    return lines;
  }
  if (blocking.length > 0) {
    lines.push('', '### Checks reprovados', '', ...blocking.map((c) => formatCheckItem('🔴', c)));
  }
  if (inProgress.length > 0) {
    lines.push('', '### Checks em execução', '', ...inProgress.map((c) => formatCheckItem('🟡', c)));
  }
  if (successful > 0) {
    lines.push('', '### Jobs aprovados', '', `✅ **${successful} de ${total}** job(s) aprovado(s)${prRef ? ` no ${prRef}` : ''}.`);
    if (passed.length > 0) lines.push('', ...passed.map((c) => formatCheckItem('🟢', c)));
  }
  return lines;
};

export const renderReport = (r) => {
  const ci = r.ci ?? { status: 'NO_CHECKS' };
  const standards = r.divergences.filter((d) => d.axis !== 'UX').map(formatDivergence);
  const ux = r.divergences.filter((d) => d.axis === 'UX').map(formatDivergence);
  const spec = r.requirements.map((q) =>
    q.status === 'evidence'
      ? `- 🔎 ${q.text} — evidência em ${q.evidence.map((e) => `\`${e}\``).join(', ')}`
      : `- ❔ ${q.text} — a confirmar por revisão`
  );
  return [
    `# 🛡️ Relatório de Code Review — ${r.appName}`,
    '',
    `> **Status**: ${LABELS[r.status]}  `,
    `> **Data**: ${new Date().toLocaleString('pt-BR')}  `,
    `> **Tarefa**: ${r.task.title} (${r.task.source})  `,
    `> **Comparação**: ${r.base} … ${r.head}  `,
    `> **Regras**: ${r.ruleSource}`,
    '',
    '## Resumo Executivo',
    '',
    '| Eixo / Métrica | Status | Detalhes |',
    '| :--- | :--- | :--- |',
    `| **Status Geral** | ${LABELS[r.status]} | ${r.divergences.length} divergência(s), ${r.problems.length} problema(s) |`,
    `| **Pipeline CI/CD** | ${CI_LABELS[ci.status] ?? ci.status} | ${ciSummaryDetails(ci)} |`,
    '',
    ...(r.problems.length > 0 ? ['## Motivos da revisão inconclusiva', '', list(r.problems.map((p) => `- ${p}`)), ''] : []),
    '## Eixo Spec',
    '',
    list(spec, 'Nenhum requisito identificado na tarefa.'),
    '',
    '> Evidência indica onde olhar; não comprova que o requisito foi atendido.',
    '',
    '## Eixo Standards',
    '',
    list(standards, 'Nenhuma violação nas regras verificadas.'),
    '',
    '### Regras não verificadas',
    '',
    list(r.unverified.map((u) => `- \`${u}\``), 'Nenhuma.'),
    '',
    '## Eixo UX',
    '',
    uxAuditLine(r.uxAudit),
    '',
    list(ux, 'Nenhum achado de UX nas regras verificadas.'),
    '',
    '> O revisor de UX (skill `ux-reviewer`) ainda avalia hierarquia, slop visual, microcopy e fluxo nos screenshots.',
    '',
    '## Pipeline de CI/CD',
    '',
    ...renderCISection(ci),
    '',
    ...(r.notes.length > 0 ? ['## Observações', '', list(r.notes.map((n) => `- ${n}`)), ''] : []),
  ].join('\n');
};
