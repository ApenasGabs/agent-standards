import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { evaluateCIPipeline, runCodeReview } from '../src/review.mjs';
import { renderReport } from '../src/review/report.mjs';

test('ci-review: deve retornar configured: false quando não houver checks registrados', () => {
  const result = evaluateCIPipeline([]);
  assert.strictEqual(result.configured, false);
  assert.strictEqual(result.status, 'NO_CHECKS');
  assert.strictEqual(result.total, 0);
  assert.strictEqual(result.successful, 0);
});

test('ci-review: deve retornar SUCCESS quando todos os checks remotos passarem', () => {
  const checks = [
    {
      name: 'Build and Unit Tests',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'CI',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/1',
    },
    {
      name: 'E2E Playwright Suite',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'E2E',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/2',
    },
  ];

  const result = evaluateCIPipeline(checks);
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.status, 'SUCCESS');
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.successful, 2);
  assert.strictEqual(result.failed.length, 0);
});

test('ci-review: deve retornar FAILURE quando houver check reprovado na nuvem', () => {
  const checks = [
    {
      name: 'Lint & Typecheck',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'CI',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/1',
    },
    {
      name: 'Playwright E2E & Visual Regression',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      workflowName: 'E2E Visual Tests (Playwright CI Gate)',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/2',
    },
  ];

  const result = evaluateCIPipeline(checks);
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.status, 'FAILURE');
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.successful, 1);
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].name, 'Playwright E2E & Visual Regression');
});

test('ci-review: deve retornar IN_PROGRESS quando houver checks em execução sem falhas prévias', () => {
  const checks = [
    {
      name: 'Fast Validation',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'CI',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/1',
    },
    {
      name: 'Long Running Integration',
      status: 'IN_PROGRESS',
      conclusion: null,
      workflowName: 'Integration',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/2',
    },
  ];

  const result = evaluateCIPipeline(checks);
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.status, 'IN_PROGRESS');
  assert.strictEqual(result.inProgress.length, 1);
});

test('ci-review: deve retornar TIMED_OUT e listar checks quando houver tempo limite excedido', () => {
  const checks = [
    {
      name: 'Build and Unit Tests',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'CI',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/1',
    },
    {
      name: 'Playwright E2E Long Suite',
      status: 'COMPLETED',
      conclusion: 'TIMED_OUT',
      workflowName: 'E2E',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/timeout-1',
    },
  ];

  const result = evaluateCIPipeline(checks);
  assert.strictEqual(result.configured, true);
  assert.strictEqual(result.status, 'TIMED_OUT');
  assert.strictEqual(result.timedOut.length, 1);
  assert.strictEqual(result.timedOut[0].name, 'Playwright E2E Long Suite');
  assert.match(result.timedOut[0].detailsUrl, /timeout-1/);
});

test('ci-review: deve bloquear a aprovação geral do PR caso haja checks falhando na pipeline', () => {
  const failingChecks = [
    {
      name: 'Playwright E2E & Visual Regression',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      workflowName: 'E2E Visual Tests (Playwright CI Gate)',
      detailsUrl: 'https://github.com/org/repo/actions/runs/123/job/failed-1',
    },
  ];

  const result = evaluateCIPipeline(failingChecks);
  assert.strictEqual(result.status, 'FAILURE', 'Status geral deve ser FAILURE para bloquear aprovação');
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].name, 'Playwright E2E & Visual Regression');
  assert.match(result.failed[0].detailsUrl, /failed-1/, 'Relatório rico deve conter link para os que falharam');
});

test('ci-review: testes unitários cobrindo os cenários de CI no agent-standards (verde, falha e sem CI configurado)', () => {
  // Cenário 1: Repositório sem CI configurado
  const noCI = evaluateCIPipeline([]);
  assert.strictEqual(noCI.configured, false);
  assert.strictEqual(noCI.status, 'NO_CHECKS');

  // Cenário 2: Pipeline verde com sucesso
  const greenCI = evaluateCIPipeline([
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'http://ci/1' },
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'http://ci/2' },
  ]);
  assert.strictEqual(greenCI.status, 'SUCCESS');
  assert.strictEqual(greenCI.successful, 2);

  // Cenário 3: Pipeline com falha
  const failedCI = evaluateCIPipeline([
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'http://ci/fail' },
  ]);
  assert.strictEqual(failedCI.status, 'FAILURE');
});

const baseReport = (ci) => ({
  appName: 'app',
  status: ci.status === 'FAILURE' || ci.status === 'TIMED_OUT' ? 'NEEDS_CHANGES' : ci.status === 'IN_PROGRESS' || ci.status === 'OUTDATED' ? 'NEEDS_CONFIRMATION' : 'APPROVED',
  base: 'origin/main',
  head: 'HEAD',
  task: { title: 'Tarefa CI', source: 'Issue #4' },
  ruleSource: 'agent.config.json',
  requirements: [],
  divergences: [],
  unverified: [],
  problems: [],
  notes: [],
  ci,
  uxAudit: { state: 'disabled' },
});

