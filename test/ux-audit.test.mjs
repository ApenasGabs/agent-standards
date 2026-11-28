import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runUxAudit, UxAuditError } from '../src/ux/audit.mjs';
import { collectPageMetrics } from '../src/ux/collect.mjs';
import { resolveAuditConfig, resolveBrowserEndpoint, UxConfigError } from '../src/ux/config.mjs';
import { contrastRatio, evaluateMetrics, evaluateRuntime, parseColor, summarize } from '../src/ux/evaluate.mjs';
import { groupFindings, renderUxAudit } from '../src/ux/report.mjs';

const MOBILE = { name: 'mobile', width: 375, height: 812, touch: true };
const DESKTOP = { name: 'desktop', width: 1440, height: 900, touch: false };
const LIMITS = { minTapTarget: 44, minContrast: 4.5 };
const base = (over = {}) => ({ scrollWidth: 375, innerWidth: 375, widest: [], targets: [], unnamed: [], imagesWithoutAlt: [], texts: [], ...over });
const rules = (findings) => findings.map((f) => `${f.ruleId}:${f.severity}`);

test('cores e contraste seguem a fórmula WCAG', () => {
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor('oklch(0.5 0.1 200)'), null);
  assert.equal(contrastRatio(parseColor('#000'), parseColor('#fff')), 21);
  assert.equal(contrastRatio(parseColor('#777777'), parseColor('#ffffff')), 4.48);
});

test('métricas: overflow é grave, toque só conta em viewport touch, link em frase é exceção', () => {
  const metrics = base({
    scrollWidth: 420,
    widest: [{ selector: '[data-testid="tabela"]', right: 420 }],
    targets: [
      { selector: 'button.x', width: 30, height: 30, inline: false },
      { selector: 'a.inline', width: 20, height: 18, inline: true },
    ],
  });
  const found = evaluateMetrics(metrics, MOBILE, LIMITS);
  assert.deepEqual(rules(found), ['ux-horizontal-overflow:hard', 'ux-tap-target:medium']);
  assert.match(found[0].description, /tabela/);
  assert.deepEqual(rules(evaluateMetrics({ ...metrics, scrollWidth: 1440, innerWidth: 1440 }, DESKTOP, LIMITS)), []);
});

test('métricas: contraste considera texto grande, alpha e fundo incerto', () => {
  const texts = [
    { selector: 'p.fraco', text: 'fraco', color: 'rgb(119, 119, 119)', background: 'rgb(255, 255, 255)', fontSize: 16, fontWeight: '400' },
    { selector: 'h1.grande', text: 'grande', color: 'rgb(119, 119, 119)', background: 'rgb(255, 255, 255)', fontSize: 32, fontWeight: '700' },
    { selector: 'p.translucido', text: 't', color: 'rgba(0, 0, 0, 0.3)', background: 'rgb(255, 255, 255)', fontSize: 16, fontWeight: '400' },
    { selector: 'p.ok', text: 'ok', color: 'rgb(0, 0, 0)', background: 'rgb(255, 255, 255)', fontSize: 16, fontWeight: '400' },
  ];
  const found = evaluateMetrics(base({ texts }), MOBILE, LIMITS);
  assert.deepEqual(found.map((f) => f.selector), ['p.translucido', 'p.fraco']);
});

test('métricas: viewport não aplicada invalida a combinação inteira', () => {
  const found = evaluateMetrics(base({ innerWidth: 800, scrollWidth: 900 }), MOBILE, LIMITS);
  assert.deepEqual(rules(found), ['ux-viewport-mismatch:hard']);
});

test('runtime: rota quebrada e exceção são graves, console.error é ressalva', () => {
  const found = evaluateRuntime({ navigation: { ok: false, reason: 'HTTP 500' }, pageErrors: ['boom'], consoleErrors: ['falhou'] });
  assert.deepEqual(rules(found), ['ux-navigation:hard', 'ux-page-error:hard', 'ux-console-error:medium']);
  assert.equal(summarize([{ findings: found }]).status, 'NEEDS_CHANGES');
  assert.equal(summarize([{ findings: [] }]).status, 'APPROVED');
});

