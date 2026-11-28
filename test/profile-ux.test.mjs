import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { applyProfile, ConfigError, configFromDocs, loadProfile, parseConfig } from '../src/review/config.mjs';
import { runCodeReview } from '../src/review.mjs';
import { runUxAudit } from '../src/ux/audit.mjs';
import { collectPageMetrics, findLoginForm } from '../src/ux/collect.mjs';
import { GENERIC_THEMES, resolveAuditConfig, UxConfigError } from '../src/ux/config.mjs';
import { discoverPreviewUrl } from '../src/ux/discover.mjs';
import { markThemesNotApplied } from '../src/ux/evaluate.mjs';

const tmp = (t, prefix = 'profile-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('perfil kraken: liga Eixo UX e gate sem config no projeto', () => {
  const kraken = loadProfile('kraken');
  assert.equal(kraken.name, 'kraken');
  const merged = applyProfile(configFromDocs([]), kraken);
  assert.equal(merged.rules['ux.blockSlopPatterns'], true);
  assert.equal(merged.rules['ux.blockImportant'], true, 'falso deduzido da doc não desliga o perfil');
  assert.equal(merged.ux.baseUrl, 'auto');
  assert.match(merged.source, /^perfil kraken \+ /);
  assert.equal(loadProfile(undefined), null);
  assert.throws(() => loadProfile('nao-existe'), ConfigError);
});

test('perfil: o agent.config.json do projeto sobrescreve e pode fazer opt-out', () => {
  const kraken = loadProfile('kraken');
  const own = parseConfig(JSON.stringify({ rules: { ux: { blockHardcodedColors: false } }, ux: { routes: ['/painel'] } }));
  const merged = applyProfile(own, kraken);
  assert.equal(merged.rules['ux.blockHardcodedColors'], false);
  assert.equal(merged.rules['ux.blockSlopPatterns'], true);
  assert.deepEqual(merged.ux.routes, ['/painel']);
  assert.equal(merged.ux.themes, 'auto');
  assert.equal(applyProfile(parseConfig('{"ux": false}'), kraken).ux, null);
});

test('config ux: temas genéricos, login automático e URL obrigatória quando baseUrl é auto', () => {
  const cfg = resolveAuditConfig({ baseUrl: 'auto', themes: 'auto', login: 'auto' }, { url: 'http://preview' });
  assert.deepEqual(cfg.themes.map((t) => t.name), ['light', 'dark']);
  assert.deepEqual(cfg.themes[1].addClass, ['dark']);
  assert.equal(cfg.login.auto, true);
  assert.equal(resolveAuditConfig({ baseUrl: 'http://a' }).themes.length, GENERIC_THEMES.length);
  assert.throws(() => resolveAuditConfig({ baseUrl: 'auto' }), /Nenhum preview encontrado/);
  assert.throws(() => resolveAuditConfig({ baseUrl: 'http://a', themes: 'escuro' }), UxConfigError);
  assert.throws(() => resolveAuditConfig({ baseUrl: 'http://a', themes: [{ name: 'x', addClass: ['a b'] }] }), /lista de classes/);
});

test('tema não aplicado: mesmo fundo em todos os temas gera ressalva', () => {
  const vp = { width: 375, height: 812 };
  const matrix = [
    { route: '/', theme: 'light', viewport: vp, canvas: 'rgb(255, 255, 255)', findings: [] },
    { route: '/', theme: 'dark', viewport: vp, canvas: 'rgb(255, 255, 255)', findings: [] },
    { route: '/b', theme: 'light', viewport: vp, canvas: 'rgb(255, 255, 255)', findings: [] },
    { route: '/b', theme: 'dark', viewport: vp, canvas: 'rgb(29, 35, 42)', findings: [] },
  ];
  markThemesNotApplied(matrix);
  assert.deepEqual(matrix.map((m) => m.findings.map((f) => f.ruleId).join()), ['ux-theme-not-applied', 'ux-theme-not-applied', '', '']);
});

