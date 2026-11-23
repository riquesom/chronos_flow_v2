import { Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { resolverUsuario } from '../../lib/sessao.js';
import { criarFerramentas, type Chamar } from '../../mcp/ferramentas.js';
import { responder } from '../../mcp/protocolo.js';
import { origemPublica } from '../oauth/oauth.js';

/**
 * MCP remoto (transporte Streamable HTTP, sem sessao): o mesmo MCP do
 * computador, alcancavel pelo Claude da web e do celular em `/mcp`.
 *
 * Cada POST traz uma mensagem JSON-RPC (ou um lote) e a resposta vem em JSON.
 * Sem token valido, responde 401 apontando para os metadados OAuth: e assim
 * que o Claude descobre onde pedir a autorizacao.
 *
 * As ferramentas chamam a propria API por dentro (127.0.0.1) com o mesmo
 * token: dono dos dados, bloqueio e "token nao mexe na conta" valem sem
 * nenhuma regra repetida aqui.
 */
const router = Router();

const API_INTERNA = `http://127.0.0.1:${process.env.PORT ?? 3101}/api`;

const chamarComo =
  (autorizacao: string): Chamar =>
  async (path, init) => {
    const r = await fetch(`${API_INTERNA}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: autorizacao, ...(init?.headers ?? {}) },
    });
    const body = (await r.json().catch(() => null)) as any;
    if (r.status === 401) {
      throw new Error('A autorizacao do Claude no Chronos foi revogada. Reconecte o conector nas configuracoes do Claude.');
    }
    if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
    return body;
  };

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const autorizacao = req.get('authorization');
    const quem = autorizacao?.startsWith('Bearer ') ? await resolverUsuario(req, res) : null;
    if (!quem || !autorizacao) {
      const metadados = `${origemPublica(req)}/.well-known/oauth-protected-resource/mcp`;
      res.set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${metadados}"${autorizacao ? ', error="invalid_token"' : ''}`,
      );
      return res.status(401).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Conecte o Chronos: falta autorizacao ou ela foi revogada.' },
      });
    }

    const corpo = req.body;
    const lote = Array.isArray(corpo);
    const mensagens = lote ? corpo : [corpo];
    if (!corpo || typeof corpo !== 'object' || mensagens.length === 0) {
      return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON-RPC invalido.' } });
    }

    const tools = criarFerramentas(chamarComo(autorizacao));
    const respostas = (await Promise.all(mensagens.map((m) => responder(m, tools)))).filter(Boolean);
    // So notificacoes (ou respostas do cliente): nada a devolver.
    if (respostas.length === 0) return res.status(202).end();
    res.json(lote ? respostas : respostas[0]);
  }),
);

// Sem sessao nem eventos do servidor: o canal GET (SSE) e o DELETE nao existem aqui.
router.all('/', (_req, res) => {
  res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST.' } });
});

export default router;
