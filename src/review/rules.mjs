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

// ── Eixo UX (regras estáticas) ─────────────────────────────────────────────

const STYLE_FILE = /\.(?:css|scss|sass|less|pcss)$/;
const MARKUP_FILE = /\.(?:vue|astro|svelte|html?)$/;

export const isUiFile = (file) => (JSX_FILE.test(file) || MARKUP_FILE.test(file) || STYLE_FILE.test(file)) && !isTestFile(file);

const blank = (text) => text.replace(/[^\n]/g, ' ');

/** Remove comentários de CSS e HTML preservando posições; strings continuam visíveis (classes, valores). */
const maskComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/<!--[\s\S]*?-->/g, blank);

/** Texto onde classes e valores de estilo ficam visíveis, mas comentários não. */
const styleView = ({ file, raw, masked }) => {
  if (!CODE_FILE.test(file)) return maskComments(raw);
  // Em JS/TS o masked preserva as aspas e apaga o conteúdo; o que ele apagou fora de string é comentário ou regex.
  let out = '';
  let quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < raw.length) out += raw[++i];
      else if (c === quote) quote = null;
      continue;
    }
    if (masked[i] !== c && c !== '\n') {
      out += ' ';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
};

const findImportant = (ctx) => matches(styleView(ctx), /!\s*important\b/gi);

