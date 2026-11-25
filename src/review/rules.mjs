import { maskSource } from './mask.mjs';

const CODE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;
const JSX_FILE = /\.[jt]sx$/;
const DTS_FILE = /\.d\.[cm]?ts$/;
const LOCK_FILE = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum)$/;

export const isTestFile = (file) =>
  /(?:^|\/)(?:__tests__|tests?|e2e)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || /_test\.go$|Test\.java$/.test(file);

export const isSourceFile = (file) => (CODE_FILE.test(file) || /\.(?:go|java)$/.test(file)) && !isTestFile(file) && !DTS_FILE.test(file);

const matches = (text, re) => [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

/** Localiza o `>` que fecha a tag, ignorando chaves e strings já mascaradas. */
const findTagEnd = (masked, from) => {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') depth--;
    else if (masked[i] === '>' && depth === 0) return i + 1;
  }
  return masked.length;
};

const findMissingTestIds = ({ masked, raw }) =>
  [...masked.matchAll(/<(?:button|input|select|textarea)(?=[\s/>])/g)]
    .map((m) => ({ start: m.index, end: findTagEnd(masked, m.index + m[0].length) }))
    .filter(({ start, end }) => {
      const tag = masked.slice(start, end);
      return !/\bdata-testid\s*=/.test(tag) && !/\{\s*\.\.\./.test(tag) && !/\btype=["']hidden["']/.test(raw.slice(start, end));
    });

// Um comentário dentro do bloco é aceito como justificativa explícita.
const findEmptyCatches = ({ masked, raw }) =>
  [
    ...matches(masked, /\bcatch\s*(?:\([^()]*\))?\s*\{\s*\}/g),
    ...matches(masked, /\.catch\(\s*(?:async\s*)?\([^()]*\)\s*=>\s*\{\s*\}\s*\)/g),
  ].filter(({ start, end }) => !/\/\/\s*\S|\/\*\s*[^\s*]/.test(raw.slice(start, end)));

const KNOWN_SECRETS =
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{24,}|AIza[A-Za-z0-9_-]{35}|AKIA[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{20,}|pcp_[a-f0-9]{32,})|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g;
const ASSIGNED_SECRET =
  /(?:api[_-]?key|secret|token|passw(?:or)?d|senha)["']?\s*(?::\s*string\s*)?[:=]\s*["'`]([A-Za-z0-9+/_=.-]{20,})["'`]/gi;

const looksRandom = (v) => /\d/.test(v) && /[A-Za-z]/.test(v) && new Set(v).size >= 10 && !/example|placeholder|your[_-]|xxxx|test|mock|dummy/i.test(v);

const findSecrets = ({ raw, file }) => [
  ...matches(raw, KNOWN_SECRETS),
  ...(isTestFile(file)
    ? []
    : [...raw.matchAll(ASSIGNED_SECRET)]
        .filter((m) => looksRandom(m[1]))
        .map((m) => ({ start: m.index, end: m.index + m[0].length }))),
];

const RULES = [
  {
    id: 'arrow-functions-only',
    key: 'functions',
    enabled: 'arrow-only',
    severity: 'hard',
    applies: (f) => CODE_FILE.test(f) && !DTS_FILE.test(f),
    // Generators e `declare function` não têm equivalente em arrow function.
    find: ({ masked }) => matches(masked, /(?<![.\w$])(?<!\bdeclare\s+)function(?=\s*\(|\s+[A-Za-z_$])(?!\s*:)/g),
    description: 'Use arrow function no lugar de `function`.',
  },
  {
    id: 'no-explicit-any',
    key: 'typescript.noExplicitAny',
    enabled: true,
    severity: 'hard',
    applies: (f) => TS_FILE.test(f),
    find: ({ masked }) => matches(masked, /(?:[:<|&,=]\s*|\bas\s+)any\b(?=\s*(?:[;,)=\]}>|&[{]|\n|$))/g),
    description: 'Evite `any`; use `unknown` ou um tipo específico.',
  },
  {
    id: 'no-inner-html',
    key: 'security.blockInnerHTML',
    enabled: true,
    severity: 'hard',
    applies: (f) => CODE_FILE.test(f),
    find: ({ masked }) => matches(masked, /\.(?:inner|outer)HTML\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(|\bdangerouslySetInnerHTML\s*[=:]/g),
    description: 'Injeção de HTML pode causar XSS; use `textContent` ou nós React.',
  },
  {
    id: 'require-data-testid',
    key: 'ui.requireDataTestId',
    enabled: true,
    severity: 'medium',
    applies: (f) => JSX_FILE.test(f) && !isTestFile(f),
    find: findMissingTestIds,
    description: 'Elemento interativo sem `data-testid`.',
  },
  {
    id: 'no-hardcoded-secrets',
    key: 'security.blockHardcodedSecrets',
    enabled: true,
    severity: 'hard',
    applies: (f) => !LOCK_FILE.test(f),
    find: findSecrets,
    secret: true,
    description: 'Possível credencial fixa no código; use variável de ambiente.',
  },
  {
    id: 'no-console-log',
    key: 'cleanCode.blockConsoleLog',
    enabled: true,
    severity: 'medium',
    applies: (f) => CODE_FILE.test(f) && !isTestFile(f),
    find: ({ masked }) => matches(masked, /\bconsole\s*\.\s*(?:log|debug|trace)\s*\(/g),
    description: 'Depuração residual com `console`.',
  },
  {
    id: 'no-empty-catch',
    key: 'cleanCode.blockEmptyCatch',
    enabled: true,
    severity: 'hard',
    applies: (f) => CODE_FILE.test(f),
    find: findEmptyCatches,
    description: '`catch` vazio sem tratamento nem justificativa.',
  },
];

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Avalia um arquivo e devolve só violações que tocam linhas adicionadas. */
export const checkFile = ({ file, content, addedLines, rules, source }) => {
  const context = { file, raw: content, masked: CODE_FILE.test(file) ? maskSource(content) : content };
  const lines = content.split('\n');
  return RULES.filter((r) => rules[r.key] === r.enabled && r.applies(file)).flatMap((rule) => {
    const seen = new Set();
    return rule
      .find(context)
      .map(({ start, end }) => ({ first: lineAt(content, start), last: lineAt(content, Math.max(start, end - 1)) }))
      .filter(({ first, last }) => {
        for (let n = first; n <= last; n++) if (addedLines.has(n)) return true;
        return false;
      })
      .filter(({ first }) => !seen.has(first) && seen.add(first))
      .map(({ first }) => ({
        axis: 'Standards',
        ruleId: rule.id,
        severity: rule.severity,
        file,
        line: first,
        docRef: source === 'agent.config.json' ? `${source} § rules.${rule.key}` : source,
        description: rule.description,
        snippet: rule.secret ? '[conteúdo oculto]' : lines[first - 1].trim().slice(0, 200),
      }));
  });
};

export const isRuleEnabled = (ruleMap) => RULES.some((r) => ruleMap[r.key] === r.enabled);
