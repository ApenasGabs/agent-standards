import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join, relative, resolve } from 'node:path';
import process from 'node:process';
import { collectPageMetrics } from './collect.mjs';
import { resolveBrowserEndpoint } from './config.mjs';
import { evaluateMetrics, evaluateRuntime, summarize } from './evaluate.mjs';
import { renderUxAudit } from './report.mjs';

export class UxAuditError extends Error {}

export const UX_REPORT_FILE = 'ux-report.json';
export const UX_MARKDOWN_FILE = 'UX_AUDIT.md';

const NAV_TIMEOUT = 30_000;
const SELECTOR_TIMEOUT = 15_000;
const STEP_TIMEOUT = 120_000;

const firstLine = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 200);

const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/**
 * Procura playwright-core/playwright no projeto alvo, neste pacote e nos módulos globais e usa a versão
 * mais nova: servidores remotos (Browserless) só aceitam clientes recentes, e um cliente antigo
 * derruba a conexão em silêncio.
 */
export const loadPlaywright = (targetDir, env = process.env) => {
  const bases = [
    join(targetDir, 'package.json'),
    import.meta.url,
    ...(env.NODE_PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'index.js')),
    '/usr/local/lib/node_modules/index.js',
    '/usr/lib/node_modules/index.js',
  ];
  const found = new Map();
  for (const base of bases) {
    for (const name of ['playwright-core', 'playwright']) {
      try {
        const req = createRequire(base);
        const path = req.resolve(name);
        if (!found.has(path)) found.set(path, { load: () => req(name), version: req(`${name}/package.json`).version });
      } catch {
        // Não está neste local; tenta o próximo.
      }
    }
  }
  const best = [...found.values()].sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!best) throw new UxAuditError('playwright-core não encontrado. Instale no projeto (`npm i -D playwright-core`) ou globalmente.');
  return { playwright: best.load(), version: best.version };
};

const openBrowser = async (playwright, { endpoint, local }) => {
  if (endpoint) {
    try {
      return endpoint.protocol === 'cdp'
        ? await playwright.chromium.connectOverCDP(endpoint.url, { timeout: NAV_TIMEOUT })
        : await playwright.chromium.connect(endpoint.url, { timeout: NAV_TIMEOUT });
    } catch (err) {
      // Não repete o endpoint: ele pode carregar o token.
      throw new UxAuditError(`Não foi possível conectar ao navegador remoto (${endpoint.protocol}): ${firstLine(err).replace(/token=[^&\s]+/g, 'token=***')}`);
    }
  }
  if (local) return playwright.chromium.launch();
  throw new UxAuditError('Sem navegador: defina BROWSERLESS_HOST e BROWSERLESS_TOKEN (ou AGENT_STANDARDS_CDP_URL), ou use --local.');
};

/** Executado na página antes dos scripts do app. */
const applyTheme = ({ storage, attributes }) => {
  try {
    for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
  } catch {
    // Storage indisponível nesta origem (ex.: about:blank); o tema ainda pode vir dos atributos.
  }
  // O init script roda antes do <html> existir em alguns documentos: aplicar cedo sem quebrar, e de novo no DOMContentLoaded.
  const set = () => {
    for (const [key, value] of Object.entries(attributes)) document.documentElement?.setAttribute(key, value);
  };
  set();
  document.addEventListener('DOMContentLoaded', set, { once: true });
};

const applyAttributes = (attributes) => {
  for (const [key, value] of Object.entries(attributes)) document.documentElement.setAttribute(key, value);
};

