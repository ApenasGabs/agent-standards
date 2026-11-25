import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCodeReview } from '../src/review.mjs';
import { syncAgentDocs } from '../src/sync.mjs';

const CLI = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), '../bin/agent-standards.mjs');
const CONFIG = JSON.stringify({ rules: { functions: 'arrow-only', cleanCode: { blockConsoleLog: true } } });

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });

const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
};

const setup = (t, base, change = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { 'README.md': 'x\n', ...base });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  if (Object.keys(change).length > 0) {
    write(dir, change);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'change');
  }
  return dir;
};

const fakeExec = (gh = {}) => (command, args, cwd) => {
  if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  const answer = gh[args[0]];
  if (answer === undefined) throw new Error('gh indisponível');
  return JSON.stringify(typeof answer === 'function' ? answer(cwd) : answer);
};

const review = (dir, options = {}, gh = {}) => runCodeReview({ target: dir, base: 'main', exec: fakeExec(gh), ...options });

test('aprova mudança limpa com teste', async (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG }, { 'src/a.ts': 'export const a = () => 1;\n', 'test/a.test.mjs': '1;\n' });
  const res = await review(dir);
  assert.equal(res.status, 'APPROVED');
  assert.match(readFileSync(res.reportPath, 'utf-8'), /Status\*\*: 🟢 Aprovado/);
});

test('reprova violação grave com arquivo e linha corretos', async (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG, 'src/a.ts': 'const a = 1;\nconst b = 2;\n' }, { 'src/a.ts': 'const a = 1;\nconst b = 2;\nfunction c() {}\n' });
  const res = await review(dir);
  assert.equal(res.status, 'NEEDS_CHANGES');
  assert.equal(res.divergences[0].line, 3);
});

test('diff vazio, base inexistente e config inválida são inconclusivos', async (t) => {
  assert.equal((await review(setup(t, {}))).status, 'INCONCLUSIVE');
  const dir = setup(t, {}, { 'a.ts': '1;\n' });
  assert.equal((await review(dir, { base: 'nao-existe' })).status, 'INCONCLUSIVE');
  assert.equal((await review(setup(t, { 'agent.config.json': '{' }, { 'a.ts': '1;\n' }))).status, 'INCONCLUSIVE');
});

test('a entrega não afrouxa as regras que a avaliam', async (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG }, { 'agent.config.json': '{"rules":{}}', 'src/a.ts': 'function x() {}\n' });
  assert.equal((await review(dir)).status, 'NEEDS_CHANGES');
});

test('renomear arquivo antigo não acusa linhas que não mudaram', async (t) => {
  const body = `function velho() {}\n${'const x = 1;\n'.repeat(30)}`;
  const dir = setup(t, { 'agent.config.json': CONFIG, 'src/a.ts': body });
  git(dir, 'mv', 'src/a.ts', 'src/b com espaço.ts');
  git(dir, 'commit', '-qm', 'mv');
  const res = await review(dir);
  assert.equal(res.divergences.filter((d) => d.ruleId === 'arrow-functions-only').length, 0);
});

test('requisito nunca é aprovado sozinho e issue ilegível é inconclusiva', async (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG }, { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.mjs': '1;\n' });
  const res = await review(dir, { task: '5' }, { issue: { title: 'T', body: '- [ ] fazer `a`' } });
  assert.equal(res.status, 'NEEDS_CONFIRMATION');
  assert.equal(res.requirements[0].status, 'evidence');
  assert.equal((await review(dir, { task: '5' })).status, 'INCONCLUSIVE');
});

test('CI: falha reprova, execução pendente não aprova, outro commit não conta', async (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG }, { 'src/a.ts': 'export const a = 1;\n', 'test/a.test.mjs': '1;\n' });
  const headRefOid = git(dir, 'rev-parse', 'HEAD').trim();
  const pr = (check, oid = headRefOid) => ({ pr: { number: 1, url: 'u', state: 'OPEN', headRefOid: oid, statusCheckRollup: [check] } });
  assert.equal((await review(dir, {}, pr({ name: 'x', conclusion: 'FAILURE' }))).status, 'NEEDS_CHANGES');
  assert.equal((await review(dir, {}, pr({ context: 'x', state: 'PENDING' }))).status, 'NEEDS_CONFIRMATION');
  assert.equal((await review(dir, {}, pr({ name: 'x', conclusion: 'SUCCESS' }))).status, 'APPROVED');
  assert.equal((await review(dir, {}, pr({ name: 'x', conclusion: 'SUCCESS' }, 'outro'))).status, 'NEEDS_CONFIRMATION');
});

test('CLI: código de saída e JSON', (t) => {
  const dir = setup(t, { 'agent.config.json': CONFIG }, { 'src/a.ts': 'function x() {}\n' });
  const cli = (...args) => spawnSync(process.execPath, [CLI, 'review', '--target', dir, '--json', ...args], { encoding: 'utf-8' });
  const bad = cli('--base', 'main', '--head', 'HEAD');
  assert.equal(bad.status, 1, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).status, 'NEEDS_CHANGES');
  assert.equal(cli('--base', 'nada').status, 2);
});

test('sync preserva documentação escrita à mão e recusa config inválida', (t) => {
  const dir = setup(t, { 'AGENTS.md': 'manual\n' });
  const skipped = [];
  const config = { rules: {}, docsSync: ['AGENTS.md', 'CLAUDE.md'] };
  assert.deepEqual(syncAgentDocs(dir, config, { onSkip: (d) => skipped.push(d) }), ['CLAUDE.md']);
  assert.deepEqual(skipped, ['AGENTS.md']);
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf-8'), 'manual\n');
  assert.deepEqual(syncAgentDocs(dir, config), ['CLAUDE.md']);
  assert.equal(syncAgentDocs(dir, config, { force: true }).length, 2);
  write(dir, { 'agent.config.json': '{' });
  assert.throws(() => syncAgentDocs(dir), /inválido/);
  assert.ok(existsSync(join(dir, 'CLAUDE.md')));
});
