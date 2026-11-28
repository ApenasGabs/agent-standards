import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { buildReworkIssue, detectAuthor, dispatchConfig, dispatchRework } from '../src/dispatch.mjs';
import { runCodeReview } from '../src/review.mjs';

const gitLog = ({ name = 'Gabriel', message = 'feat: ajustes', branch = 'feat/#1-x' }) => (_cmd, args) => {
  if (args.includes('--format=%an')) return name;
  if (args.includes('--format=%B')) return message;
  return branch;
};

test('autoria: marcadores de agente em palavra inteira, sem falso positivo em "mais"/"falhas"', () => {
  assert.equal(detectAuthor(gitLog({ message: 'fix: corrigir mais falhas de layout' })).type, 'human');
  assert.equal(detectAuthor(gitLog({ name: 'kraken-forge[bot]' })).type, 'ai');
  assert.equal(detectAuthor(gitLog({ message: 'feat: tela nova (APE-512)' })).evidence, 'mensagem: APE-512');
  assert.equal(detectAuthor(gitLog({ branch: 'forge/ape-12' })).type, 'ai');
  assert.equal(detectAuthor(gitLog({ name: 'Paperclip Forge' }), 'human').type, 'human', '--author vence a heurística');
  assert.equal(detectAuthor(() => { throw new Error('sem git'); }).type, 'human');
});

const ENV = { PAPERCLIP_URL: 'http://pc/', PAPERCLIP_API_KEY: 'tok', PAPERCLIP_COMPANY_ID: 'c1', PAPERCLIP_PROJECT_ID: 'p1', PAPERCLIP_DISPATCH_AGENT_ID: 'a1' };

const RESULT = {
  appName: 'app',
  task: { source: 'Issue #7' },
  reportPath: '/r/REVIEW_REPORT.md',
  divergences: [
    { axis: 'Standards', severity: 'hard', file: 'src/a.ts', line: 3, ruleId: 'no-explicit-any', description: 'any' },
    { axis: 'UX', severity: 'hard', file: 'render / · dark · 375×812', line: null, ruleId: 'ux-horizontal-overflow', description: 'overflow' },
    { axis: 'UX', severity: 'medium', file: 'src/B.tsx', line: 1, ruleId: 'ux-anti-slop', description: 'slop' },
  ],
  ci: { failed: [{ name: 'test', detailsUrl: 'https://ci/1' }], timedOut: [] },
  problems: [],
};

test('dispatch: configuração só por ambiente, com token de arquivo e lista do que falta', (t) => {
  assert.deepEqual(dispatchConfig({}).missing.length, 5);
  const dir = mkdtempSync(join(tmpdir(), 'tok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), ' segredo \n');
  const { PAPERCLIP_API_KEY, ...rest } = ENV;
  const cfg = dispatchConfig({ ...rest, PAPERCLIP_TOKEN_FILE: join(dir, 'token') });
  assert.equal(cfg.token, 'segredo');
  assert.equal(cfg.url, 'http://pc');
  assert.deepEqual(cfg.missing, []);
});

test('dispatch: issue lista só bloqueios, com arquivo/linha, CI e relatório', () => {
  const { title, description } = buildReworkIssue(RESULT);
  assert.match(title, /Issue #7/);
  assert.match(description, /\[Standards\] `src\/a\.ts:3` \*\*no-explicit-any\*\*/);
  assert.match(description, /\[UX\] `render \/ · dark · 375×812` \*\*ux-horizontal-overflow\*\*/);
  assert.match(description, /\[CI\] test: https:\/\/ci\/1/);
  assert.doesNotMatch(description, /ux-anti-slop/);
});

test('dispatch: cria a issue, acorda o agente e nunca expõe o token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/issues') ? { ok: true, json: async () => ({ identifier: 'APE-900' }) } : { ok: true };
  };
  const res = await dispatchRework({ result: RESULT, env: ENV, fetchImpl });
  assert.deepEqual(res, { dispatched: true, issue: 'APE-900' });
  assert.equal(calls[0].url, 'http://pc/api/companies/c1/issues');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.assigneeAgentId, 'a1');
  assert.equal(body.projectId, 'p1');
  assert.equal(calls[1].url, 'http://pc/api/agents/a1/wakeup');

  assert.deepEqual(await dispatchRework({ result: RESULT, env: {}, fetchImpl }), { dispatched: false, reason: 'faltam variáveis de ambiente: PAPERCLIP_URL, PAPERCLIP_COMPANY_ID, PAPERCLIP_PROJECT_ID, PAPERCLIP_DISPATCH_AGENT_ID, PAPERCLIP_API_KEY ou PAPERCLIP_TOKEN_FILE' });
  assert.match((await dispatchRework({ result: RESULT, env: ENV, fetchImpl: async () => ({ ok: false, status: 401 }) })).reason, /HTTP 401/);
  const wakeFails = await dispatchRework({ result: RESULT, env: ENV, fetchImpl: async (url) => (url.endsWith('/issues') ? { ok: true, json: async () => ({ id: 'x' }) } : { ok: false, status: 500 }) });
  assert.equal(wakeFails.dispatched, true);
  assert.match(wakeFails.warning, /wakeup/);
  const down = await dispatchRework({ result: RESULT, env: ENV, fetchImpl: async () => { throw new Error('Bearer tok recusado'); } });
  assert.doesNotMatch(down.reason, /tok recusado/);
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });

const repo = (t, files) => {
  const dir = mkdtempSync(join(tmpdir(), 'compat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (fs) => {
    for (const [name, text] of Object.entries(fs)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };
  git(dir, 'init', '-q', '-b', 'main');
  write({ 'README.md': 'x\n' });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  write(files);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'change');
  return dir;
};

const exec = (command, args, cwd) => {
  if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  throw new Error('gh indisponível');
};

test('--task: arquivo de spec, texto livre e arquivo inexistente', async (t) => {
  const dir = repo(t, { 'src/a.ts': 'export const salvarItem = () => 1;\n', 'test/a.test.mjs': '1;\n', 'docs/specs/item.md': '## Critérios de aceite\n- [ ] Função `salvarItem`\n' });
  const bySpec = await runCodeReview({ target: dir, base: 'main', task: 'docs/specs/item.md', exec });
  assert.equal(bySpec.task.source, 'Spec docs/specs/item.md');
  assert.equal(bySpec.requirements[0].status, 'evidence');

  const byText = await runCodeReview({ target: dir, base: 'main', task: 'Criar a função `salvarItem`', exec });
  assert.equal(byText.requirements.length, 1);
  assert.equal(byText.requirements[0].status, 'evidence');

  const missing = await runCodeReview({ target: dir, base: 'main', task: 'docs/specs/nao-existe.md', exec });
  assert.equal(missing.status, 'INCONCLUSIVE');
});
