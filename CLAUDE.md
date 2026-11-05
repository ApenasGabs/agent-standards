# Diretrizes de Engenharia e Padrões de Código (Claude Code)

> Gerado automaticamente por `@apenasgabs/agent-standards` a partir de `agent.config.json`.

## 1. Padrões de Funções e Sintaxe
- ❌ **NUNCA** usar `function` tradicional em arquivos de lógica/componentes.
- ✅ **SEMPRE** utilizar arrow functions (`const fn = () => {}`).

## 2. Tipagem TypeScript
- ✅ Preferir `interface` para objetos e contratos de dados complexos.

## 3. Componentes e Estilo de UI
- ✅ Biblioteca padrão de componentes: **none**.

## 4. Segurança e Higiene de Código
- ❌ **Credenciais Proibidas**: Nunca commitar API keys, senhas ou tokens hardcoded.
- ❌ Remover `console.log` e chamadas de depuração residuais antes de finalizar.
- ❌ Proibido blocos `catch` vazios sem tratamento ou logging estruturado.

## 5. Fluxo de Trabalho e Code Review
- Toda entrega deve atender estritamente aos requisitos da tarefa/issue e aos padrões deste documento.
- Para auditar a conformidade deste repositório, execute: `npx @apenasgabs/agent-standards review`.
