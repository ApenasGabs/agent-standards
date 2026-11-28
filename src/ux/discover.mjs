import { execFileSync } from 'node:child_process';

const defaultExec = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });

/**
 * Descobre a URL do preview publicado para um commit pelos deployments do GitHub
 * (a Vercel e outros provedores registram um deployment por commit, com a URL no status).
 * Devolve null quando não há preview pronto; erros de consulta sobem para quem chamou.
 *
 * @param {(command: string, args: string[]) => string} run executor (git/gh) já posicionado no repositório
 * @param {string} sha commit avaliado
 */
export const discoverPreviewUrl = (run, sha) => {
  const deployments = JSON.parse(run('gh', ['api', `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=20`]));
  for (const deployment of Array.isArray(deployments) ? deployments : []) {
    const statuses = JSON.parse(run('gh', ['api', `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=10`]));
    const ready = (Array.isArray(statuses) ? statuses : []).find((st) => st.state === 'success' && /^https?:\/\//.test(st.environment_url || ''));
    if (ready) return { url: ready.environment_url.replace(/\/+$/, ''), environment: deployment.environment ?? null };
  }
  return null;
};

/** Versão para a CLI: consulta o repositório do diretório informado no commit HEAD. */
export const discoverPreviewForHead = (cwd, exec = defaultExec) => {
  const run = (command, args) => exec(command, args, cwd);
  const sha = run('git', ['rev-parse', 'HEAD']).trim();
  return discoverPreviewUrl(run, sha);
};
