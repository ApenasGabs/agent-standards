import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/** Regras que o revisor verifica de fato, com os valores aceitos. */
export const SUPPORTED_RULES = {
  functions: ['arrow-only', 'any'],
  'typescript.noExplicitAny': [true, false],
  'ui.requireDataTestId': [true, false],
  'security.blockInnerHTML': [true, false],
  'security.blockHardcodedSecrets': [true, false],
  'cleanCode.blockConsoleLog': [true, false],
  'cleanCode.blockEmptyCatch': [true, false],
  'ui.noImportant': [true, false],
  'ux.blockImportant': [true, false],
  'ux.blockHardcodedColors': [true, false],
  'ux.blockSlopPatterns': [true, false],
  'ux.blockEmojiInUi': [true, false],
  'ux.requireAccessibleIconButton': [true, false],
};

export class ConfigError extends Error {}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([key, value]) =>
    isPlainObject(value) ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]
  );

const toRuleMap = (rules, where) => {
  if (!isPlainObject(rules)) throw new ConfigError(`${where} deve ser um objeto.`);
  const map = Object.fromEntries(flatten(rules));
  for (const [key, value] of Object.entries(map)) {
    const accepted = SUPPORTED_RULES[key];
    if (accepted && !accepted.includes(value)) {
      throw new ConfigError(`${where}.${key} aceita ${accepted.join(' ou ')}, recebeu ${JSON.stringify(value)}.`);
    }
  }
  for (const section of new Set(Object.keys(SUPPORTED_RULES).filter((k) => k.includes('.')).map((k) => k.split('.')[0]))) {
    if (section in rules && !isPlainObject(rules[section])) throw new ConfigError(`${where}.${section} deve ser um objeto.`);
  }
  return map;
};

export const parseConfig = (text) => {
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`agent.config.json não é um JSON válido: ${err.message}`);
  }
  if (!isPlainObject(config)) throw new ConfigError('agent.config.json deve ser um objeto.');
  const rules = toRuleMap(config.rules ?? {}, 'rules');
  const rawOverrides = config.overrides ?? [];
  if (!Array.isArray(rawOverrides)) throw new ConfigError('overrides deve ser uma lista.');
  const overrides = rawOverrides.map((o, i) => {
    const paths = o?.paths;
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || !p)) {
      throw new ConfigError(`overrides[${i}].paths deve ser uma lista de caminhos.`);
    }
    return { matchers: paths.map(globToRegExp), rules: toRuleMap(o.rules, `overrides[${i}].rules`) };
  });

  const declared = [rules, ...overrides.map((o) => o.rules)].flatMap((m) => Object.entries(m));
  const unverified = [
    ...new Set(
      declared
        .filter(([k, v]) => !(k in SUPPORTED_RULES) && v !== false && v !== null && v !== 'none')
        .map(([k]) => k)
    ),
  ];
  // `"ux": false` desliga o gate de auditoria renderizada mesmo quando o perfil o liga.
  if (config.ux !== undefined && config.ux !== false && !isPlainObject(config.ux)) throw new ConfigError('ux deve ser um objeto (ou false).');
  return { source: 'agent.config.json', rules, overrides, unverified, ux: config.ux ?? null };
};

/** Suporta `*`, `**` e `?`. */
export const globToRegExp = (glob) => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

/** Regras efetivas de um arquivo; o último override correspondente prevalece. */
export const rulesForFile = (config, file) =>
  config.overrides
    .filter((o) => o.matchers.some((m) => m.test(file)))
    .reduce((acc, o) => ({ ...acc, ...o.rules }), { ...config.rules });

/** Sem agent.config.json, deduz o mínimo a partir da documentação do repositório. */
export const configFromDocs = (docs) => {
  const text = docs.map((d) => d.text).join('\n');
  return {
    source: docs.length > 0 ? docs.map((d) => d.file).join(', ') : 'baseline',
    rules: {
      functions: /arrow functions?/i.test(text) ? 'arrow-only' : 'any',
      'typescript.noExplicitAny': /(?:sem|nunca usar|proibido[^\n]{0,20})\s+`?any\b/i.test(text),
      'security.blockInnerHTML': /innerHTML/.test(text),
      'ui.requireDataTestId': /data-testid/.test(text),
      'security.blockHardcodedSecrets': true,
      'cleanCode.blockEmptyCatch': true,
      'cleanCode.blockConsoleLog': true,
      'ux.blockImportant': /!important/.test(text),
    },
    overrides: [],
    unverified: [],
    ux: null,
    deduced: true,
  };
};

const PROFILES_DIR = fileURLToPath(new URL('../../profiles/', import.meta.url));

/**
 * Carrega um perfil global: nome de um arquivo em `profiles/` deste pacote ou caminho para um JSON.
 * Perfis são a fonte única das regras gerais; o projeto só declara exceções.
 */
export const loadProfile = (nameOrPath, cwd = process.cwd()) => {
  if (!nameOrPath) return null;
  const byName = /^[\w-]+$/.test(nameOrPath) ? resolve(PROFILES_DIR, `${nameOrPath}.json`) : null;
  const path = byName && existsSync(byName) ? byName : isAbsolute(nameOrPath) ? nameOrPath : resolve(cwd, nameOrPath);
  if (!existsSync(path)) throw new ConfigError(`Perfil "${nameOrPath}" não encontrado (procurado em profiles/ e em ${path}).`);
  const parsed = parseConfig(readFileSync(path, 'utf-8'));
  if (parsed.unverified.length > 0) throw new ConfigError(`Perfil "${nameOrPath}" declara regras que o revisor não verifica: ${parsed.unverified.join(', ')}.`);
  const name = JSON.parse(readFileSync(path, 'utf-8')).name ?? nameOrPath;
  return { name, rules: parsed.rules, overrides: parsed.overrides, ux: parsed.ux };
};

/** Perfil por baixo, configuração do projeto (ou deduzida da documentação) por cima. */
export const applyProfile = (config, profile) => {
  if (!profile) return config;
  // Deduzir "false" da documentação é falta de evidência, não opt-out: só o agent.config.json desliga regra do perfil.
  const own = config.deduced ? Object.fromEntries(Object.entries(config.rules).filter(([, v]) => v !== false && v !== 'any')) : config.rules;
  const ux = config.ux === false ? null : profile.ux || config.ux ? { ...(profile.ux || {}), ...(config.ux || {}) } : null;
  return {
    ...config,
    source: `perfil ${profile.name} + ${config.source}`,
    rules: { ...profile.rules, ...own },
    overrides: [...profile.overrides, ...config.overrides],
    ux,
  };
};
