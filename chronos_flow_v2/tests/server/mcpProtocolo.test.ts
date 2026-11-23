import { describe, expect, it } from 'vitest';
import { criarFerramentas } from '../../server/mcp/ferramentas';
import { PROTOCOL_VERSIONS, responder } from '../../server/mcp/protocolo';

const chamadas: string[] = [];
const tools = criarFerramentas(async (path) => {
  chamadas.push(path);
  if (path.startsWith('/nodes/falha')) throw new Error('nao achei');
  return { ok: true, path };
});

describe('MCP (JSON-RPC)', () => {
  it('initialize negocia a versao', async () => {
    const r: any = await responder({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, tools);
    expect(r.result.protocolVersion).toBe('2025-03-26');
    const r2: any = await responder({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, tools);
    expect(r2.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  it('notificacao nao tem resposta', async () => {
    expect(await responder({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools)).toBeNull();
  });

  it('lista as 16 ferramentas sem expor o run', async () => {
    const r: any = await responder({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, tools);
    expect(r.result.tools).toHaveLength(16);
    expect(Object.keys(r.result.tools[0]).sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('chama a ferramenta e codifica o id na URL', async () => {
    const r: any = await responder(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_node', arguments: { id: '../ai/settings' } } },
      tools,
    );
    expect(chamadas.at(-1)).toBe('/nodes/..%2Fai%2Fsettings');
    expect(r.result.isError).toBeUndefined();
  });

  it('falha da ferramenta volta como resultado com isError', async () => {
    const r: any = await responder(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_node', arguments: { id: 'falha' } } },
      tools,
    );
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('nao achei');
  });

  it('ferramenta e metodo desconhecidos sao erro de protocolo', async () => {
    const r1: any = await responder({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'xyz' } }, tools);
    expect(r1.error.code).toBe(-32602);
    const r2: any = await responder({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, tools);
    expect(r2.error.code).toBe(-32601);
  });
});
