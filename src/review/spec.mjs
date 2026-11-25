const SECTION = /^#{1,6}\s+(.*)$/;
const ITEM = /^\s*(?:[-*]|\d+\.)\s+(?:\[([ xX])\]\s*)?(.+)$/;

/** Prefere a seção de critérios de aceitação; depois checkboxes; depois qualquer lista. */
export const extractRequirements = (body) => {
  const items = [];
  let section = '';
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = line.match(SECTION);
    if (heading) {
      section = heading[1];
      continue;
    }
    const item = line.match(ITEM);
    if (item) items.push({ section, checkbox: item[1] !== undefined, text: item[2].trim() });
  }
  const accepted = items.filter((i) => /crit[ée]rios?|acceptance/i.test(i.section));
  const boxes = items.filter((i) => i.checkbox);
  const chosen = accepted.length > 0 ? accepted : boxes.length > 0 ? boxes : items;
  return chosen.map(({ text }) => ({ text, symbols: [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]) }));
};

const includesSymbol = (line, symbol) => {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(line);
};

/**
 * Só aponta evidência quando todos os símbolos citados aparecem em código adicionado.
 * Evidência ajuda quem revisa; não prova que o requisito foi atendido.
 */
export const matchRequirements = (requirements, files) => {
  const code = [...files].filter(([file]) => !/\.(?:md|mdx|txt)$/i.test(file));
  const locate = (symbol) => {
    for (const [file, { lines, text }] of code) {
      const index = text.findIndex((t) => includesSymbol(t, symbol));
      if (index !== -1) return `${file}:${[...lines][index]}`;
    }
    return null;
  };
  return requirements.map((req) => {
    const found = req.symbols.map(locate);
    const evidenced = found.length > 0 && found.every(Boolean);
    return { text: req.text, status: evidenced ? 'evidence' : 'unconfirmed', evidence: found.filter(Boolean) };
  });
};