const CSS_COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g;
const TW_ARBITRARY_COLOR = /\b(?:bg|text|border(?:-[trblxy])?|from|via|to|fill|stroke|ring|outline|decoration|accent|caret|divide|placeholder|shadow)-\[(?:#|rgba?\(|hsla?\(|oklch\()/g;
const INLINE_STYLE_COLOR = /\b(?:color|background(?:Color)?|borderColor|outlineColor)\s*:\s*["'`](?:#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\()/g;

// Definir variáveis (`--token: #fff`) é exatamente o que um arquivo de tokens faz; consumi-las fora dele não.
const findHardcodedColors = (ctx) => {
  const view = styleView(ctx);
  if (STYLE_FILE.test(ctx.file)) {
    return matches(view, CSS_COLOR).filter(({ start }) => {
      const declStart = Math.max(view.lastIndexOf('{', start), view.lastIndexOf(';', start), view.lastIndexOf('}', start)) + 1;
      const declaration = view.slice(declStart, start);
      // Precisa estar no valor de uma declaração (não em seletor) que não seja definição de token.
      return declaration.includes(':') && !/^\s*--[\w-]+\s*:/.test(declaration);
    });
  }
  return [...matches(view, TW_ARBITRARY_COLOR), ...matches(view, INLINE_STYLE_COLOR)];
};

const SLOP_PATTERNS = [
  { re: /\b(?:from|via)-(?:purple|violet|fuchsia|indigo|pink)-\d{2,3}\b/g, description: 'Gradiente roxo/rosa decorativo (estética genérica de IA); use cor de destaque dos tokens com intenção.' },
  { re: /\bbackdrop-blur(?:-\w+)?\b|\bbackdrop-filter\s*:\s*blur/g, description: 'Glassmorphism (`backdrop-blur`): só use quando há conteúdo real atrás e o contraste continua legível.' },
  { re: /\b(?:drop-)?shadow-(?:2xl|\[0_0_[^\]]*\])/g, description: 'Sombra gigante ou glow (`shadow-2xl`/`shadow-[0_0_…]`): profundidade deve vir da hierarquia de superfícies.' },
  { re: /\bborder-l-(?:4|8)\b/g, description: 'Borda lateral grossa decorativa (`border-l-4`), padrão genérico de card de IA.' },
  { re: /\bbg-clip-text\b/g, description: 'Texto em gradiente (`bg-clip-text`): costuma prejudicar contraste e é clichê de landing page gerada.' },
];

const findSlop = (ctx) => {
  const view = styleView(ctx);
  return SLOP_PATTERNS.flatMap(({ re, description }) => matches(view, re).map((m) => ({ ...m, description })));
};

const EMOJI = /(?![©®™])\p{Extended_Pictographic}/gu;
const UI_TEXT_ATTR = /\b(?:aria-label|title|placeholder|alt|label)\s*=\s*(["'])((?:(?!\1).)*)\1/g;

const findEmoji = ({ file, raw, masked }) => {
  const text = CODE_FILE.test(file) ? masked : maskComments(raw);
  const inAttributes = [...raw.matchAll(UI_TEXT_ATTR)].filter((m) => new RegExp(EMOJI.source, 'u').test(m[2]));
  return [...matches(text, EMOJI), ...inAttributes.map((m) => ({ start: m.index, end: m.index + m[0].length }))];
};

const NAMED = /\b(?:aria-label|aria-labelledby|title)\s*=|\{\s*\.\.\./;

/** Botão sem texto visível e sem nome acessível: leitor de tela anuncia só "botão". */
const findIconOnlyButtons = ({ file, raw, masked }) => {
  const text = CODE_FILE.test(file) ? masked : maskComments(raw);
  return [...text.matchAll(/<(button|IconButton)(?=[\s/>])/g)]
    .map((m) => {
      const openEnd = findTagEnd(text, m.index + m[0].length);
      const open = text.slice(m.index, openEnd);
      const close = open.endsWith('/>') ? openEnd : text.indexOf(`</${m[1]}>`, openEnd);
      const innerEnd = close === -1 ? openEnd : close;
      return { start: m.index, end: openEnd, open, inner: text.slice(openEnd, innerEnd), rawInner: raw.slice(openEnd, innerEnd) };
    })
    .filter(({ open, inner, rawInner }) => {
      if (NAMED.test(open)) return false;
      // Expressões `{...}` podem renderizar texto; na dúvida, não acusa.
      if (/\{/.test(inner)) return false;
      if (/\baria-label\s*=|<title\b|\bsr-only\b|\bvisually-hidden\b/.test(rawInner)) return false;
      return !/[\p{L}\p{N}]/u.test(inner.replace(/<[^>]*>/g, ''));
    });
};

const UX_RULES = [
  {
    id: 'ux-no-important',
    key: 'ux.blockImportant',
    aliases: ['ui.noImportant'],
    enabled: true,
    severity: 'hard',
    applies: (f) => isUiFile(f),
    find: findImportant,
    description: '`!important` quebra a cascata dos tokens; resolva pela especificidade ou pelo token correto.',
  },
  {
    id: 'ux-no-hardcoded-colors',
    key: 'ux.blockHardcodedColors',
    enabled: true,
    severity: 'medium',
    applies: (f) => isUiFile(f),
    find: findHardcodedColors,
    description: 'Cor fixa fora dos design tokens; use a variável/classe semântica do tema (quebra o tema claro ou escuro).',
  },
  {
    id: 'ux-anti-slop',
    key: 'ux.blockSlopPatterns',
    enabled: true,
    severity: 'medium',
    applies: (f) => isUiFile(f),
    find: findSlop,
    description: 'Padrão visual genérico de IA.',
  },
  {
    id: 'ux-no-emoji-in-ui',
    key: 'ux.blockEmojiInUi',
    enabled: true,
    severity: 'medium',
    applies: (f) => (JSX_FILE.test(f) || MARKUP_FILE.test(f)) && !isTestFile(f),
    find: findEmoji,
    description: 'Emoji em texto de interface; use o ícone do design system (emoji renderiza diferente por SO e soa como copy de IA).',
  },
  {
    id: 'ux-icon-button-name',
    key: 'ux.requireAccessibleIconButton',
    enabled: true,
    severity: 'medium',
    applies: (f) => (JSX_FILE.test(f) || MARKUP_FILE.test(f)) && !isTestFile(f),
    find: findIconOnlyButtons,
    description: 'Botão só com ícone e sem `aria-label`/`title`: sem nome acessível.',
  },
].map((r) => ({ ...r, axis: 'UX' }));

RULES.push(...UX_RULES);

const isActive = (rule, rules) => rules[rule.key] === rule.enabled || (rule.aliases ?? []).some((a) => rules[a] === rule.enabled);

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Avalia um arquivo e devolve só violações que tocam linhas adicionadas. */
export const checkFile = ({ file, content, addedLines, rules, source }) => {
  const context = { file, raw: content, masked: CODE_FILE.test(file) ? maskSource(content) : content };
  const lines = content.split('\n');
  return RULES.filter((r) => isActive(r, rules) && r.applies(file)).flatMap((rule) => {
    const seen = new Set();
    return rule
      .find(context)
      .map(({ start, end, description }) => ({ first: lineAt(content, start), last: lineAt(content, Math.max(start, end - 1)), description }))
      .filter(({ first, last }) => {
        for (let n = first; n <= last; n++) if (addedLines.has(n)) return true;
        return false;
      })
      .filter(({ first, description }) => !seen.has(`${first}:${description}`) && seen.add(`${first}:${description}`))
      .map(({ first, description }) => ({
        axis: rule.axis ?? 'Standards',
        ruleId: rule.id,
        severity: rule.severity,
        file,
        line: first,
        docRef: source === 'agent.config.json' ? `${source} § rules.${rule.key}` : source,
        description: description ?? rule.description,
        snippet: rule.secret ? '[conteúdo oculto]' : lines[first - 1].trim().slice(0, 200),
      }));
  });
};

export const isRuleEnabled = (ruleMap) => RULES.some((r) => isActive(r, ruleMap));
