---
name: agent-standards
description: "Universal Agent Standards Engine — Discover, generate, and enforce custom coding & architecture standards across Antigravity (AGY), Claude Code, Cursor, and GitHub Actions."
---

# Universal Agent Standards Engine (AGY Skill)

Esta skill capacita qualquer agente de IA (Antigravity/AGY, Claude Code, Cursor) a auto-descobrir padrões de código em repositórios desconhecidos, sincronizar arquivos de regras entre ferramentas e auditar a conformidade de PRs e tarefas em dois eixos (Spec e Standards).

---

## 1. Comandos Disponíveis

Quando estiver trabalhando em qualquer repositório, você pode invocar a ferramenta via CLI:

```bash
# 1. Inspecionar o repositório e gerar a configuração de padrões
npx @apenasgabs/agent-standards init

# 2. Apenas visualizar o perfil detectado (framework, UI, testes, estilo de função)
npx @apenasgabs/agent-standards discover

# 3. Sincronizar AGENTS.md, CLAUDE.md, .cursorrules e .github/copilot-instructions.md
npx @apenasgabs/agent-standards sync

# 4. Executar Code Review nos dois eixos (Aderência à Tarefa vs Padrões Documentados)
npx @apenasgabs/agent-standards review --base origin/main
```

---

## 2. Como Funciona a Descoberta (Auto-Discovery)

O motor não impõe regras arbitrárias. Ele inspeciona:
1. `package.json` para detectar o framework (React, Vue, Svelte), UI (daisyUI, shadcn, Tailwind), test runner (Vitest, Jest, Playwright) e se o projeto é um crawler/scraper.
2. `tsconfig.json` para detectar o nível de rigor de tipagem.
3. Amostra de código-fonte (`src/`) para inferir o estilo predominante de funções (`arrow` vs `traditional`).
4. Gera o manifesto unificado em `agent.config.json`.

---

## 3. Os Dois Eixos de Auditoria (Review)

1. **Eixo 1: Aderência à Tarefa (Spec)**
   - Extrai os requisitos da Issue ou PR do GitHub.
   - Confronta cada requisito contra as alterações do `git diff`.
   - Evidencia arquivos e números de linha onde cada requisito foi implementado.
   - Aponta requisitos ausentes ou escopo não solicitado (*scope creep*).

2. **Eixo 2: Conformidade com Padrões (Standards)**
   - Audita estritamente as regras que o próprio repositório definiu no seu `agent.config.json` ou nos seus arquivos de documentação (`AGENTS.md`, `CLAUDE.md`, `copilot-instructions.md`).
   - Cita a linha de código e a regra violada.
   - Gera automaticamente o arquivo `review-fixes.patch`.
