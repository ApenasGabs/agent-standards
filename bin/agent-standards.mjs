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
import { discoverRepoStandards, writeConfigFile } from '../src/discover.mjs';
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

Opções para 'review':
  --base <ref>    Branch base para comparação (padrão: origin/main)
  --output <path> Arquivo de saída para o relatório (padrão: REVIEW_REPORT.md)
  --patch <path>  Arquivo para o patch unificado (padrão: review-fixes.patch)
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

  if (command === 'discover') {
    console.log(`🔍 [agent-standards] Analisando repositório em: ${cwd}...`);
    const { findings, generatedConfig } = discoverRepoStandards(cwd);
    console.log(`\n📊 Perfil Técnico Identificado:`);
    console.log(`   • Framework:   ${findings.framework}`);
    console.log(`   • UI Library:  ${findings.ui}`);
    console.log(`   • Test Runner: ${findings.test}`);
    console.log(`   • É Scraper?:  ${findings.isScraper ? 'Sim' : 'Não'}`);
    console.log(`   • Estilo Fn:   ${findings.predominantFunctionStyle === 'arrow' ? 'Arrow Functions (Predominante)' : 'Funções Tradicionais'}`);
    console.log(`   • Tipagem:     ${findings.strictTypes ? 'Estrita (Strict)' : 'Flexível'}`);
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
    const files = syncAgentDocs(cwd, generatedConfig);
    console.log(`✨ Arquivos sincronizados com sucesso:`);
    files.forEach((f) => console.log(`   • ${f}`));
    console.log(`\n🎉 Pronto! Todos os seus agentes (AGY, Claude, Cursor, Copilot) agora compartilham as mesmas regras.`);
    return;
  }

  if (command === 'sync') {
    console.log(`🔄 [agent-standards] Sincronizando documentações de agentes a partir de agent.config.json...`);
    const files = syncAgentDocs(cwd);
    console.log(`✨ Documentações atualizadas:`);
    files.forEach((f) => console.log(`   • ${f}`));
    return;
  }

  if (command === 'review') {
    console.log(`🛡️  [agent-standards] Iniciando Code Review...`);
    const reviewOpts = { target: cwd };
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--base' && args[i + 1]) reviewOpts.base = args[++i];
      if (args[i] === '--target' && args[i + 1]) reviewOpts.target = args[++i];
      if (args[i] === '--output' && args[i + 1]) reviewOpts.output = args[++i];
      if (args[i] === '--patch' && args[i + 1]) reviewOpts.patch = args[++i];
    }

    const res = await runCodeReview(reviewOpts);
    console.log(`\n🏁 Resultado: ${res.status === 'APPROVED' ? '🟢 Aprovado' : '🔴 Requer Ajustes'}`);
    console.log(`📄 Relatório: ${res.reportPath}`);
    if (res.patchPath) {
      console.log(`🩹 Patch gerado: ${res.patchPath}`);
    }
    return;
  }

  console.error(`❌ Comando desconhecido: "${command}"\nExecute 'agent-standards --help' para ver os comandos.`);
  process.exit(1);
};

main().catch((err) => {
  console.error('❌ Erro inesperado:', err);
  process.exit(1);
});
