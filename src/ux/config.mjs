/**
 * Configuração do `ux-audit`, lida da seção `ux` do agent.config.json e sobrescrita pela CLI.
 *
 * Exemplo:
 * "ux": {
 *   "baseUrl": "https://app.exemplo.dev",
 *   "routes": ["/list", { "path": "/stock", "waitFor": "[data-testid=stock-page]" }],
 *   "themes": [
 *     { "name": "light", "localStorage": { "theme": "light" }, "colorScheme": "light" },
 *     { "name": "dark", "localStorage": { "theme": "dark" }, "attributes": { "data-theme": "dark" } }
 *   ],
 *   "login": {
 *     "path": "/login",
 *     "fields": { "[data-testid=login-email]": "E2E_EMAIL", "[data-testid=login-password]": "E2E_PASSWORD" },
 *     "submit": "[data-testid=login-submit]",
 *     "waitFor": "[data-testid=nav-list]"
 *   }
 * }
 */

import process from 'node:process';

export class UxConfigError extends Error {}

export const DEFAULT_VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812, touch: true },
  { name: 'tablet', width: 768, height: 1024, touch: true },
  { name: 'desktop', width: 1440, height: 900, touch: false },
];

/**
 * Temas genéricos: cobrem os mecanismos mais comuns ao mesmo tempo (prefers-color-scheme, daisyUI
 * `data-theme`, Tailwind `class="dark"` e `localStorage.theme`), sem configuração por projeto.
 * Se o app usar outro mecanismo, o audit acusa `ux-theme-not-applied` em vez de fingir que testou os dois.
 */
export const GENERIC_THEMES = [
  { name: 'light', colorScheme: 'light', localStorage: { theme: 'light' }, attributes: { 'data-theme': 'light' }, addClass: [], removeClass: ['dark'] },
  { name: 'dark', colorScheme: 'dark', localStorage: { theme: 'dark' }, attributes: { 'data-theme': 'dark' }, addClass: ['dark'], removeClass: ['light'] },
];

/** Credenciais do login automático: mesmos nomes em todo repositório. */
export const AUTO_LOGIN_ENV = { email: 'UX_AUDIT_EMAIL', password: 'UX_AUDIT_PASSWORD' };

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringMap = (v) => isPlainObject(v) && Object.values(v).every((x) => typeof x === 'string');

const normalizeRoute = (route, i) => {
  if (typeof route === 'string' && route) return { path: route, waitFor: null };
  if (isPlainObject(route) && typeof route.path === 'string' && route.path) {
    if (route.waitFor !== undefined && typeof route.waitFor !== 'string') throw new UxConfigError(`ux.routes[${i}].waitFor deve ser um seletor.`);
    return { path: route.path, waitFor: route.waitFor ?? null };
  }
  throw new UxConfigError(`ux.routes[${i}] deve ser um caminho ("/lista") ou { "path": "/lista" }.`);
};

const normalizeTheme = (theme, i) => {
  if (!isPlainObject(theme) || typeof theme.name !== 'string' || !theme.name) throw new UxConfigError(`ux.themes[${i}].name é obrigatório.`);
  for (const key of ['localStorage', 'attributes']) {
    if (theme[key] !== undefined && !isStringMap(theme[key])) throw new UxConfigError(`ux.themes[${i}].${key} deve mapear chaves para textos.`);
  }
  for (const key of ['addClass', 'removeClass']) {
    if (theme[key] !== undefined && !(Array.isArray(theme[key]) && theme[key].every((c) => typeof c === 'string' && /^[\w-]+$/.test(c)))) {
      throw new UxConfigError(`ux.themes[${i}].${key} deve ser uma lista de classes.`);
    }
  }
  if (theme.colorScheme !== undefined && !['light', 'dark'].includes(theme.colorScheme)) {
    throw new UxConfigError(`ux.themes[${i}].colorScheme aceita "light" ou "dark".`);
  }
  return {
    name: theme.name,
    localStorage: theme.localStorage ?? {},
    attributes: theme.attributes ?? {},
    addClass: theme.addClass ?? [],
    removeClass: theme.removeClass ?? [],
    colorScheme: theme.colorScheme ?? null,
  };
};

