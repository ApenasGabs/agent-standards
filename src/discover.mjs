import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inspeciona um diretório e gera a configuração recomendada de padrões para agentes
 */
export const discoverRepoStandards = (targetDir) => {
  const findings = {
    framework: 'unknown',
    ui: 'none',
    test: 'none',
    type: 'minimal',
    isScraper: false,
    predominantFunctionStyle: 'arrow',
    strictTypes: false,
  };

  // 1. Analisar package.json
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
          findings.isScraper = true;
        }
      }
    } catch {
      // Ignora erro de JSON malformado
    }
  }

  // 2. Analisar tsconfig.json
  const tsconfigPath = join(targetDir, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, 'utf-8'));
      const opts = tsconfig.compilerOptions || {};
      findings.strictTypes = Boolean(opts.strict || opts.noImplicitAny);
    } catch {
      findings.strictTypes = true;
    }
  }

  // 3. Amostragem de código-fonte
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
        if (entry.isDirectory()) {
          collectFiles(full, depth + 1);
        } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.includes('.d.ts')) {
          sampleFiles.push(full);
          if (sampleFiles.length >= 10) break;
        }
      }
    } catch {
      // ignora permissões
    }
  };

  collectFiles(srcDir);

  for (const f of sampleFiles) {
    try {
      const content = readFileSync(f, 'utf-8');
      const arrows = (content.match(/=>/g) || []).length;
      const functions = (content.match(/\bfunction\s+[a-zA-Z0-9_]+\s*\(/g) || []).length;
      arrowCount += arrows;
      functionCount += functions;
    } catch {
      // ignora
    }
  }

  if (functionCount > arrowCount * 0.8 && functionCount > 3) {
    findings.predominantFunctionStyle = 'traditional';
  } else {
    findings.predominantFunctionStyle = 'arrow';
  }

  // 4. Montar a configuração sugerida
  let presetName = 'minimal';
  if (findings.isScraper) presetName = 'scraping-crawler';
  else if (findings.framework === 'react') presetName = 'frontend-react';

  const generatedConfig = {
    $schema: 'https://raw.githubusercontent.com/ApenasGabs/agent-standards/main/schema.json',
    preset: presetName,
    discovered: findings,
    rules: {
      functions: findings.predominantFunctionStyle === 'traditional' ? 'any' : 'arrow-only',
      typescript: {
        noExplicitAny: findings.strictTypes,
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
