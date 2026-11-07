import assert from 'node:assert';
import test from 'node:test';
import { evaluateCIPipeline } from '../src/review.mjs';

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