test('preview: usa o primeiro deployment com status success e URL', () => {
  const calls = [];
  const run = (_cmd, args) => {
    calls.push(args[1]);
    if (args[1].includes('deployments?sha=abc')) return JSON.stringify([{ id: 1, environment: 'Preview' }, { id: 2, environment: 'Preview' }]);
    if (args[1].includes('/deployments/1/statuses')) return JSON.stringify([{ state: 'failure', environment_url: 'https://x' }]);
    return JSON.stringify([{ state: 'success', environment_url: 'https://pr-2.vercel.app/' }]);
  };
  assert.deepEqual(discoverPreviewUrl(run, 'abc'), { url: 'https://pr-2.vercel.app', environment: 'Preview' });
  assert.ok(calls.every((c) => c.startsWith('repos/{owner}/{repo}/')));
  assert.equal(discoverPreviewUrl(() => '[]', 'abc'), null);
});

/** Navegador falso com formulário de login opcional. */
const fakeBrowser = ({ loginForm = null, passwordVisible = false } = {}) => {
  const log = { contexts: [], fills: [], pressed: [], clicked: [] };
  return {
    log,
    on: () => {},
    close: async () => {},
    newContext: async (opts) => {
      const ctx = { opts, init: [] };
      log.contexts.push(ctx);
      return {
        addInitScript: async (_fn, arg) => ctx.init.push(arg),
        storageState: async () => ({ cookies: [{ name: 'sessao' }], origins: [] }),
        close: async () => {},
        newPage: async () => ({
          on: () => {},
          goto: async () => ({ status: () => 200 }),
          url: () => 'http://app/',
          fill: async (sel, value) => log.fills.push([sel, value]),
          click: async (sel) => log.clicked.push(sel),
          press: async (sel, key) => log.pressed.push([sel, key]),
          waitForFunction: async () => {},
          waitForLoadState: async () => {},
          waitForSelector: async () => {},
          screenshot: async ({ path }) => writeFileSync(path, 'png'),
          evaluate: async (fn) => {
            if (fn === findLoginForm) return loginForm;
            if (fn === collectPageMetrics) {
              const w = ctx.opts.viewport.width;
              return { scrollWidth: w, innerWidth: w, widest: [], targets: [], unnamed: [], imagesWithoutAlt: [], texts: [], hasPasswordField: passwordVisible, canvas: 'rgb(255, 255, 255)' };
            }
            return undefined;
          },
        }),
      };
    },
  };
};

const autoConfig = (routes = ['/']) => resolveAuditConfig({ baseUrl: 'auto', themes: 'auto', login: 'auto', routes }, { url: 'http://app' });

test('login automático: preenche pelo formulário achado e reaproveita a sessão', async (t) => {
  const browser = fakeBrowser({ loginForm: { user: true, submit: false } });
  const res = await runUxAudit({ target: tmp(t), config: autoConfig(), browser, env: { UX_AUDIT_EMAIL: 'qa@app', UX_AUDIT_PASSWORD: 'x' } });
  assert.deepEqual(browser.log.fills, [['[data-ux-audit-login="user"]', 'qa@app'], ['[data-ux-audit-login="password"]', 'x']]);
  assert.deepEqual(browser.log.pressed, [['[data-ux-audit-login="password"]', 'Enter']]);
  assert.ok(browser.log.contexts.slice(1).every((c) => c.opts.storageState?.cookies.length === 1));
  assert.deepEqual(browser.log.contexts[2].init[0].removeClass, ['dark'], 'tema light remove a classe dark sem apagar as outras');
  assert.equal(res.summary.combinations, 6);
});

test('login automático: sem credenciais avisa que telas autenticadas não foram auditadas', async (t) => {
  const browser = fakeBrowser({ passwordVisible: true });
  const res = await runUxAudit({ target: tmp(t), config: autoConfig(), browser, env: {} });
  assert.equal(browser.log.fills.length, 0);
  const required = res.matrix.flatMap((m) => m.findings).filter((f) => f.ruleId === 'ux-login-required');
  assert.equal(required.length, 6);
  assert.match(required[0].description, /UX_AUDIT_EMAIL/);
  assert.ok(res.matrix.every((m) => m.findings.some((f) => f.ruleId === 'ux-theme-not-applied')), 'mesmo fundo nos dois temas');
});