const login = async (browser, config, env, outDir) => {
  const values = Object.entries(config.login.fields).map(([selector, envName]) => {
    const value = env[envName];
    if (!value) throw new UxAuditError(`Variável ${envName} não definida; ela é usada no login do ux-audit.`);
    return [selector, value];
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let page = null;
  try {
    page = await context.newPage();
    await page.goto(`${config.baseUrl}${config.login.path}`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
    for (const [selector, value] of values) await page.fill(selector, value, { timeout: SELECTOR_TIMEOUT });
    await page.click(config.login.submit, { timeout: SELECTOR_TIMEOUT });
    if (config.login.waitFor) await page.waitForSelector(config.login.waitFor, { timeout: NAV_TIMEOUT });
    else await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT });
    return await context.storageState();
  } catch (err) {
    if (err instanceof UxAuditError) throw err;
    // Evidência para diagnosticar sem repetir tentativas de login às cegas (os campos já foram preenchidos; a senha é mascarada pelo input).
    const shot = join(outDir, 'login-failure.png');
    const evidence = page
      ? await Promise.all([page.screenshot({ path: shot, fullPage: true }).then(() => shot), Promise.resolve(new URL(page.url()).pathname)]).catch(() => [null, null])
      : [null, null];
    const detail = evidence[0] ? ` Página em ${evidence[1]}; screenshot: ${evidence[0]}.` : '';
    throw new UxAuditError(`Login do ux-audit falhou: ${firstLine(err)}.${detail}`);
  } finally {
    await context.close();
  }
};

const slug = (text) => text.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-') || 'root';

const auditCombination = async ({ browser, config, route, theme, viewport, storageState, outDir }) => {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    ...(theme.colorScheme ? { colorScheme: theme.colorScheme } : {}),
    ...(storageState ? { storageState } : {}),
  });
  const pageErrors = [];
  const consoleErrors = [];
  let navigation = { ok: true };
  let metrics = null;
  const file = `${slug(route.path)}__${slug(theme.name)}__${viewport.width}x${viewport.height}.png`;
  try {
    await context.addInitScript(applyTheme, { storage: theme.localStorage, attributes: theme.attributes });
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(firstLine(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().split('\n')[0].slice(0, 200));
    });
    try {
      const response = await page.goto(`${config.baseUrl}${route.path}`, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });
      if (response && response.status() >= 400) navigation = { ok: false, reason: `HTTP ${response.status()}` };
      if (route.waitFor) await page.waitForSelector(route.waitFor, { timeout: SELECTOR_TIMEOUT });
    } catch (err) {
      navigation = { ok: false, reason: firstLine(err) };
    }
    const landed = new URL(page.url()).pathname;
    if (navigation.ok && config.login && landed.startsWith(config.login.path) && !route.path.startsWith(config.login.path)) {
      navigation = { ok: false, reason: `redirecionou para ${landed}; a sessão de login não foi aplicada` };
    }
    await page.evaluate(applyAttributes, theme.attributes);
    metrics = await page.evaluate(collectPageMetrics, { maxTexts: 400 });
    await page.screenshot({ path: join(outDir, file), fullPage: true });
  } catch (err) {
    navigation = { ok: false, reason: firstLine(err) };
  } finally {
    await context.close();
  }
  const findings = [
    ...evaluateRuntime({ pageErrors, consoleErrors, navigation }),
    ...(metrics ? evaluateMetrics(metrics, viewport, config.thresholds) : []),
  ];
  return { route: route.path, theme: theme.name, viewport, screenshot: metrics ? file : null, findings };
};

/**
 * Limita cada etapa no tempo. Sem isso, uma conexão que cai em silêncio deixa a promise pendente,
 * o Node encerra com código 0 e o gate "passa" sem ter auditado nada.
 */
const guard = (browser, version) => {
  let dropped = false;
  const waiting = new Set();
  browser.on?.('disconnected', () => {
    dropped = true;
    for (const fail of waiting) fail();
  });
  return (promise, what, ms = STEP_TIMEOUT) => {
    let timer;
    let fail;
    const limit = new Promise((_, reject) => {
      fail = () => {
        const why = dropped ? 'perdeu a conexão com o navegador remoto' : `não respondeu em ${ms / 1000}s`;
        reject(new UxAuditError(`${what} ${why}. Cliente playwright-core ${version}: confira se o servidor aceita esta versão.`));
      };
      if (dropped) fail();
      timer = setTimeout(fail, ms);
      waiting.add(fail);
    });
    return Promise.race([promise, limit]).finally(() => {
      clearTimeout(timer);
      waiting.delete(fail);
    });
  };
};

const gitHead = (cwd) => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Fora de um repositório git: o review não conseguirá casar o relatório com um commit.
    return null;
  }
};

/**
 * @param {{ target: string, config: ReturnType<import('./config.mjs').resolveAuditConfig>, env?: object, local?: boolean, browser?: object, playwright?: object }} options
 */
export const runUxAudit = async ({ target, config, env = process.env, local = false, browser: injected, playwright }) => {
  const targetDir = resolve(target);
  const outDir = resolve(targetDir, config.outDir);
  mkdirSync(outDir, { recursive: true });
  const client = injected ? { version: 'injetado' } : playwright ? { playwright, version: 'informado' } : loadPlaywright(targetDir, env);
  const browser = injected ?? (await openBrowser(client.playwright, { endpoint: resolveBrowserEndpoint(env), local }));
  const within = guard(browser, client.version);
  const matrix = [];
  try {
    const storageState = config.login ? await within(login(browser, config, env, outDir), 'O login') : null;
    for (const route of config.routes) {
      for (const theme of config.themes) {
        for (const viewport of config.viewports) {
          const label = `A combinação ${route.path} · ${theme.name} · ${viewport.width}×${viewport.height}`;
          matrix.push(await within(auditCombination({ browser, config, route, theme, viewport, storageState, outDir }), label));
        }
      }
    }
  } finally {
    if (!injected) {
      await within(browser.close(), 'O fechamento do navegador', 10_000).catch(() => {
        // A conexão já caiu; não há o que fechar.
      });
    }
  }
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    head: gitHead(targetDir),
    baseUrl: config.baseUrl,
    thresholds: config.thresholds,
    matrix,
    summary: summarize(matrix),
  };
  const reportPath = join(outDir, UX_REPORT_FILE);
  const markdownPath = join(outDir, UX_MARKDOWN_FILE);
  writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  writeFileSync(markdownPath, renderUxAudit(result), 'utf-8');
  return { ...result, reportPath: relative(targetDir, reportPath), markdownPath: relative(targetDir, markdownPath) };
};