test('relatório agrupa o mesmo achado de várias combinações', () => {
  const f = { ruleId: 'ux-contrast', severity: 'medium', description: 'baixo', selector: 'p' };
  const matrix = [
    { route: '/', theme: 'dark', viewport: MOBILE, screenshot: 'a.png', findings: [f] },
    { route: '/', theme: 'light', viewport: MOBILE, screenshot: 'b.png', findings: [f, { ...f, severity: 'info' }] },
  ];
  const groups = groupFindings(matrix);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].where.length, 2);
  assert.match(renderUxAudit({ head: 'abc', baseUrl: 'http://app', matrix, summary: summarize(matrix) }), /\[png\]\(b\.png\)/);
});

test('config: valida seção ux, aplica overrides da CLI e nunca embute endpoint', () => {
  assert.throws(() => resolveAuditConfig({}), UxConfigError);
  assert.throws(() => resolveAuditConfig({ baseUrl: 'http://a', themes: [{}] }), /name é obrigatório/);
  assert.throws(() => resolveAuditConfig({ baseUrl: 'http://a', login: { path: '/login' } }), /path, submit e fields/);
  const cfg = resolveAuditConfig(
    { baseUrl: 'http://a/', routes: ['/x'], themes: [{ name: 'dark', localStorage: { theme: 'dark' } }, { name: 'light' }] },
    { routes: ['/y', { path: '/z', waitFor: '#ok' }], themes: ['dark'] }
  );
  assert.equal(cfg.baseUrl, 'http://a');
  assert.deepEqual(cfg.routes.map((r) => r.path), ['/y', '/z']);
  assert.deepEqual(cfg.themes.map((t) => t.name), ['dark']);
  assert.deepEqual(cfg.viewports.map((v) => v.width), [375, 768, 1440]);
  assert.equal(resolveBrowserEndpoint({}), null);
  assert.deepEqual(resolveBrowserEndpoint({ BROWSERLESS_HOST: 'h:9222', BROWSERLESS_TOKEN: 'a b' }), { protocol: 'playwright', url: 'ws://h:9222/chromium/playwright?token=a%20b' });
  assert.equal(resolveBrowserEndpoint({ AGENT_STANDARDS_CDP_URL: 'ws://c', BROWSERLESS_HOST: 'h' }).protocol, 'cdp');
});

/** Navegador falso: registra o que o audit fez e devolve métricas por largura. */
const fakeBrowser = ({ metricsFor, landOn, failGoto } = {}) => {
  const log = { contexts: [], fills: [], closed: 0 };
  const listeners = {};
  const browser = {
    log,
    on: (event, fn) => (listeners[event] = fn),
    drop: () => listeners.disconnected?.(),
    close: async () => log.closed++,
    newContext: async (opts) => {
      const ctx = { opts, init: [] };
      log.contexts.push(ctx);
      return {
        addInitScript: async (_fn, arg) => ctx.init.push(arg),
        storageState: async () => ({ cookies: [], origins: [{ origin: 'http://app', localStorage: [] }] }),
        close: async () => (ctx.closed = true),
        newPage: async () => {
          const handlers = {};
          let url = 'about:blank';
          return {
            on: (e, f) => (handlers[e] = f),
            goto: async (u) => {
              if (failGoto?.(u)) throw new Error('net::ERR_CONNECTION_REFUSED');
              url = landOn?.(u) ?? u;
              if (u.endsWith('/quebrada')) handlers.pageerror?.(new Error('boom'));
              return { status: () => 200 };
            },
            url: () => url,
            fill: async (sel, value) => log.fills.push([sel, value]),
            click: async () => {},
            waitForSelector: async () => {},
            waitForLoadState: async () => {},
            evaluate: async (fn) => (fn === collectPageMetrics ? (metricsFor ?? ((w) => base({ innerWidth: w, scrollWidth: w })))(ctx.opts.viewport.width) : undefined),
            screenshot: async ({ path }) => writeFileSync(path, 'png'),
          };
        },
      };
    },
  };
  return browser;
};