const normalizeViewport = (vp, i) => {
  if (!isPlainObject(vp) || !Number.isInteger(vp.width) || !Number.isInteger(vp.height) || vp.width <= 0 || vp.height <= 0) {
    throw new UxConfigError(`ux.viewports[${i}] precisa de width e height inteiros.`);
  }
  return { name: vp.name ?? `${vp.width}x${vp.height}`, width: vp.width, height: vp.height, touch: vp.touch ?? vp.width < 1024 };
};

const normalizeLogin = (login) => {
  if (login === undefined || login === null || login === false) return null;
  if (login === 'auto') return { auto: true, path: null, fields: null, submit: null, waitFor: null };
  if (!isPlainObject(login) || typeof login.path !== 'string' || typeof login.submit !== 'string' || !isStringMap(login.fields)) {
    throw new UxConfigError('ux.login precisa de path, submit e fields ({ "seletor": "NOME_DA_VARIAVEL" }).');
  }
  return { auto: false, path: login.path, fields: login.fields, submit: login.submit, waitFor: typeof login.waitFor === 'string' ? login.waitFor : null };
};

/**
 * @param {object|null} section seção `ux` do agent.config.json
 * @param {object} cli overrides vindos da linha de comando
 */
export const resolveAuditConfig = (section, cli = {}) => {
  const ux = section ?? {};
  if (!isPlainObject(ux)) throw new UxConfigError('ux deve ser um objeto.');
  const baseUrl = cli.url ?? (ux.baseUrl === 'auto' ? undefined : ux.baseUrl);
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new UxConfigError(
      ux.baseUrl === 'auto'
        ? 'Nenhum preview encontrado para este commit (deployments do GitHub). Informe --url com uma URL acessível ao navegador remoto.'
        : 'Informe a URL do app (--url ou ux.baseUrl), acessível a partir do navegador remoto.'
    );
  }
  const routes = cli.routes ?? ux.routes ?? ['/'];
  if (!Array.isArray(routes) || routes.length === 0) throw new UxConfigError('ux.routes deve ser uma lista não vazia.');
  const rawThemes = ux.themes === undefined || ux.themes === 'auto' ? GENERIC_THEMES : ux.themes;
  if (!Array.isArray(rawThemes) || rawThemes.length === 0) throw new UxConfigError('ux.themes deve ser "auto" ou uma lista de temas.');
  const themes = rawThemes.map(normalizeTheme);
  const selectedThemes = cli.themes ? themes.filter((t) => cli.themes.includes(t.name)) : themes;
  if (selectedThemes.length === 0) throw new UxConfigError(`Nenhum tema corresponde a --themes ${cli.themes?.join(',')}.`);
  const minTapTarget = ux.minTapTarget ?? 44;
  const minContrast = ux.minContrast ?? 4.5;
  if (typeof minTapTarget !== 'number' || typeof minContrast !== 'number') throw new UxConfigError('ux.minTapTarget e ux.minContrast devem ser números.');
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    routes: routes.map(normalizeRoute),
    themes: selectedThemes,
    viewports: (ux.viewports ?? DEFAULT_VIEWPORTS).map(normalizeViewport),
    login: normalizeLogin(ux.login),
    thresholds: { minTapTarget, minContrast },
    outDir: cli.out ?? ux.outDir ?? '.ux-review',
  };
};

/**
 * Resolve como alcançar o navegador, sem nenhum valor embutido.
 * Prefere o protocolo nativo do Playwright: via CDP o Browserless ignora a viewport do contexto
 * (innerWidth fica no tamanho da janela), o que invalidaria a matriz de viewports.
 */
export const resolveBrowserEndpoint = (env = process.env) => {
  if (env.AGENT_STANDARDS_BROWSER_WS) return { protocol: 'playwright', url: env.AGENT_STANDARDS_BROWSER_WS };
  if (env.AGENT_STANDARDS_CDP_URL) return { protocol: 'cdp', url: env.AGENT_STANDARDS_CDP_URL };
  if (env.BROWSERLESS_HOST) {
    const host = env.BROWSERLESS_HOST.replace(/^wss?:\/\//, '').replace(/\/+$/, '');
    const token = env.BROWSERLESS_TOKEN ? `?token=${encodeURIComponent(env.BROWSERLESS_TOKEN)}` : '';
    return { protocol: 'playwright', url: `ws://${host}/chromium/playwright${token}` };
  }
  return null;
};