test('preview protegido: segredo de automação da Vercel vira header em todos os contextos', async (t) => {
  const browser = fakeBrowser();
  await runUxAudit({ target: tmp(t), config: autoConfig(), browser, env: { VERCEL_AUTOMATION_BYPASS_SECRET: 's3' } });
  assert.ok(browser.log.contexts.every((c) => c.opts.extraHTTPHeaders?.['x-vercel-protection-bypass'] === 's3'));
});

// ── review com perfil e --ux-audit auto ──────────────────────────────────────

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });

const repoWithUiChange = (t) => {
  const dir = tmp(t, 'review-profile-');
  const write = (files) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };
  git(dir, 'init', '-q', '-b', 'main');
  write({ 'README.md': 'x\n' });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  write({ 'src/Card.tsx': 'export const Card = () => <div className="border-l-4">x</div>;\n', 'src/__tests__/Card.test.tsx': '1;\n' });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ui');
  return dir;
};

const execWith = (deployments) => (command, args, cwd) => {
  if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  if (command === 'gh' && args[0] === 'api') {
    if (args[1].includes('deployments?sha=')) return JSON.stringify(deployments);
    return JSON.stringify([{ state: 'success', environment_url: 'https://preview.app' }]);
  }
  throw new Error('gh indisponível');
};

test('review com perfil kraken: repo sem config ganha Eixo UX e gate', async (t) => {
  const dir = repoWithUiChange(t);
  const res = await runCodeReview({ target: dir, base: 'main', profile: 'kraken', exec: execWith([]) });
  assert.equal(res.profile, 'kraken');
  assert.ok(res.divergences.some((d) => d.axis === 'UX' && d.ruleId === 'ux-anti-slop'));
  assert.equal(res.uxAudit.state, 'missing');
  const md = readFileSync(res.reportPath, 'utf-8');
  assert.match(md, /Regras\*\*: perfil kraken \+ /);
});

test('review --ux-audit auto: descobre o preview e roda a auditoria do commit', async (t) => {
  const dir = repoWithUiChange(t);
  const calls = [];
  const uxAuditRunner = async ({ target, config }) => {
    calls.push(config);
    const head = git(target, 'rev-parse', 'HEAD').trim();
    mkdirSync(join(target, '.ux-review'), { recursive: true });
    writeFileSync(join(target, '.ux-review', 'ux-report.json'), JSON.stringify({ head, matrix: [], summary: { combinations: 6, hard: 0, medium: 0 } }));
  };
  const res = await runCodeReview({ target: dir, base: 'main', profile: 'kraken', uxAudit: 'auto', uxRoutes: ['/cards'], uxAuditRunner, exec: execWith([{ id: 9 }]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseUrl, 'https://preview.app');
  assert.deepEqual(calls[0].routes.map((r) => r.path), ['/cards']);
  assert.equal(res.uxAudit.state, 'ok');
  assert.match(readFileSync(res.reportPath, 'utf-8'), /Auditoria renderizada de https:\/\/preview\.app/);
});

test('review --ux-audit auto sem preview registra o motivo e não aprova', async (t) => {
  const dir = repoWithUiChange(t);
  const res = await runCodeReview({ target: dir, base: 'main', profile: 'kraken', uxAudit: 'auto', uxAuditRunner: async () => assert.fail('não deveria rodar'), exec: execWith([]) });
  assert.equal(res.uxAudit.state, 'missing');
  assert.ok(res.notes.some((n) => /nenhum preview publicado/.test(n)));
  assert.notEqual(res.status, 'APPROVED');
});

test('review com perfil inexistente é inconclusivo', async (t) => {
  const res = await runCodeReview({ target: repoWithUiChange(t), base: 'main', profile: 'nao-existe', exec: execWith([]) });
  assert.equal(res.status, 'INCONCLUSIVE');
});
