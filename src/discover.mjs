import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inspeciona um diretório e gera a configuração recomendada de padrões para agentes
 * Suporta TypeScript/JavaScript, Java (Maven/Gradle) e Go (Go Modules).
 */
export const discoverRepoStandards = (targetDir) => {
  const findings = {
    language: 'unknown',
    framework: 'none',
    buildTool: 'none',
    ui: 'none',
    test: 'none',
    architecture: 'unknown',
    details: {},
  };

  // ==========================================
  // 1. Detecção de Repositórios JAVA
  // ==========================================
  const pomPath = join(targetDir, 'pom.xml');
  const gradlePath = join(targetDir, 'build.gradle');
  const gradleKtsPath = join(targetDir, 'build.gradle.kts');

  if (existsSync(pomPath) || existsSync(gradlePath) || existsSync(gradleKtsPath)) {
    findings.language = 'java';
    findings.buildTool = existsSync(pomPath) ? 'maven' : 'gradle';

    let buildContent = '';
    if (existsSync(pomPath)) buildContent = readFileSync(pomPath, 'utf-8');
    else if (existsSync(gradlePath)) buildContent = readFileSync(gradlePath, 'utf-8');
    else if (existsSync(gradleKtsPath)) buildContent = readFileSync(gradleKtsPath, 'utf-8');

    // Java Version
    const javaVerMatch = buildContent.match(/<java\.version>(\d+)<\/java\.version>/) ||
                         buildContent.match(/sourceCompatibility\s*=\s*['"]?(\d+)['"]?/);
    findings.details.javaVersion = javaVerMatch ? javaVerMatch[1] : '17';

    // Framework
    if (buildContent.includes('spring-boot')) {
      findings.framework = 'spring-boot';
      const bootVerMatch = buildContent.match(/<version>(3\.\d+\.\d+)<\/version>/);
      if (bootVerMatch) findings.details.springBootVersion = bootVerMatch[1];
    } else if (buildContent.includes('quarkus')) {
      findings.framework = 'quarkus';
    } else if (buildContent.includes('micronaut')) {
      findings.framework = 'micronaut';
    }

    // Persistência & Banco
    if (buildContent.includes('spring-boot-starter-data-jpa') || buildContent.includes('hibernate')) {
      findings.details.orm = 'spring-data-jpa';
    }
    if (buildContent.includes('mysql-connector')) findings.details.database = 'mysql';
    else if (buildContent.includes('postgresql')) findings.details.database = 'postgresql';
    else if (buildContent.includes('h2')) findings.details.database = 'h2';

    // Validação
    if (buildContent.includes('starter-validation') || buildContent.includes('jakarta.validation')) {
      findings.details.validation = 'jakarta-bean-validation';
    }

    // Testes
    if (buildContent.includes('junit-jupiter') || buildContent.includes('spring-boot-starter-test')) {
      findings.test = 'junit-5';
    }

    // Arquitetura em camadas através da varredura de pacotes Java
    const layersFound = [];
    const scanJavaDirs = (dir) => {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) {
            if (['controller', 'controllers'].includes(e.name)) layersFound.push('controller');
            if (['service', 'services'].includes(e.name)) layersFound.push('service');
            if (['repository', 'repositories'].includes(e.name)) layersFound.push('repository');
            if (['model', 'models', 'entity', 'entities'].includes(e.name)) layersFound.push('model');
            if (['dto', 'dtos'].includes(e.name)) layersFound.push('dto');
            scanJavaDirs(join(dir, e.name));
          }
        }
      } catch {}
    };
    scanJavaDirs(targetDir);

    if (layersFound.length > 0) {
      findings.architecture = `Layered Architecture (${Array.from(new Set(layersFound)).join(', ')})`;
    }

    const generatedConfig = {
      $schema: 'https://raw.githubusercontent.com/ApenasGabs/agent-standards/main/schema.json',
      preset: 'java-spring',
      language: 'java',
      discovered: findings,
      rules: {
        architecture: {
          pattern: 'layered',
          thinControllers: true,
          useResponseEntity: true,
        },
        spring: {
          useBeanValidation: true,
          dependencyInjection: 'constructor-preferred',
        },
        java: {
          version: parseInt(findings.details.javaVersion, 10) || 17,
          useRecordsForDTOs: true,
          useOptionalForNullableReturns: true,
        },
        logging: {
          prohibitSystemOut: true,
          preferred: 'slf4j-or-logback',
        },
        testing: {
          framework: findings.test || 'junit-5',
          useSpringBootTest: true,
        },
      },
      docsSync: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules'],
    };

    return { findings, generatedConfig };
  }

  // ==========================================
  // 2. Detecção de Repositórios GO
  // ==========================================
  const goModPath = join(targetDir, 'go.mod');
  if (existsSync(goModPath)) {
    findings.language = 'go';
    findings.buildTool = 'go-modules';
    findings.test = 'go-test';

    const modContent = readFileSync(goModPath, 'utf-8');
    const modMatch = modContent.match(/module\s+([^\s]+)/);
    if (modMatch) findings.details.module = modMatch[1];

    const verMatch = modContent.match(/go\s+(\d+\.\d+)/);
    findings.details.goVersion = verMatch ? verMatch[1] : '1.22';

    // Frameworks & Libs de Go
    if (modContent.includes('github.com/gin-gonic/gin')) findings.framework = 'gin';
    else if (modContent.includes('github.com/gofiber/fiber')) findings.framework = 'fiber';
    else if (modContent.includes('github.com/labstack/echo')) findings.framework = 'echo';
    else if (modContent.includes('google/go-github') || modContent.includes('AlecAivazis/survey')) {
      findings.framework = 'cli-automation-tool';
    }

    // Logging
    if (modContent.includes('sirupsen/logrus')) findings.details.logging = 'logrus';
    else if (modContent.includes('uber-go/zap')) findings.details.logging = 'zap';
    else findings.details.logging = 'slog-or-standard';

    // Amostra de código Go
    let hasSignalContext = false;
    let hasGoroutines = false;
    let hasErrorCheck = false;

    const goFiles = [];
    const collectGo = (dir, depth = 0) => {
      if (depth > 2 || goFiles.length >= 8) return;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'vendor') continue;
          const full = join(dir, e.name);
          if (e.isDirectory()) collectGo(full, depth + 1);
          else if (e.name.endsWith('.go')) goFiles.push(full);
        }
      } catch {}
    };
    collectGo(targetDir);

    for (const f of goFiles) {
      try {
        const c = readFileSync(f, 'utf-8');
        if (c.includes('signal.NotifyContext') || c.includes('context.Context')) hasSignalContext = true;
        if (c.includes('sync.WaitGroup') || c.includes('go func(')) hasGoroutines = true;
        if (c.includes('if err != nil')) hasErrorCheck = true;
      } catch {}
    }

    findings.details.contextPropagation = hasSignalContext;
    findings.details.concurrency = hasGoroutines ? 'goroutines-and-sync' : 'standard';
    findings.details.errorHandling = hasErrorCheck ? 'idiomatic-if-err-not-nil' : 'standard';
    findings.architecture = findings.framework === 'cli-automation-tool' ? 'CLI / Daemon Automation' : 'Go Service';

    const generatedConfig = {
      $schema: 'https://raw.githubusercontent.com/ApenasGabs/agent-standards/main/schema.json',
      preset: 'go-service',
      language: 'go',
      discovered: findings,
      rules: {
        errorHandling: {
          neverIgnoreErrors: true,
          wrapErrorsWithFormat: true,
          prohibitPanicInBusinessLogic: true,
        },
        context: {
          requireContextAsFirstParam: true,
          gracefulShutdown: hasSignalContext,
        },
        concurrency: {
          requireWaitGroupOrChannels: hasGoroutines,
          safeGoroutines: true,
        },
        logging: {
          prohibitRawPrintln: true,
          structuredLogging: true,
          preferred: findings.details.logging,
        },
        naming: {
          exportedPascalCase: true,
          unexportedCamelCase: true,
        },
      },
      docsSync: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules'],
    };

    return { findings, generatedConfig };
  }

  // ==========================================
  // 3. Detecção de Repositórios NODE / TYPESCRIPT
  // ==========================================
  findings.language = 'typescript/javascript';
  const pkgPath = join(targetDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (deps.react || deps.next) findings.framework = 'react';
      else if (deps.vue || deps.nuxt) findings.framework = 'vue';
      else if (deps.svelte) findings.framework = 'svelte';

      if (deps.daisyui) findings.ui = 'daisyui';
      else if (deps['@radix-ui/react-primitive'] || deps['lucide-react']) findings.ui = 'shadcn';
      else if (deps['tailwindcss']) findings.ui = 'tailwind';

      if (deps.vitest) findings.test = 'vitest';
      else if (deps.jest) findings.test = 'jest';
      else if (deps.playwright || deps['@playwright/test']) findings.test = 'playwright';

      if (deps.cheerio || deps.playwright || deps.puppeteer) {
        if (pkg.name?.includes('crawl') || pkg.name?.includes('scrap') || existsSync(join(targetDir, 'ARQUITECTURAS_SCRAPING.md'))) {
          findings.details.isScraper = true;
        }
      }
    } catch {}
  }

  // Analisar tsconfig.json
  const tsconfigPath = join(targetDir, 'tsconfig.json');
  let strictTypes = false;
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
      strictTypes = Boolean(tsconfig.compilerOptions?.strict || tsconfig.compilerOptions?.noImplicitAny);
    } catch {
      strictTypes = true;
    }
  }

  // Amostragem de código
  const srcDir = existsSync(join(targetDir, 'src')) ? join(targetDir, 'src') : targetDir;
  let arrowCount = 0;
  let functionCount = 0;
  const sampleFiles = [];
  const collectFiles = (dir, depth = 0) => {
    if (depth > 2 || sampleFiles.length >= 10) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectFiles(full, depth + 1);
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.d.ts')) {
          sampleFiles.push(full);
          if (sampleFiles.length >= 10) break;
        }
      }
    } catch {}
  };
  collectFiles(srcDir);

  for (const f of sampleFiles) {
    try {
      const content = readFileSync(f, 'utf-8');
      arrowCount += (content.match(/=>/g) || []).length;
      functionCount += (content.match(/\bfunction\s+[a-zA-Z0-9_]+\s*\(/g) || []).length;
    } catch {}
  }

  const predominantFunctionStyle = functionCount > arrowCount * 0.8 && functionCount > 3 ? 'traditional' : 'arrow';

  let presetName = 'minimal';
  if (findings.details.isScraper) presetName = 'scraping-crawler';
  else if (findings.framework === 'react') presetName = 'frontend-react';

  const generatedConfig = {
    $schema: 'https://raw.githubusercontent.com/ApenasGabs/agent-standards/main/schema.json',
    preset: presetName,
    language: findings.language,
    discovered: findings,
    rules: {
      functions: predominantFunctionStyle === 'traditional' ? 'any' : 'arrow-only',
      typescript: {
        noExplicitAny: strictTypes,
        preferInterfaces: true,
      },
      ui: {
        preferred: findings.ui,
        requireDataTestId: findings.framework === 'react',
      },
      security: {
        blockInnerHTML: findings.framework === 'react',
        blockHardcodedSecrets: true,
      },
      cleanCode: {
        blockConsoleLog: true,
        blockEmptyCatch: true,
      },
    },
    docsSync: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules'],
  };

  return { findings, generatedConfig };
};

export const writeConfigFile = (targetDir, config) => {
  const dest = join(targetDir, 'agent.config.json');
  writeFileSync(dest, JSON.stringify(config, null, 2), 'utf-8');
  return dest;
};
