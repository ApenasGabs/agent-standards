const LABELS = {
  APPROVED: '🟢 Aprovado',
  NEEDS_CONFIRMATION: '🟡 Pendente de Confirmação',
  NEEDS_CHANGES: '🔴 Reprovado / Requer Ajustes',
  INCONCLUSIVE: '🔴 Reprovado / Revisão Inconclusiva',
};

const CI_LABELS = {
  SUCCESS: '🟢 Passando',
  FAILURE: '🔴 Falhando',
  TIMED_OUT: '🔴 Tempo excedido',
  IN_PROGRESS: '🟡 Em execução',
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
    ? `Auditoria renderizada: \`${a.report}\` — ${a.summary?.combinations ?? 0} combinação(ões), 🔴 ${a.summary?.hard ?? 0} · 🟡 ${a.summary?.medium ?? 0}. Screenshots em \`${a.report.replace(/[^/]+$/, '')}\`.`
    : UX_AUDIT_LABELS[a.state];

export const renderReport = (r) => {
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
    `${CI_LABELS[r.ci.status] ?? r.ci.status}${r.ci.prNumber ? ` — PR #${r.ci.prNumber}` : ''}`,
    ...[...(r.ci.failed ?? []), ...(r.ci.timedOut ?? [])].map((c) => `- 🔴 ${c.name ?? c.context}: ${c.detailsUrl ?? c.targetUrl ?? ''}`),
    '',
    ...(r.notes.length > 0 ? ['## Observações', '', list(r.notes.map((n) => `- ${n}`)), ''] : []),
  ].join('\n');
};
