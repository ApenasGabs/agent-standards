#!/usr/bin/env node

/**
 * Universal Agent Standards CLI
 * 
 * Comandos:
 *   agent-standards init       Auto-descobre padrões do repositório, gera agent.config.json e compila docs
 *   agent-standards discover   Apenas analisa e exibe o perfil detectado do repositório
 *   agent-standards sync       Recompila AGENTS.md, CLAUDE.md, .cursorrules a partir de agent.config.json
 *   agent-standards review     Executa o Code Review de dois eixos (Spec & Standards)
 */

import process from 'node:process';
import { parseArgs } from 'node:util';
import { discoverRepoStandards, writeConfigFile } from '../src/discover.mjs';
import { statusLabel } from '../src/review/report.mjs';
import { runCodeReview } from '../src/review.mjs';
import { syncAgentDocs } from '../src/sync.mjs';

const printHelp = () => {
  console.log(`
🛡️  Universal Agent Standards Engine (@apenasgabs/agent-standards)

Uso:
  agent-standards <comando> [opções]

Comandos:
  init        Inspeciona o repositório atual, cria agent.config.json e compila os arquivos de agentes
  discover    Analisa o repositório e exibe o perfil técnico identificado
  sync        Sincroniza AGENTS.md, CLAUDE.md, .cursorrules e copilot-instructions
  review      Executa auditoria de Spec & Standards no diff da branch atual

Códigos de saída de 'review': 0 sem bloqueio, 1 reprovado, 2 inconclusivo

Opções para 'sync' e 'init':
  --force         Substitui também documentação escrita à mão

Opções para 'review':
  --base <ref>    Branch base para comparação (padrão: origin/main)
  --output <path> Arquivo de saída para o relatório (padrão: REVIEW_REPORT.md)
  --head <ref>    Commit avaliado (padrão: HEAD)
  --task <id>     Número da issue (padrão: deduzido da branch)
  --json          Imprime o resultado em JSON
  --target <dir>  Diretório alvo a ser inspecionado (padrão: diretório atual)

Exemplos:
  npx @apenasgabs/agent-standards init
  npx @apenasgabs/agent-standards sync
  npx @apenasgabs/agent-standards review --base origin/main
`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const command = args[0] || '--help';

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const syncOptions = {
    force: args.includes('--force'),
    onSkip: (doc) => console.warn(`⏭️  ${doc} mantido: foi escrito à mão (use --force para substituir).`),
  };

  if (command === 'discover') {
    console.log(`🔍 [agent-standards] Analisando repositório em: ${cwd}...`);
    const { findings, generatedConfig } = discoverRepoStandards(cwd);
    console.log(`\n📊 Perfil Técnico Identificado:`);
    console.log(`   • Linguagem:    ${findings.language.toUpperCase()}`);
    console.log(`   • Build Tool:   ${findings.buildTool}`);
    console.log(`   • Framework:    ${findings.framework}`);
    console.log(`   • Arquitetura:  ${findings.architecture}`);
    console.log(`   • Test Runner:  ${findings.test}`);
    if (findings.details && Object.keys(findings.details).length > 0) {
      console.log(`   • Características Idiomáticas Detectadas:`);
      for (const [k, v] of Object.entries(findings.details)) {
        console.log(`     - ${k}: ${v}`);
      }
    }
    console.log(`\n💡 Preset Recomendado: "${generatedConfig.preset}"`);
    return;
  }

  if (command === 'init') {
    console.log(`🚀 [agent-standards] Inicializando padrões de agentes em: ${cwd}...`);
    const { findings, generatedConfig } = discoverRepoStandards(cwd);
    console.log(`✅ Padrões detectados: Preset "${generatedConfig.preset}"`);

    const configPath = writeConfigFile(cwd, generatedConfig);
    console.log(`📄 Configuração salva em: ${configPath}`);

    console.log(`🔄 Compilando arquivos nativos de agentes...`);
    const files = syncAgentDocs(cwd, generatedConfig, syncOptions);
    console.log(`✨ Arquivos sincronizados com sucesso:`);
    files.forEach((f) => console.log(`   • ${f}`));
    console.log(`\n🎉 Pronto! Todos os seus agentes (AGY, Claude, Cursor, Copilot) agora compartilham as mesmas regras.`);
    return;
  }

  if (command === 'sync') {
    console.log(`🔄 [agent-standards] Sincronizando documentações de agentes a partir de agent.config.json...`);
    const files = syncAgentDocs(cwd, null, syncOptions);
    console.log(`✨ Documentações atualizadas:`);
    files.forEach((f) => console.log(`   • ${f}`));
    return;
  }

  if (command === 'review') {
    const names = ['base', 'head', 'task', 'target', 'output'];
    const { values } = parseArgs({
      args: args.slice(1),
      options: { ...Object.fromEntries(names.map((n) => [n, { type: 'string' }])), json: { type: 'boolean' } },
    });
    const { json, ...reviewOpts } = values;
    if (!json) console.log(`🛡️  [agent-standards] Iniciando Code Review...`);
    const res = await runCodeReview({ target: cwd, ...reviewOpts });
    if (json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`\n🏁 Resultado: ${statusLabel(res.status)}`);
      console.log(`📄 Relatório: ${res.reportPath}`);
    }
    if (res.status === 'NEEDS_CHANGES') process.exitCode = 1;
    if (res.status === 'INCONCLUSIVE') process.exitCode = 2;
    return;
  }

  console.error(`❌ Comando desconhecido: "${command}"\nExecute 'agent-standards --help' para ver os comandos.`);
  process.exit(1);
};

main().catch((err) => {
  console.error('❌ Erro inesperado:', err);
  process.exit(1);
});
