const STATUS = {
  APPROVED: '🟢 Sem bloqueios renderizados',
  NEEDS_CONFIRMATION: '🟡 Ressalvas para o revisor de UX',
  NEEDS_CHANGES: '🔴 Bloqueios renderizados',
};

const ICON = { hard: '🔴', medium: '🟡', info: 'ℹ️' };

const where = (m) => `${m.route} · ${m.theme} · ${m.viewport.width}×${m.viewport.height}`;

/** Junta o mesmo problema visto em várias combinações (rota × tema × viewport). */
export const groupFindings = (matrix) => {
  const groups = new Map();
  for (const m of matrix) {
    for (const f of m.findings) {
      if (f.severity === 'info') continue;
      const key = `${f.ruleId}|${f.selector ?? ''}|${f.description}`;
      const group = groups.get(key) ?? { ...f, where: [] };
      group.where.push(where(m));
      groups.set(key, group);
    }
  }
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? b.where.length - a.where.length : a.severity === 'hard' ? -1 : 1));
};

export const renderUxAudit = (r) => {
  const rows = r.matrix.map((m) => {
    const hard = m.findings.filter((f) => f.severity === 'hard').length;
    const medium = m.findings.filter((f) => f.severity === 'medium').length;
    return `| ${m.route} | ${m.theme} | ${m.viewport.width}×${m.viewport.height} | ${hard} | ${medium} | ${m.screenshot ? `[png](${m.screenshot})` : '—'} |`;
  });
  const groups = groupFindings(r.matrix).map(
    (g) => `- ${ICON[g.severity]} **${g.ruleId}**${g.selector ? ` \`${g.selector}\`` : ''}: ${g.description}\n  - Em: ${g.where.join('; ')}`
  );
  return [
    '# 🎨 Auditoria Renderizada de UX',
    '',
    `> **Status**: ${STATUS[r.summary.status]}  `,
    `> **Commit**: ${r.head ?? 'desconhecido'}  `,
    `> **App**: ${r.baseUrl}  `,
    `> **Combinações**: ${r.summary.combinations} · 🔴 ${r.summary.hard} · 🟡 ${r.summary.medium}`,
    '',
    '## Matriz',
    '',
    '| Rota | Tema | Viewport | 🔴 | 🟡 | Screenshot |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Achados',
    '',
    groups.length > 0 ? groups.join('\n') : 'Nenhum achado mecânico.',
    '',
    '> Esta auditoria cobre o que é mensurável. Hierarquia, estética genérica (slop), microcopy e fluxo',
    '> ficam com o revisor de UX, que deve abrir os screenshots acima antes do parecer (skill `ux-reviewer`).',
    '',
  ].join('\n');
};
