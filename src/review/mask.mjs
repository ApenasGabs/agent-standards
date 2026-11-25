const REGEX_PRECEDERS = /(?:^|[(,=:[!&|?;{+\-*~^]|\b(?:return|typeof|case|in|of|do|else|void|throw|await|yield))\s*$/;

const findRegexEnd = (src, start) => {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '\n') return -1;
    if (c === '\\') i++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) return i;
  }
  return -1;
};

const findQuoteEnd = (src, start) => {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') {
      i++;
      continue;
    }
    if (src[i] === '\n') return -1;
    if (src[i] === quote) return i;
  }
  return -1;
};

/**
 * Troca comentários, strings e regex por espaços, preservando tamanho e quebras de linha.
 * Interpolações de template literals continuam visíveis por serem código.
 */
export const maskSource = (src) => {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Cada item é a profundidade de chaves da interpolação em andamento.
  const templates = [];
  let i = 0;

  const readTemplate = (from) => {
    let k = from;
    while (k < src.length) {
      if (src[k] === '\\') {
        k += 2;
      } else if (src[k] === '`') {
        blank(from, k);
        return k + 1;
      } else if (src[k] === '$' && src[k + 1] === '{') {
        blank(from, k);
        templates.push(0);
        return k + 2;
      } else {
        k++;
      }
    }
    blank(from, k);
    return k;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const end = findQuoteEnd(src, i);
      if (end !== -1) blank(i + 1, end);
      i = end === -1 ? i + 1 : end + 1;
    } else if (c === '`') {
      i = readTemplate(i + 1);
    } else if (c === '/') {
      const lineStart = out.lastIndexOf('\n', i - 1) + 1;
      const before = out.slice(lineStart, i).join('');
      const end = REGEX_PRECEDERS.test(before) ? findRegexEnd(src, i) : -1;
      if (end !== -1) blank(i + 1, end);
      i = end === -1 ? i + 1 : end + 1;
    } else if (templates.length > 0 && c === '{') {
      templates[templates.length - 1]++;
      i++;
    } else if (templates.length > 0 && c === '}') {
      if (templates[templates.length - 1] === 0) {
        templates.pop();
        i = readTemplate(i + 1);
      } else {
        templates[templates.length - 1]--;
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
};
