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

export const renderReport = (r) => {
  const standards = r.divergences.map(
    (d) =>
      `- ${d.severity === 'hard' ? '🔴' : '🟡'} \`${d.file}:${d.line}\` — **${d.ruleId}** (${d.docRef}): ${d.description}` +
      (d.snippet ? `\n\n  ~~~~text\n  ${d.snippet}\n  ~~~~\n` : '')
  );
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
    '## Pipeline de CI/CD',
    '',
    `${CI_LABELS[r.ci.status] ?? r.ci.status}${r.ci.prNumber ? ` — PR #${r.ci.prNumber}` : ''}`,
    ...[...(r.ci.failed ?? []), ...(r.ci.timedOut ?? [])].map((c) => `- 🔴 ${c.name ?? c.context}: ${c.detailsUrl ?? c.targetUrl ?? ''}`),
    '',
    ...(r.notes.length > 0 ? ['## Observações', '', list(r.notes.map((n) => `- ${n}`)), ''] : []),
  ].join('\n');
};
