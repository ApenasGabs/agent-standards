/** Extrai as linhas adicionadas de um `git diff -U0`, por arquivo. */
export const parseAddedLines = (diff) => {
  const files = new Map();
  let current = null;
  let remaining = { removed: 0, added: 0 };
  let line = 0;
  for (const text of diff.split('\n')) {
    if (remaining.removed > 0 && text.startsWith('-')) {
      remaining.removed--;
    } else if (remaining.added > 0 && text.startsWith('+')) {
      current.lines.add(line);
      current.text.push(text.slice(1));
      line++;
      remaining.added--;
    } else if (text.startsWith('+++ ')) {
      const path = text.slice(4).replace(/\t$/, '');
      current = path === '/dev/null' ? null : { lines: new Set(), text: [] };
      if (current) files.set(path.replace(/^b\//, ''), current);
    } else {
      const hunk = text.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (hunk) {
        remaining = { removed: Number(hunk[1] ?? 1), added: Number(hunk[3] ?? 1) };
        line = Number(hunk[2]);
      }
    }
  }
  return files;
};
