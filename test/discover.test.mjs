import assert from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { discoverRepoStandards } from '../src/discover.mjs';
import { syncAgentDocs } from '../src/sync.mjs';

const TEST_DIR = join(process.cwd(), '.tmp-test-runner');

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test('discover: deve identificar projeto Java Spring Boot via pom.xml', () => {
  const javaDir = join(TEST_DIR, 'java-app');
  mkdirSync(javaDir, { recursive: true });

  const pomContent = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.4</version>
  </parent>
  <properties>
    <java.version>17</java.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-jpa</artifactId>
    </dependency>
  </dependencies>
</project>`;

  writeFileSync(join(javaDir, 'pom.xml'), pomContent, 'utf-8');

  const { findings, generatedConfig } = discoverRepoStandards(javaDir);

  assert.strictEqual(findings.language, 'java');
  assert.strictEqual(findings.buildTool, 'maven');
  assert.strictEqual(findings.framework, 'spring-boot');
  assert.strictEqual(findings.details.javaVersion, '17');
  assert.strictEqual(generatedConfig.preset, 'java-spring');

  // Testar sincronização sem misturar regras de TypeScript
  syncAgentDocs(javaDir, generatedConfig);
  const agentsMd = readFileSync(join(javaDir, 'AGENTS.md'), 'utf-8');
  assert.match(agentsMd, /Spring Boot/);
  assert.match(agentsMd, /JUnit 5/);
  assert.doesNotMatch(agentsMd, /daisyUI/);
  assert.doesNotMatch(agentsMd, /arrow functions/);
});

test('discover: deve identificar projeto Go via go.mod e logrus', () => {
  const goDir = join(TEST_DIR, 'go-app');
  mkdirSync(goDir, { recursive: true });

  const goModContent = `module test-bot

go 1.22

require (
  github.com/sirupsen/logrus v1.9.4
)
`;

  writeFileSync(join(goDir, 'go.mod'), goModContent, 'utf-8');

  const { findings, generatedConfig } = discoverRepoStandards(goDir);

  assert.strictEqual(findings.language, 'go');
  assert.strictEqual(findings.buildTool, 'go-modules');
  assert.strictEqual(findings.details.goVersion, '1.22');
  assert.strictEqual(findings.details.logging, 'logrus');
  assert.strictEqual(generatedConfig.preset, 'go-service');

  // Testar sincronização sem misturar regras de TypeScript
  syncAgentDocs(goDir, generatedConfig);
  const agentsMd = readFileSync(join(goDir, 'AGENTS.md'), 'utf-8');
  assert.match(agentsMd, /Tratamento Idiomático de Erros/);
  assert.match(agentsMd, /context\.Context/);
  assert.doesNotMatch(agentsMd, /daisyUI/);
  assert.doesNotMatch(agentsMd, /arrow functions/);
});