test('ci-report: exibe Resumo Executivo, jobs aprovados, workflow e links para falhas', () => {
  const green = renderReport(
    baseReport({
      ...evaluateCIPipeline([
        { name: 'Unit Tests', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', detailsUrl: 'https://github.com/org/repo/actions/runs/1/job/1' },
        { name: 'Build', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', detailsUrl: 'https://github.com/org/repo/actions/runs/1/job/2' },
      ]),
      prNumber: 5,
      prUrl: 'https://github.com/org/repo/pull/5',
    })
  );
  assert.match(green, /\| \*\*Pipeline CI\/CD\*\* \| 🟢 Passing \| 2\/2 check\(s\) aprovado\(s\) no \[PR #5\]\(https:\/\/github\.com\/org\/repo\/pull\/5\) \|/);
  assert.match(green, /### Jobs aprovados/);
  assert.match(green, /✅ \*\*2 de 2\*\* job\(s\) aprovado\(s\)/);
  assert.match(green, /🟢 \*\*Unit Tests\*\* \(CI\) — \[Ver detalhes\]\(https:\/\/github\.com\/org\/repo\/actions\/runs\/1\/job\/1\)/);

  const failing = renderReport(
    baseReport({
      ...evaluateCIPipeline([
        { name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', detailsUrl: 'https://github.com/org/repo/actions/runs/2/job/1' },
        { name: 'E2E', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'Playwright Gate', detailsUrl: 'https://github.com/org/repo/actions/runs/2/job/2' },
      ]),
      prNumber: 5,
      prUrl: 'https://github.com/org/repo/pull/5',
    })
  );
  assert.match(failing, /\| \*\*Pipeline CI\/CD\*\* \| 🔴 Failing \| 1 check\(s\) falhando \(1\/2 aprovado\(s\)\) no \[PR #5\]\(https:\/\/github\.com\/org\/repo\/pull\/5\) \|/);
  assert.match(failing, /### Checks reprovados/);
  assert.match(failing, /🔴 \*\*E2E\*\* \(Playwright Gate\) — \[Ver detalhes\]\(https:\/\/github\.com\/org\/repo\/actions\/runs\/2\/job\/2\)/);
  assert.match(failing, /✅ \*\*1 de 2\*\* job\(s\) aprovado\(s\)/);

  const noChecks = renderReport(baseReport(evaluateCIPipeline([])));
  assert.match(noChecks, /\| \*\*Pipeline CI\/CD\*\* \| ⚪ Sem checks \| Nenhum check remoto registrado \|/);
});

test('ci-report: exibe checks em execução e status OUTDATED para outro commit', () => {
  const running = renderReport(
    baseReport({
      ...evaluateCIPipeline([
        { name: 'Deploy Preview', status: 'IN_PROGRESS', conclusion: null, workflowName: 'Vercel', detailsUrl: 'https://vercel.com/run/9' },
      ]),
      prNumber: 9,
      prUrl: 'https://github.com/org/repo/pull/9',
    })
  );
  assert.match(running, /🟡 In Progress/);
  assert.match(running, /### Checks em execução/);
  assert.match(running, /🟡 \*\*Deploy Preview\*\* \(Vercel\) — \[Ver detalhes\]\(https:\/\/vercel\.com\/run\/9\)/);

  const outdated = renderReport(
    baseReport({
      configured: true,
      status: 'OUTDATED',
      total: 1,
      successful: 0,
      passed: [],
      failed: [],
      timedOut: [],
      inProgress: [],
      prNumber: 9,
      prUrl: 'https://github.com/org/repo/pull/9',
      outdatedSha: 'abcdef123456',
    })
  );
  assert.match(outdated, /🟡 Outdated/);
  assert.match(outdated, /outro commit \(`abcdef1`\)/);
});

test('ci-review: runCodeReview em detached HEAD não passa HEAD para gh pr view e grava relatório rico', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-detached-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf-8', stdio: 'pipe' });
  const write = (files) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
  };
  git('init', '-q', '-b', 'main');
  write({ 'agent.config.json': JSON.stringify({ rules: { functions: 'arrow-only' } }) });
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  write({ 'src/a.ts': 'export const ok = () => 1;\n', 'test/a.test.mjs': '1;\n' });
  git('add', '.');
  git('commit', '-qm', 'change');
  const headSha = git('rev-parse', 'HEAD').trim();
  git('checkout', '--detach', 'HEAD');

  const ghCalls = [];
  const exec = (command, args, cwd) => {
    if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    ghCalls.push(args);
    return JSON.stringify({
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
      state: 'OPEN',
      headRefOid: headSha,
      statusCheckRollup: [
        { name: 'Unit', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI', detailsUrl: 'https://ci/1' },
        { name: 'E2E', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'E2E Gate', detailsUrl: 'https://ci/2' },
      ],
    });
  };

  const res = await runCodeReview({ target: dir, base: 'main', exec });
  assert.strictEqual(res.status, 'NEEDS_CHANGES');
  assert.ok(ghCalls.some((a) => a[0] === 'pr' && a[1] === 'view' && !a.includes('HEAD')));
  const report = readFileSync(res.reportPath, 'utf-8');
  assert.match(report, /\*\*E2E\*\* \(E2E Gate\) — \[Ver detalhes\]\(https:\/\/ci\/2\)/);
  assert.match(report, /✅ \*\*1 de 2\*\* job\(s\) aprovado\(s\)/);
});
