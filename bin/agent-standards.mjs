#!/usr/bin/env node

/**
 * Universal Agent Standards CLI
 * 
 * Comandos:
 *   agent-standards init       Auto-descobre padrões do repositório, gera agent.config.json e compila docs
 *   agent-standards discover   Apenas analisa e exibe o perfil detectado do repositório
 *   agent-standards sync       Recompila AGENTS.md, CLAUDE.md, .cursorrules a partir de agent.config.json
 *   agent-standards review     Executa o Code Review (Spec, Standards, UX e CI)
 *   agent-standards ux-audit   Audita a UI renderizada (rotas × temas × viewports) via navegador remoto
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { discoverRepoStandards, writeConfigFile } from '../src/discover.mjs';
import { statusLabel } from '../src/review/report.mjs';
import { runCodeReview } from '../src/review.mjs';
import { syncAgentDocs } from '../src/sync.mjs';
import { applyProfile, ConfigError, loadProfile, parseConfig } from '../src/review/config.mjs';
import { runUxAudit, UxAuditError } from '../src/ux/audit.mjs';
import { resolveAuditConfig, UxConfigError } from '../src/ux/config.mjs';
import { discoverPreviewForHead } from '../src/ux/discover.mjs';

const printHelp = () => {
  console.log(`
🛡️  Universal Agent Standards Engine (@apenasgabs/agent-standards)

Uso:
  agent-standards <comando> [opções]

Comandos:
  init        Inspeciona o repositório atual, cria agent.config.json e compila os arquivos de agentes
  discover    Analisa o repositório e exibe o perfil técnico identificado
  sync        Sincroniza AGENTS.md, CLAUDE.md, .cursorrules e copilot-instructions
  review      Executa auditoria de Spec, Standards e UX no diff da branch atual
  ux-audit    Renderiza a UI (rotas × temas × viewports) e mede overflow, contraste, alvos de toque e erros

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
  --profile <p>   Perfil global (nome em profiles/ ou caminho; padrão: AGENT_STANDARDS_PROFILE)
  --ux-audit auto Roda o ux-audit quando a UI mudou e não há auditoria deste commit
  --ux-routes a,b Rotas usadas pelo ux-audit automático

Opções para 'ux-audit' (padrões vêm da seção "ux" do agent.config.json):
  --url <url>       URL base do app (padrão: ux.baseUrl ou o preview publicado para o HEAD)
  --profile <p>     Perfil global (padrão: AGENT_STANDARDS_PROFILE)
  --routes <a,b>    Rotas a auditar (ex.: /list,/stock)
  --themes <a,b>    Restringe aos temas informados
  --config <path>   Arquivo JSON alternativo com a seção "ux"
  --out <dir>       Pasta de saída (padrão: .ux-review)
  --local           Usa Chromium local em vez de BROWSERLESS_HOST/BROWSERLESS_TOKEN
  --json            Imprime o resultado em JSON
  Códigos de saída: 0 sem bloqueio, 1 achado grave, 2 erro de configuração/conexão

Exemplos:
  npx @apenasgabs/agent-standards init
  npx @apenasgabs/agent-standards sync
  npx @apenasgabs/agent-standards review --base origin/main
  BROWSERLESS_HOST=host:9222 BROWSERLESS_TOKEN=*** npx @apenasgabs/agent-standards ux-audit --url http://host:5173
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
    const names = ['base', 'head', 'task', 'target', 'output', 'profile', 'ux-audit', 'ux-routes'];
    const { values } = parseArgs({
      args: args.slice(1),
      options: { ...Object.fromEntries(names.map((n) => [n, { type: 'string' }])), json: { type: 'boolean' } },
    });
    const { json, 'ux-audit': uxAudit, 'ux-routes': uxRoutes, ...reviewOpts } = values;
    if (uxAudit && !['auto', 'off'].includes(uxAudit)) {
      console.error('❌ --ux-audit aceita "auto" ou "off".');
      process.exitCode = 2;
      return;
    }
    if (uxAudit) reviewOpts.uxAudit = uxAudit;
    if (uxRoutes) reviewOpts.uxRoutes = uxRoutes.split(',').map((r) => r.trim()).filter(Boolean);
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

  if (command === 'ux-audit') {
    const names = ['url', 'routes', 'themes', 'config', 'out', 'target', 'profile'];
    const { values } = parseArgs({
      args: args.slice(1),
      options: { ...Object.fromEntries(names.map((n) => [n, { type: 'string' }])), local: { type: 'boolean' }, json: { type: 'boolean' } },
    });
    const target = resolve(values.target ?? cwd);
    const split = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
    try {
      const configPath = resolve(target, values.config ?? 'agent.config.json');
      const own = existsSync(configPath) ? parseConfig(readFileSync(configPath, 'utf-8')) : { rules: {}, overrides: [], ux: null, source: 'sem config' };
      const profile = loadProfile(values.profile ?? process.env.AGENT_STANDARDS_PROFILE, target);
      const section = applyProfile(own, profile).ux;
      let url = values.url;
      if (!url && (!section?.baseUrl || section.baseUrl === 'auto')) {
        try {
          url = discoverPreviewForHead(target)?.url;
        } catch (err) {
          console.warn(`⚠️  Não foi possível consultar o preview do commit: ${String(err.message).split('\n')[0]}`);
        }
      }
      const config = resolveAuditConfig(section, { url, routes: split(values.routes), themes: split(values.themes), out: values.out });
      if (!values.json) console.log(`🎨 [agent-standards] Auditando ${config.routes.length} rota(s) × ${config.themes.length} tema(s) × ${config.viewports.length} viewport(s) em ${config.baseUrl}...`);
      const res = await runUxAudit({ target, config, local: values.local });
      if (values.json) console.log(JSON.stringify(res, null, 2));
      else {
        console.log(`\n🏁 ${res.summary.combinations} combinação(ões): 🔴 ${res.summary.hard} grave(s) · 🟡 ${res.summary.medium} ressalva(s)`);
        console.log(`📄 Relatório: ${res.markdownPath}`);
      }
      if (res.summary.hard > 0) process.exitCode = 1;
    } catch (err) {
      if (!(err instanceof UxConfigError || err instanceof UxAuditError || err instanceof ConfigError)) throw err;
      console.error(`❌ ${err.message}`);
      process.exitCode = 2;
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
