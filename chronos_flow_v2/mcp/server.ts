/**
 * MCP local do Chronos Flow v2 (stdio): o Claude Code ou o Claude Desktop
 * deste computador sobem este processo, e ele fala com a API REST com o token
 * do .env. Para o Claude da web e do celular ha o MCP remoto, em `/mcp`.
 */
import { criarFerramentas } from '../server/mcp/ferramentas.js';
import { responder } from '../server/mcp/protocolo.js';

const API = process.env.CHRONOS_API ?? 'http://localhost:3101/api';

/**
 * Token de API pessoal, criado em Configuracoes > Conta e acesso. A API exige
 * login em todas as rotas, e o token diz de qual conta sao os dados que o
 * agente le e escreve.
 */
const TOKEN = (process.env.CHRONOS_TOKEN ?? '').trim();

async function call(path: string, init?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (res.status === 401) {
    throw new Error(
      TOKEN
        ? 'O token do Chronos foi recusado (revogado?). Gere outro em Configuracoes > Conta e acesso.'
        : 'Falta o token do Chronos: crie um em Configuracoes > Conta e acesso e passe em CHRONOS_TOKEN.',
    );
  }
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

export const tools = criarFerramentas(call);

/** Loop JSON-RPC sobre stdio. */
async function main() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  const send = (payload: unknown) => process.stdout.write(`${JSON.stringify(payload)}\n`);

  for await (const chunk of process.stdin) {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resposta = await responder(message, tools);
      if (resposta) send(resposta);
    }
  }
}

if (process.argv[1]?.includes('server')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
