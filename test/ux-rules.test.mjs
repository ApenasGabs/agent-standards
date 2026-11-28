import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfig } from '../src/review/config.mjs';
import { checkFile, isUiFile } from '../src/review/rules.mjs';

const UX = {
  'ux.blockImportant': true,
  'ux.blockHardcodedColors': true,
  'ux.blockSlopPatterns': true,
  'ux.blockEmojiInUi': true,
  'ux.requireAccessibleIconButton': true,
};

const check = (content, file = 'src/A.tsx', rules = UX) =>
  checkFile({ file, content, rules, source: 'agent.config.json', addedLines: new Set(content.split('\n').map((_, i) => i + 1)) });
const ids = (...args) => check(...args).map((d) => `${d.ruleId}:${d.line}`);

test('UX: achados saem no eixo UX e arquivos de teste são ignorados', () => {
  const found = check('<p className="border-l-4">x</p>');
  assert.equal(found[0].axis, 'UX');
  assert.deepEqual(ids('<p className="border-l-4">✨</p>', 'src/__tests__/A.test.tsx'), []);
  assert.equal(isUiFile('src/index.css'), true);
  assert.equal(isUiFile('src/api/client.ts'), false);
});

test('!important: acusa em CSS e JSX, ignora comentário; ui.noImportant é alias', () => {
  assert.deepEqual(ids('.a { color: var(--x) !important; }', 'src/a.css'), ['ux-no-important:1']);
  assert.deepEqual(ids('/* nunca use !important */\n.a { color: var(--x); }', 'src/a.css'), []);
  assert.deepEqual(ids('const s = { color: "red !important" };'), ['ux-no-important:1']);
  assert.deepEqual(ids('// !important só no comentário\nconst a = 1;'), []);
  assert.deepEqual(ids('.a { top: 0 ! important; }', 'src/a.css', { 'ui.noImportant': true }), ['ux-no-important:1']);
});

test('cores fixas: definir token é permitido, consumir valor cru não', () => {
  const css = [':root { --color-bg: #000000; --c: oklch(0.5 0.1 200); }', '#add { color: #fff; }', '.x { background: var(--color-bg); }'].join('\n');
  assert.deepEqual(ids(css, 'src/index.css'), ['ux-no-hardcoded-colors:2']);
  assert.deepEqual(ids('<p className="text-[#333] bg-base-100">x</p>'), ['ux-no-hardcoded-colors:1']);
  assert.deepEqual(ids('<h1 style={{ color: "#ff0000" }}>x</h1>'), ['ux-no-hardcoded-colors:1']);
  assert.deepEqual(ids('<svg fill="#fff" />\n<p className="text-primary">x</p>'), []);
});

test('anti-slop: cada padrão gera um achado com descrição própria, comentário não conta', () => {
  const found = check('// from-purple-500 só no comentário\n<div className="bg-gradient-to-r from-purple-500 to-pink-500 backdrop-blur-md shadow-2xl" />');
  assert.deepEqual(found.map((d) => d.line), [2, 2, 2]);
  assert.equal(new Set(found.map((d) => d.description)).size, 3);
  assert.deepEqual(ids('<p className="border-l-4 bg-clip-text">x</p>'), ['ux-anti-slop:1', 'ux-anti-slop:1']);
  assert.deepEqual(ids('<div className="from-emerald-500 shadow-md border-l" />'), []);
});

test('emoji: acusa em texto JSX e atributos de texto, ignora ©/® e strings de lógica', () => {
  assert.deepEqual(ids('<h1>Novo ✨</h1>'), ['ux-no-emoji-in-ui:1']);
  assert.deepEqual(ids('<input placeholder="Buscar 🔎" />'), ['ux-no-emoji-in-ui:1']);
  assert.deepEqual(ids('<footer>© 2026 Meu App®</footer>\nconst k = "🚀";'), []);
});

test('botão só com ícone: exige nome acessível, aceita texto, aria-label, sr-only e expressão', () => {
  assert.deepEqual(ids('<button onClick={go}><SettingOutlined /></button>'), ['ux-icon-button-name:1']);
  assert.deepEqual(ids('<IconButton icon={x} />'), ['ux-icon-button-name:1']);
  assert.deepEqual(
    ids(
      [
        '<button aria-label="Fechar"><X /></button>',
        '<button><Icon /><span className="sr-only">Abrir</span></button>',
        '<button>{label}</button>',
        '<button>Salvar</button>',
        '<button {...props}><X /></button>',
      ].join('\n')
    ),
    []
  );
});

test('regras UX só valem quando ativadas e respeitam overrides de caminho', () => {
  assert.deepEqual(ids('<p className="border-l-4">✨</p>', 'src/A.tsx', {}), []);
  const config = parseConfig(JSON.stringify({ rules: { ux: { blockHardcodedColors: true } }, overrides: [{ paths: ['src/styles/tokens.css'], rules: { ux: { blockHardcodedColors: false } } }] }));
  assert.deepEqual(config.unverified, []);
  assert.throws(() => parseConfig('{"rules":{"ux":{"blockSlopPatterns":"sim"}}}'), /aceita true ou false/);
  assert.throws(() => parseConfig('{"ux": []}'), /ux deve ser um objeto/);
});
