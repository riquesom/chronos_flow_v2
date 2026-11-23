import type { Tool } from './ferramentas.js';

/**
 * O MCP em JSON-RPC, sem SDK: e pouco protocolo, e escrito aqui ele serve
 * igual ao transporte stdio (MCP local) e ao HTTP (MCP remoto).
 */

/** Versoes do protocolo que este servidor entende; a primeira e a preferida. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const INFO_DO_SERVIDOR = { name: 'chronos-flow-v2', version: '2.0.0' };

interface Mensagem {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

/**
 * Responde uma mensagem. Notificacao (sem id) nao tem resposta: devolve null.
 * Falha de ferramenta volta como resultado com `isError`, para o modelo ler a
 * mensagem e reagir; erro de protocolo fica para o que e protocolo.
 */
export async function responder(message: Mensagem, tools: Tool[]): Promise<object | null> {
  const isRequest = message?.id !== undefined && message?.id !== null;
  if (!isRequest) return null;
  const id = message.id;

  try {
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: INFO_DO_SERVIDOR,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          },
        };
      case 'tools/call': {
        const tool = tools.find((t) => t.name === message.params?.name);
        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: `Ferramenta desconhecida: ${message.params?.name}` },
          };
        }
        try {
          const result = await tool.run(message.params?.arguments ?? {});
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
          };
        } catch (error) {
          return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Erro: ${(error as Error).message}` }], isError: true },
          };
        }
      }
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Metodo nao suportado: ${message.method}` },
        };
    }
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: (error as Error).message } };
  }
}
