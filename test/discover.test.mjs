import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { discoverRepoStandards } from '../src/discover.mjs';
import { runCodeReview } from '../src/review.mjs';
import { syncAgentDocs } from '../src/sync.mjs';

const TEST_DIR = join(process.cwd(), '.tmp-test-runner');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

const writeFiles = (dir, files) => {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content, 'utf-8');
  }
};

before(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test('discover: deve identificar projeto Java Spring Boot via pom.xml e camadas', () => {
  const javaDir = join(TEST_DIR, 'java-app');
  writeFiles(javaDir, {
    'pom.xml': `<?xml version="1.0" encoding="UTF-8"?>
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
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-test</artifactId>
    </dependency>
  </dependencies>
</project>`,
    'src/main/java/com/acme/controller/UserController.java': 'package com.acme.controller;\n',
    'src/main/java/com/acme/service/UserService.java': 'package com.acme.service;\n',
    'src/main/java/com/acme/repository/UserRepository.java': 'package com.acme.repository;\n',
    'src/main/java/com/acme/model/User.java': 'package com.acme.model;\n',
    'target/dto/IgnoredDto.java': 'package ignored;\n',
  });

  const { findings, generatedConfig } = discoverRepoStandards(javaDir);

  assert.strictEqual(findings.language, 'java');
  assert.strictEqual(findings.buildTool, 'maven');
  assert.strictEqual(findings.framework, 'spring-boot');
  assert.strictEqual(findings.details.javaVersion, '17');
  assert.strictEqual(findings.details.springBootVersion, '3.2.4');
  assert.strictEqual(findings.details.orm, 'spring-data-jpa');
  assert.strictEqual(findings.details.validation, 'jakarta-bean-validation');
  assert.strictEqual(findings.test, 'junit-5');
  assert.match(findings.architecture, /\bcontroller\b/);
  assert.match(findings.architecture, /\bservice\b/);
  assert.match(findings.architecture, /\brepository\b/);
  assert.match(findings.architecture, /\bmodel\b/);
  assert.doesNotMatch(findings.architecture, /dto/);
  assert.strictEqual(generatedConfig.preset, 'java-spring');
  assert.strictEqual(generatedConfig.rules.security.blockHardcodedSecrets, true);

  const generated = syncAgentDocs(javaDir, generatedConfig);
  assert.deepStrictEqual(generated, ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules']);

  for (const doc of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const content = readFileSync(join(javaDir, doc), 'utf-8');
    assert.match(content, /Spring Boot/);
    assert.match(content, /Java Records/);
    assert.match(content, /Bean Validation/);
    assert.match(content, /SLF4J/);
    assert.match(content, /JUnit 5/);
    assert.doesNotMatch(content, /daisyUI/);
    assert.doesNotMatch(content, /arrow functions/);
    assert.doesNotMatch(content, /innerHTML/);
  }
});

test('discover: deve identificar projeto Java via build.gradle e build.gradle.kts', () => {
  const gradleDir = join(TEST_DIR, 'java-gradle');
  writeFiles(gradleDir, {
    'build.gradle': `plugins {
  id 'org.springframework.boot' version '3.3.1'
  id 'java'
}
java {
  toolchain {
    languageVersion = JavaLanguageVersion.of(21)
  }
}
dependencies {
  implementation 'org.springframework.boot:spring-boot-starter-web'
  testImplementation 'org.junit.jupiter:junit-jupiter'
}
`,
    'src/main/java/com/acme/controllers/OrderController.java': 'package com.acme.controllers;\n',
    'src/main/java/com/acme/services/OrderService.java': 'package com.acme.services;\n',
  });

  const { findings, generatedConfig } = discoverRepoStandards(gradleDir);

  assert.strictEqual(findings.language, 'java');
  assert.strictEqual(findings.buildTool, 'gradle');
  assert.strictEqual(findings.framework, 'spring-boot');
  assert.strictEqual(findings.details.javaVersion, '21');
  assert.strictEqual(findings.details.springBootVersion, '3.3.1');
  assert.strictEqual(findings.test, 'junit-5');
  assert.strictEqual(findings.architecture, 'Layered Architecture (controller, service)');
  assert.strictEqual(generatedConfig.rules.java.version, 21);

  const ktsDir = join(TEST_DIR, 'java-gradle-kts');
  writeFiles(ktsDir, {
    'build.gradle.kts': `sourceCompatibility = JavaVersion.VERSION_17\n`,
  });
  const ktsResult = discoverRepoStandards(ktsDir);
  assert.strictEqual(ktsResult.findings.language, 'java');
  assert.strictEqual(ktsResult.findings.buildTool, 'gradle');
  assert.strictEqual(ktsResult.findings.details.javaVersion, '17');
});

test('discover: deve identificar projeto Go via go.mod, logrus e padrões idiomáticos', () => {
  const goDir = join(TEST_DIR, 'go-app');
  writeFiles(goDir, {
    'go.mod': `module github.com/acme/test-bot

go 1.22

require (
  github.com/gin-gonic/gin v1.10.0
  github.com/sirupsen/logrus v1.9.4
)
`,
    'cmd/server/main.go': `package main
import (
  "context"
  "os/signal"
)
func run(ctx context.Context) error {
  ctx, stop := signal.NotifyContext(ctx)
  defer stop()
  return nil
}
`,
    'internal/app/worker/pool.go': `package worker
import (
  "errors"
  "sync"
)
func start() error {
  var wg sync.WaitGroup
  go func() { wg.Done() }()
  err := errors.New("boom")
  if err != nil {
    return err
  }
  return nil
}
`,
  });

  const { findings, generatedConfig } = discoverRepoStandards(goDir);

  assert.strictEqual(findings.language, 'go');
  assert.strictEqual(findings.buildTool, 'go-modules');
  assert.strictEqual(findings.framework, 'gin');
  assert.strictEqual(findings.details.module, 'github.com/acme/test-bot');
  assert.strictEqual(findings.details.goVersion, '1.22');
  assert.strictEqual(findings.details.logging, 'logrus');
  assert.strictEqual(findings.details.contextPropagation, true);
  assert.strictEqual(findings.details.concurrency, 'goroutines-and-sync');
  assert.strictEqual(findings.details.errorHandling, 'idiomatic-if-err-not-nil');
  assert.strictEqual(generatedConfig.preset, 'go-service');
  assert.strictEqual(generatedConfig.rules.context.gracefulShutdown, true);
  assert.strictEqual(generatedConfig.rules.concurrency.requireWaitGroupOrChannels, true);
  assert.strictEqual(generatedConfig.rules.security.blockHardcodedSecrets, true);

  const generated = syncAgentDocs(goDir, generatedConfig);
  assert.deepStrictEqual(generated, ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursorrules']);

  for (const doc of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) {
    const content = readFileSync(join(goDir, doc), 'utf-8');
    assert.match(content, /Tratamento Idiomático de Erros/);
    assert.match(content, /context\.Context/);
    assert.match(content, /signal\.NotifyContext/);
    assert.match(content, /sync\.WaitGroup/);
    assert.match(content, /logrus/);
    assert.doesNotMatch(content, /daisyUI/);
    assert.doesNotMatch(content, /arrow functions/);
    assert.doesNotMatch(content, /innerHTML/);
  }
});

test('compatibilidade: review e perfil kraken funcionam em projetos Java e Go sem falsos positivos', async (t) => {
  const setupRepo = (baseFiles, changeFiles) => {
    const dir = mkdtempSync(join(tmpdir(), 'java-go-review-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, 'init', '-q', '-b', 'main');
    writeFiles(dir, baseFiles);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'feature');
    writeFiles(dir, changeFiles);
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'change');
    return dir;
  };

  const fakeExec = (command, args, cwd) => {
    if (command === 'git') return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    throw new Error('gh indisponível');
  };

  const javaProbe = join(TEST_DIR, 'probe-java');
  writeFiles(javaProbe, { 'pom.xml': '<project></project>' });
  const { generatedConfig: javaCfg } = discoverRepoStandards(javaProbe);
  const javaRepo = setupRepo(
    { 'pom.xml': '<project></project>', 'agent.config.json': JSON.stringify(javaCfg) },
    {
      'src/main/java/com/acme/UserService.java': 'public class UserService {\n  public String ping() { return "ok"; }\n}\n',
      'src/test/java/com/acme/UserServiceTest.java': 'class UserServiceTest {}\n',
    }
  );
  const javaReview = await runCodeReview({ target: javaRepo, base: 'main', profile: 'kraken', exec: fakeExec });
  assert.strictEqual(javaReview.divergences.length, 0);
  assert.strictEqual(javaReview.uxAudit.state, 'not-required');

  const goProbe = join(TEST_DIR, 'probe-go');
  writeFiles(goProbe, { 'go.mod': 'module example.com/svc\n\ngo 1.22\n' });
  const { generatedConfig: goCfg } = discoverRepoStandards(goProbe);
  const goRepo = setupRepo(
    { 'go.mod': 'module example.com/svc\n\ngo 1.22\n', 'agent.config.json': JSON.stringify(goCfg) },
    {
      'main.go': 'package main\nfunc ping() string { return "ok" }\n',
      'main_test.go': 'package main\n',
    }
  );
  const goReview = await runCodeReview({ target: goRepo, base: 'main', profile: 'kraken', exec: fakeExec });
  assert.strictEqual(goReview.divergences.length, 0);
  assert.strictEqual(goReview.uxAudit.state, 'not-required');

  const secret = `ghp_${'a1B2'.repeat(9)}`;
  const goLeakRepo = setupRepo(
    { 'go.mod': 'module example.com/svc\n\ngo 1.22\n', 'agent.config.json': JSON.stringify(goCfg) },
    { 'main.go': `package main\nconst token = "${secret}"\n`, 'main_test.go': 'package main\n' }
  );
  const leakReview = await runCodeReview({ target: goLeakRepo, base: 'main', exec: fakeExec });
  assert.strictEqual(leakReview.status, 'NEEDS_CHANGES');
  assert.strictEqual(leakReview.divergences[0].ruleId, 'no-hardcoded-secrets');
});
