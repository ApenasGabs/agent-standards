import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Compila a configuração de padrões em artefatos para múltiplos agentes
 * Suporta TypeScript, Java e Go.
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
    config = {
      preset: 'minimal',
      language: 'unknown',
      rules: {
        security: { blockHardcodedSecrets: true },
        cleanCode: { blockConsoleLog: true, blockEmptyCatch: true },
      },
      docsSync: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules'],
    };
  }

  const generatedFiles = [];
  const rules = config.rules || {};
  const lang = config.language || 'typescript/javascript';

  const buildMarkdownRules = (agentName) => {
    let md = `# Diretrizes de Engenharia e Padrões de Código (${agentName})\n\n`;
    md += `> Gerado automaticamente por \`@apenasgabs/agent-standards\` a partir de \`agent.config.json\`.\n`;
    md += `> Preset Ativo: **${config.preset || 'custom'}** | Linguagem: **${lang.toUpperCase()}**\n\n`;

    // ==========================================
    // REGRAS PARA JAVA (SPRING BOOT)
    // ==========================================
    if (lang === 'java' || config.preset === 'java-spring') {
      md += `## 1. Arquitetura em Camadas (Spring Boot)\n`;
      md += `- ✅ **Camadas Rígidas**: Seguir o fluxo \`Controller\` ➔ \`Service\` ➔ \`Repository\` ➔ \`Model/Entity\`.\n`;
      md += `- ✅ **Controllers Enxutos**: Controllers não contêm regra de negócio nem queries; apenas recebem DTOs e retornam \`ResponseEntity\`.\n`;
      md += `- ✅ **Injeção de Dependências**: Preferir injeção via construtor (ou Lombok \`@RequiredArgsConstructor\`) em vez de \`@Autowired\` direto em campos privados.\n\n`;

      md += `## 2. Validação & DTOs (Java 17+)\n`;
      md += `- ✅ Utilizar **Java Records** (\`public record CreateUserDTO(...)\`) para DTOs imutáveis de entrada/saída.\n`;
      md += `- ✅ **Bean Validation Obrigatório**: Anotar campos de DTO com \`@NotNull\`, \`@NotBlank\`, \`@Size\`, etc., e usar \`@Valid\` nos controllers.\n\n`;

      md += `## 3. Logs, Exceções e Higiene\n`;
      md += `- ❌ **PROIBIDO** o uso de \`System.out.println\` ou \`e.printStackTrace()\` em código de produção.\n`;
      md += `- ✅ Utilizar logging estruturado via SLF4J / Logback (\`@Slf4j\` ou \`LoggerFactory.getLogger\`).\n`;
      md += `- ✅ Retornos opcionais de repositório devem usar \`java.util.Optional.map(...).orElseThrow(...)\`.\n\n`;

      md += `## 4. Testes Automatizados\n`;
      md += `- ✅ Testes unitários e de integração com **JUnit 5** (\`@Test\`, \`@SpringBootTest\`, Mockito).\n`;
      return md;
    }

    // ==========================================
    // REGRAS PARA GO
    // ==========================================
    if (lang === 'go' || config.preset === 'go-service') {
      md += `## 1. Tratamento Idiomático de Erros (Go Rules)\n`;
      md += `- ❌ **NUNCA** ignore erros retornados (evitar \`_ = fn()\`).\n`;
      md += `- ✅ Sempre verificar \`if err != nil\` imediatamente após a chamada.\n`;
      md += `- ✅ Envelopar erros com contexto usando \`fmt.Errorf("falha ao executar X: %w", err)\` para permitir \`errors.Is\` e \`errors.As\`.\n`;
      md += `- ❌ **PROIBIDO** o uso de \`panic()\` em lógica de negócio ou APIs.\n\n`;

      md += `## 2. Contexto e Ciclo de Vida\n`;
      md += `- ✅ Toda função de rede, banco, I/O ou goroutine longa DEVE aceitar \`ctx context.Context\` como primeiro parâmetro.\n`;
      md += `- ✅ Respeitar cancelamento de contexto e suportar graceful shutdown com \`signal.NotifyContext\`.\n\n`;

      md += `## 3. Concorrência Segura\n`;
      md += `- ✅ Goroutines disparadas devem ser coordenadas com \`sync.WaitGroup\` ou canais.\n`;
      md += `- ✅ Evitar vazamento de goroutines (*goroutine leak*); sempre garantir canal de saída ou cancelamento.\n\n`;

      md += `## 4. Logging & Padrões de Nomenclatura\n`;
      md += `- ❌ Proibido \`fmt.Println()\` como log de produção. Utilizar logger estruturado (\`logrus\` ou \`slog\`).\n`;
      md += `- ✅ Identificadores exportados em PascalCase; identificadores internos do pacote em camelCase.\n`;
      return md;
    }

    // ==========================================
    // REGRAS PARA TYPESCRIPT / JAVASCRIPT
    // ==========================================
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
