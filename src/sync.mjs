import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Compila a configuração de padrões em artefatos para múltiplos agentes
 */
export const syncAgentDocs = (targetDir, customConfig = null) => {
  let config = customConfig;
  const configPath = join(targetDir, 'agent.config.json');

  if (!config && existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // fallback
    }
  }

  if (!config) {
    // Carregar preset mínimo
    config = {
      preset: 'minimal',
      rules: {
        functions: 'arrow-only',
        typescript: { noExplicitAny: true },
        security: { blockHardcodedSecrets: true },
        cleanCode: { blockConsoleLog: true, blockEmptyCatch: true },
      },
      docsSync: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules'],
    };
  }

  const generatedFiles = [];
  const rules = config.rules || {};

  // Gerar conteúdo comum
  const buildMarkdownRules = (agentName) => {
    let md = `# Diretrizes de Engenharia e Padrões de Código (${agentName})\n\n`;
    md += `> Gerado automaticamente por \`@apenasgabs/agent-standards\` a partir de \`agent.config.json\`.\n\n`;

    md += `## 1. Padrões de Funções e Sintaxe\n`;
    if (rules.functions === 'arrow-only') {
      md += `- ❌ **NUNCA** usar \`function\` tradicional em arquivos de lógica/componentes.\n`;
      md += `- ✅ **SEMPRE** utilizar arrow functions (\`const fn = () => {}\`).\n\n`;
    } else {
      md += `- ✅ Utilize funções consistentes com o estilo do repositório.\n\n`;
    }

    md += `## 2. Tipagem TypeScript\n`;
    if (rules.typescript?.noExplicitAny) {
      md += `- ❌ **PROIBIDO** o uso de \`any\` em qualquer circunstância.\n`;
      md += `- ✅ Tipar explicitamente parâmetros e retornos; usar \`unknown\` para valores indeterminados.\n`;
    }
    if (rules.typescript?.preferInterfaces) {
      md += `- ✅ Preferir \`interface\` para objetos e contratos de dados complexos.\n`;
    }
    md += `\n`;

    if (rules.ui?.preferred) {
      md += `## 3. Componentes e Estilo de UI\n`;
      md += `- ✅ Biblioteca padrão de componentes: **${rules.ui.preferred}**.\n`;
      if (rules.ui.requireDataTestId) {
        md += `- ✅ **OBRIGATÓRIO**: Todos os botões, campos de entrada e seletores interativos devem conter \`data-testid\`.\n`;
      }
      md += `\n`;
    }

    if (rules.scraping) {
      md += `## 3. Padrões de Web Scraping (SimpleCrawl)\n`;
      if (rules.scraping.strategy === 'http-first-browser-fallback') {
        md += `- ✅ Estratégia de extração: **HTTP-first, browser-fallback** (Cheerio para SSR; Playwright apenas para CSR/anti-bot).\n`;
      }
      if (rules.scraping.modularBaseScraper) {
        md += `- ✅ Padrão modular: Separar seletores (\`selectors.ts\`), mapeadores (\`mapper.ts\`) e contratos de dados (\`types.ts\`).\n`;
      }
      md += `\n`;
    }

    md += `## 4. Segurança e Higiene de Código\n`;
    if (rules.security?.blockInnerHTML) {
      md += `- ❌ **XSS Proibido**: Nunca utilizar \`innerHTML\` sem sanitização.\n`;
    }
    if (rules.security?.blockHardcodedSecrets) {
      md += `- ❌ **Credenciais Proibidas**: Nunca commitar API keys, senhas ou tokens hardcoded.\n`;
    }
    if (rules.cleanCode?.blockConsoleLog) {
      md += `- ❌ Remover \`console.log\` e chamadas de depuração residuais antes de finalizar.\n`;
    }
    if (rules.cleanCode?.blockEmptyCatch) {
      md += `- ❌ Proibido blocos \`catch\` vazios sem tratamento ou logging estruturado.\n`;
    }
    md += `\n`;

    md += `## 5. Fluxo de Trabalho e Code Review\n`;
    md += `- Toda entrega deve atender estritamente aos requisitos da tarefa/issue e aos padrões deste documento.\n`;
    md += `- Para auditar a conformidade deste repositório, execute: \`npx @apenasgabs/agent-standards review\`.\n`;

    return md;
  };

  const targets = config.docsSync || ['AGENTS.md', 'CLAUDE.md'];

  for (const doc of targets) {
    const fullPath = join(targetDir, doc);
    mkdirSync(dirname(fullPath), { recursive: true });

    let content = '';
    if (doc === '.cursorrules') {
      content = buildMarkdownRules('Cursor IDE');
    } else if (doc === 'CLAUDE.md') {
      content = buildMarkdownRules('Claude Code');
    } else if (doc === 'AGENTS.md') {
      content = buildMarkdownRules('Antigravity / Codex');
    } else if (doc.includes('copilot-instructions.md')) {
      content = buildMarkdownRules('GitHub Copilot');
    } else {
      content = buildMarkdownRules('Universal Agent');
    }

    writeFileSync(fullPath, content, 'utf-8');
    generatedFiles.push(doc);
  }

  return generatedFiles;
};