const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('audit: percorre a matriz, aplica tema, reaproveita o login e grava relatórios', async (t) => {
  const dir = tmp(t);
  const config = resolveAuditConfig({
    baseUrl: 'http://app',
    routes: ['/list', '/quebrada'],
    themes: [{ name: 'dark', localStorage: { theme: 'dark' }, attributes: { 'data-theme': 'dark' }, colorScheme: 'dark' }],
    login: { path: '/login', fields: { '#email': 'UX_EMAIL', '#senha': 'UX_SENHA' }, submit: '#entrar' },
  });
  const browser = fakeBrowser();
  const res = await runUxAudit({ target: dir, config, browser, env: { UX_EMAIL: 'a@b', UX_SENHA: 's' } });
  assert.equal(res.summary.combinations, 6);
  assert.equal(res.summary.status, 'NEEDS_CHANGES');
  assert.deepEqual(browser.log.fills, [['#email', 'a@b'], ['#senha', 's']]);
  const audited = browser.log.contexts.slice(1);
  assert.ok(audited.every((c) => c.opts.storageState && c.opts.colorScheme === 'dark' && c.init[0].storage.theme === 'dark' && c.closed));
  assert.deepEqual(audited.slice(0, 3).map((c) => c.opts.viewport.width), [375, 768, 1440]);
  assert.equal(browser.log.closed, 0, 'navegador injetado não é fechado pelo audit');
  assert.ok(existsSync(join(dir, '.ux-review', 'list__dark__375x812.png')));
  const saved = JSON.parse(readFileSync(join(dir, '.ux-review', 'ux-report.json'), 'utf-8'));
  assert.equal(saved.matrix.length, 6);
  assert.match(readFileSync(join(dir, '.ux-review', 'UX_AUDIT.md'), 'utf-8'), /Exceção não tratada/);
});

test('audit: credencial ausente, redirecionamento para login e rota fora do ar', async (t) => {
  const dir = tmp(t);
  const withLogin = resolveAuditConfig({ baseUrl: 'http://app', routes: ['/list'], login: { path: '/login', fields: { '#e': 'NAO_EXISTE' }, submit: '#s' } });
  await assert.rejects(runUxAudit({ target: dir, config: withLogin, browser: fakeBrowser(), env: {} }), /NAO_EXISTE não definida/);

  const redirected = resolveAuditConfig({ baseUrl: 'http://app', routes: ['/list'], login: { path: '/login', fields: { '#e': 'E' }, submit: '#s' } });
  const res = await runUxAudit({ target: dir, config: redirected, env: { E: 'x' }, browser: fakeBrowser({ landOn: (u) => (u.endsWith('/list') ? 'http://app/login?next=/list' : u) }) });
  assert.match(res.matrix[0].findings[0].description, /sessão de login não foi aplicada/);

  const down = resolveAuditConfig({ baseUrl: 'http://app', routes: ['/'] });
  const res2 = await runUxAudit({ target: dir, config: down, browser: fakeBrowser({ failGoto: () => true }) });
  assert.equal(res2.matrix[0].findings[0].ruleId, 'ux-navigation');
  assert.equal(res2.summary.status, 'NEEDS_CHANGES');
});

test('audit: queda da conexão falha alto em vez de sair em silêncio', async (t) => {
  const dir = tmp(t);
  const config = resolveAuditConfig({ baseUrl: 'http://app', routes: ['/'] });
  const browser = fakeBrowser();
  browser.newContext = async () => {
    browser.drop();
    return new Promise(() => {});
  };
  await assert.rejects(runUxAudit({ target: dir, config, browser }), (err) => err instanceof UxAuditError && /perdeu a conexão/.test(err.message));
});
