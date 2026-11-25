import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigError, globToRegExp, parseConfig, rulesForFile } from '../src/review/config.mjs';
import { parseAddedLines } from '../src/review/diff.mjs';
import { maskSource } from '../src/review/mask.mjs';
import { checkFile } from '../src/review/rules.mjs';
import { extractRequirements, matchRequirements } from '../src/review/spec.mjs';

const ALL = {
  functions: 'arrow-only',
  'typescript.noExplicitAny': true,
  'ui.requireDataTestId': true,
  'security.blockInnerHTML': true,
  'security.blockHardcodedSecrets': true,
  'cleanCode.blockConsoleLog': true,
  'cleanCode.blockEmptyCatch': true,
};

const check = (content, file = 'src/a.ts', rules = ALL) =>
  checkFile({
    file,
    content,
    rules,
    source: 'agent.config.json',
    addedLines: new Set(content.split('\n').map((_, i) => i + 1)),
  });
const ids = (...args) => check(...args).map((d) => `${d.ruleId}:${d.line}`);

test('functions: acusa function em qualquer extensão JS/TS e ignora generators e declare', () => {
  for (const f of ['src/a.ts', 'src/a.mjs', 'src/a.cjs', 'src/a.jsx']) assert.deepEqual(ids('\nfunction x() {}', f), ['arrow-functions-only:2']);
  assert.deepEqual(ids('export default async function () {}'), ['arrow-functions-only:1']);
  assert.deepEqual(ids('declare function x(): void;\nfunction* g() {}\nconst a = { function: 1 };'), []);
});

test('noExplicitAny: acusa as formas usuais e ignora nomes parecidos', () => {
  assert.deepEqual(ids('const a: any = 1;\nconst b = x as any;\nconst c: Array<any> = [];\nconst d: Map<string, any> = m;\nconst e: string | any = 1;').length, 5);
  assert.deepEqual(ids('const a: anyThing = 1;\nconst company = many;\n// tipo: any\nconst s = "x: any;";'), []);
  assert.deepEqual(ids('const a: any = 1;', 'src/a.js'), []);
});

test('innerHTML: acusa atribuição e API do React, não leitura', () => {
  assert.deepEqual(ids('el.innerHTML = x;\nel.innerHTML += x;\nel.insertAdjacentHTML("a", x);').length, 3);
  assert.deepEqual(ids('<div dangerouslySetInnerHTML={{ __html: x }} />', 'src/a.tsx'), ['no-inner-html:1']);
  assert.deepEqual(ids('if (el.innerHTML === x) go(el.innerHTML);'), []);
});

test('data-testid: lê tags de várias linhas, arrow em atributo, spread e hidden', () => {
  assert.deepEqual(ids('<button\n  onClick={() => a > b}\n  data-testid="x"\n>', 'src/a.tsx'), []);
  assert.deepEqual(ids('<button\n  onClick={() => go()}\n>', 'src/a.tsx'), ['require-data-testid:1']);
  assert.deepEqual(ids('<input {...props} />\n<input type="hidden" />', 'src/a.tsx'), []);
  assert.deepEqual(ids('<button>', 'src/__tests__/a.test.tsx'), []);
});

test('segredos: acusa e nunca expõe o valor', () => {
  const secret = `ghp_${'a1B2'.repeat(9)}`;
  const found = check(`const t = '${secret}';`);
  assert.equal(found[0].ruleId, 'no-hardcoded-secrets');
  assert.ok(!JSON.stringify(found).includes(secret));
  assert.deepEqual(ids(`const apiKey = 'q8Zk2Lm9Xv4Tn7Rb1Wc6';`), ['no-hardcoded-secrets:1']);
  assert.deepEqual(ids(`const token = process.env.TOKEN;\nconst token2 = 'your_token_placeholder_1';`), []);
});

test('console e catch vazio', () => {
  assert.deepEqual(ids('console.log(1);\nconsole.error(2);'), ['no-console-log:1']);
  assert.deepEqual(ids('console.log(1);', 'test/a.test.mjs'), []);
  assert.deepEqual(ids('try { a(); } catch (e) {\n}\ntry { b(); } catch {}\np.catch(() => {});').length, 3);
  assert.deepEqual(ids('try { a(); } catch {\n  // recurso opcional\n}'), []);
});

test('comentários, strings, regex, templates e texto JSX não geram falso positivo', () => {
  assert.deepEqual(ids('// function x() {}\n/* console.log(1) */\nconst s = "function y() {}";\nconst r = /console.log(1)/;\nconst t = `function z() {} ${1}`;'), []);
  assert.deepEqual(ids('const t = `a ${console.log(1)} b`;'), ['no-console-log:1']);
  assert.deepEqual(ids("<p>Don't</p>;\nconsole.log(1);", 'src/a.tsx'), ['no-console-log:2']);
  assert.equal(maskSource('a "b" `c${d}`\n// e').length, 'a "b" `c${d}`\n// e'.length);
});

test('só linhas adicionadas são avaliadas', () => {
  const content = 'console.log(1);\nconsole.log(2);';
  const found = checkFile({ file: 'src/a.ts', content, rules: ALL, source: 'x', addedLines: new Set([2]) });
  assert.deepEqual(found.map((d) => d.line), [2]);
});

test('diff: número de linha exato, inclusive com conteúdo parecido com cabeçalho', () => {
  const diff = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +5,2 @@\n+++ contador\n+b\n@@ -9 +12 @@\n--- velho\n+c\n';
  const file = parseAddedLines(diff).get('x.ts');
  assert.deepEqual([...file.lines], [5, 6, 12]);
  assert.deepEqual(file.text, ['++ contador', 'b', 'c']);
});

test('config: overrides por caminho e regras não verificadas', () => {
  const config = parseConfig(
    JSON.stringify({
      rules: { functions: 'arrow-only', ui: { preferred: 'daisyui' }, cleanCode: { blockConsoleLog: true } },
      overrides: [{ paths: ['src/**'], rules: { cleanCode: { blockConsoleLog: false } } }],
    })
  );
  assert.equal(rulesForFile(config, 'src/x/a.ts')['cleanCode.blockConsoleLog'], false);
  assert.equal(rulesForFile(config, 'frontend/src/a.ts')['cleanCode.blockConsoleLog'], true);
  assert.deepEqual(config.unverified, ['ui.preferred']);
  assert.ok(globToRegExp('a/*.ts').test('a/b.ts') && !globToRegExp('a/*.ts').test('a/b/c.ts'));
});

test('config inválida é recusada', () => {
  for (const bad of ['{', '[]', '{"rules":[]}', '{"rules":{"functions":"arrow"}}', '{"rules":{"typescript":true}}', '{"rules":{},"overrides":[{"rules":{}}]}']) {
    assert.throws(() => parseConfig(bad), ConfigError, bad);
  }
});

test('spec: usa os critérios e só aceita símbolos exatos em código', () => {
  const reqs = extractRequirements('## Contexto\n- solto\n## Critérios de aceitação\n- [ ] criar `runSync`\n- [ ] deve ser rápido e seguro\n```\n- [ ] exemplo\n```');
  assert.equal(reqs.length, 2);
  const files = new Map([
    ['README.md', { lines: new Set([1]), text: ['runSync rápido seguro deve'] }],
    ['src/a.ts', { lines: new Set([7, 8]), text: ['const runSyncAll = 1;', 'const runSync = () => 1;'] }],
  ]);
  assert.deepEqual(matchRequirements(reqs, files).map((r) => [r.status, r.evidence]), [
    ['evidence', ['src/a.ts:8']],
    ['unconfirmed', []],
  ]);
});
