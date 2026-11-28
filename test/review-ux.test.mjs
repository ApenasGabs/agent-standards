import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runCodeReview } from '../src/review.mjs';

const WITH_UX = JSON.stringify({ rules: { ux: { blockSlopPatterns: true } }, ux: { baseUrl: 'http://app' } });
const WITHOUT_UX = JSON.stringify({ rules: { ux: { blockSlopPatterns: true } } });

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8', stdio: 'pipe' });

const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
};

const setup = (t, base, change) => {
  const dir = mkdtempSync(join(tmpdir(), 'review-ux-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { 'README.md': 'x\n', ...base });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'feature');
  write(dir, change);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'change');
  return dir;
};

const exec = (command, args, cwd) => {
  if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
  throw new Error('gh indisponível');
};

const review = (dir) => runCodeReview({ target: dir, base: 'main', exec });
const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();

const auditReport = (dir, sha, findings) =>
  write(dir, {
    '.ux-review/ux-report.json': JSON.stringify({
      head: sha,
      matrix: [{ route: '/list', theme: 'dark', viewport: { width: 375, height: 812 }, screenshot: 'a.png', findings }],
      summary: { combinations: 1, hard: findings.filter((f) => f.severity === 'hard').length, medium: 0 },
    }),
  });

const UI_CHANGE = { 'src/Card.tsx': 'export const Card = () => <div className="p-4">x</div>;\n', 'src/__tests__/Card.test.tsx': '1;\n' };

test('mudança de UI sem auditoria renderizada não é aprovada', async (t) => {
  const dir = setup(t, { 'agent.config.json': WITH_UX }, UI_CHANGE);
  const res = await review(dir);
  assert.equal(res.status, 'NEEDS_CONFIRMATION');
  assert.equal(res.uxAudit.state, 'missing');
  const md = readFileSync(res.reportPath, 'utf-8');
  assert.match(md, /## Eixo UX/);
  assert.match(md, /agent-standards ux-audit/);
});

test('auditoria de outro commit não vale; a do mesmo commit é incorporada', async (t) => {
  const dir = setup(t, { 'agent.config.json': WITH_UX }, UI_CHANGE);
  auditReport(dir, 'commit-antigo', []);
  assert.equal((await review(dir)).uxAudit.state, 'outdated');

  auditReport(dir, head(dir), [{ ruleId: 'ux-horizontal-overflow', severity: 'hard', description: 'Overflow horizontal', selector: '[data-testid="tabela"]' }]);
  const res = await review(dir);
  assert.equal(res.status, 'NEEDS_CHANGES');
  const ux = res.divergences.find((d) => d.axis === 'UX');
  assert.equal(ux.ruleId, 'ux-horizontal-overflow');
  assert.match(ux.file, /render \/list · dark · 375×812/);
  assert.match(readFileSync(res.reportPath, 'utf-8'), /`render \/list · dark · 375×812` — \*\*ux-horizontal-overflow\*\*/);

  auditReport(dir, head(dir), []);
  assert.equal((await review(dir)).status, 'APPROVED');
});

test('regra estática de UX aparece no eixo UX, não no Standards', async (t) => {
  const dir = setup(t, { 'agent.config.json': WITHOUT_UX }, { ...UI_CHANGE, 'src/Card.tsx': 'export const Card = () => <div className="border-l-4">x</div>;\n' });
  const res = await review(dir);
  assert.equal(res.uxAudit.state, 'disabled');
  const md = readFileSync(res.reportPath, 'utf-8');
  const standards = md.slice(md.indexOf('## Eixo Standards'), md.indexOf('## Eixo UX'));
  assert.doesNotMatch(standards, /ux-anti-slop/);
  assert.match(md.slice(md.indexOf('## Eixo UX')), /ux-anti-slop/);
});

test('sem seção ux ou sem arquivo de UI, nada muda; a entrega não liga nem desliga o gate', async (t) => {
  const backend = setup(t, { 'agent.config.json': WITH_UX }, { 'src/api.ts': 'export const a = () => 1;\n', 'test/a.test.mjs': '1;\n' });
  const res = await review(backend);
  assert.equal(res.uxAudit.state, 'not-required');
  assert.equal(res.status, 'APPROVED');

  // Remover a seção ux na própria entrega não dispensa a auditoria: vale a config da base.
  const sneaky = setup(t, { 'agent.config.json': WITH_UX }, { ...UI_CHANGE, 'agent.config.json': WITHOUT_UX });
  assert.equal((await review(sneaky)).uxAudit.state, 'missing');
});
