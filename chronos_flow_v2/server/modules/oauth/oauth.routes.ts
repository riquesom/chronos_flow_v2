import express, { Router, type Request, type Response } from 'express';
import { prisma } from '../../db/client.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError } from '../../lib/errors.js';
import { Freio } from '../../lib/freio.js';
import { hashSegredo, novoSegredo } from '../../lib/senha.js';
import { cliente, resolverUsuario, tokenDaSessao } from '../../lib/sessao.js';
import { conferirCredenciais } from '../auth/auth.routes.js';
import {
  Temporario,
  esc,
  hostDeMetadadosPermitido,
  novoCodigo,
  origemPublica,
  pkceConfere,
  retornoAceito,
} from './oauth.js';

/**
 * Servidor de autorizacao OAuth 2.1 do MCP remoto (`/mcp`).
 *
 * E o que deixa o Claude da web e do celular falar com o Chronos em nome de
 * uma conta: a pessoa adiciona o conector, o Claude abre `/oauth/authorize`,
 * ela entra com o e-mail e a senha do Chronos e permite. O Claude recebe um
 * token de API comum (`chr_`), com as mesmas regras dos tokens do MCP local:
 * le e escreve os projetos da conta, mas nao mexe em senha, tokens nem
 * administracao. O token aparece em Configuracoes > Tokens de API e pode ser
 * revogado ali.
 *
 * - Descoberta: RFC 9728 (recurso protegido) e RFC 8414 (servidor).
 * - Cliente: registro automatico (RFC 7591) ou documento de metadados
 *   (client_id como URL), so de dominios conhecidos.
 * - Codigo de autorizacao com PKCE S256 obrigatorio, uso unico, 5 minutos.
 */
const router = Router();
/** O formulario da autorizacao e a troca do token chegam como form, nao JSON. */
const formulario = express.urlencoded({ extended: false, limit: '20kb' });

const ESCOPO = 'chronos';

interface Cliente {
  id: string;
  nome: string;
  redirect_uris: string[];
}

interface Pedido {
  cliente: Cliente;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  /** Sessao do navegador que viu a tela: o "Permitir" so vale vindo dela. */
  sessao: string | null;
}

interface Codigo {
  cliente_id: string;
  cliente_nome: string;
  redirect_uri: string;
  code_challenge: string;
  userId: string;
}

const pedidos = new Temporario<Pedido>(10 * 60_000);
const codigos = new Temporario<Codigo>(5 * 60_000);
const metadadosDeCliente = new Temporario<Cliente>(10 * 60_000, 200);
const registrosPorCliente = new Freio(20, 60 * 60_000);

/* ── Descoberta ──────────────────────────────────────────────────────────── */

const recursoProtegido = (req: Request) => {
  const o = origemPublica(req);
  return {
    resource: `${o}/mcp`,
    authorization_servers: [o],
    bearer_methods_supported: ['header'],
    scopes_supported: [ESCOPO],
    resource_name: 'Chronos Flow',
  };
};

const servidorDeAutorizacao = (req: Request) => {
  const o = origemPublica(req);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [ESCOPO],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
};

router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
  res.json(recursoProtegido(req));
});
router.get(
  ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'],
  (req, res) => res.json(servidorDeAutorizacao(req)),
);

/* ── Registro do cliente ─────────────────────────────────────────────────── */

const erroOAuth = (res: Response, status: number, error: string, descricao: string) =>
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: descricao });

router.post(
  '/oauth/register',
  asyncHandler(async (req, res) => {
    if (!registrosPorCliente.tentar(cliente(req))) {
      return erroOAuth(res, 429, 'slow_down', 'Muitos registros. Tente mais tarde.');
    }
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const uris = corpo.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(retornoAceito)) {
      return erroOAuth(
        res,
        400,
        'invalid_redirect_uri',
        'redirect_uris: de 1 a 10 URLs HTTPS (HTTP so em localhost), sem fragmento.',
      );
    }
    const nome = String(corpo.client_name ?? '').trim().slice(0, 100) || 'Cliente MCP';
    const criado = await prisma.oAuthCliente.create({ data: { nome, redirect_uris: uris as string[] } });
    // Cliente publico: o que ele pedir de autenticacao no token vira `none` —
    // quem protege a troca e o PKCE.
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: criado.id,
      client_id_issued_at: Math.floor(criado.criado_em.getTime() / 1000),
      client_name: criado.nome,
      redirect_uris: criado.redirect_uris,
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: ESCOPO,
    });
  }),
);

/** O cliente pelo client_id: registrado aqui (uuid) ou documento de metadados (URL HTTPS). */
async function acharCliente(clientId: unknown): Promise<Cliente | null> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 500) return null;

  if (/^[0-9a-f-]{36}$/i.test(clientId)) {
    const c = await prisma.oAuthCliente.findUnique({ where: { id: clientId } });
    return c ? { id: c.id, nome: c.nome, redirect_uris: c.redirect_uris } : null;
  }

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !hostDeMetadadosPermitido(url.hostname)) return null;

  const guardado = metadadosDeCliente.ver(clientId);
  if (guardado) return guardado;
  try {
    const r = await fetch(clientId, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const texto = await r.text();
    if (texto.length > 64_000) return null;
    const d = JSON.parse(texto) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    if (d.client_id !== clientId || !Array.isArray(d.redirect_uris)) return null;
    const c: Cliente = {
      id: clientId,
      nome: String(d.client_name ?? url.hostname).slice(0, 100),
      redirect_uris: d.redirect_uris.filter(retornoAceito),
    };
    metadadosDeCliente.guardar(clientId, c);
    return c;
  } catch {
    return null;
  }
}

/* ── Autorizacao ─────────────────────────────────────────────────────────── */

/** Volta para o cliente com o resultado na query, como manda o OAuth. */
function voltar(res: Response, redirectUri: string, params: Record<string, string | null>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  res.redirect(302, url.toString());
}

/** Quem esta logado neste navegador (a pessoa de verdade, mesmo se o admin estiver no espaco de alguem). */
async function pessoaDaSessao(req: Request, res: Response) {
  const quem = await resolverUsuario(req, res, { aceitarToken: false });
  if (!quem || quem.via !== 'sessao') return null;
  const id = quem.adminId ?? quem.userId;
  return prisma.user.findUnique({ where: { id }, select: { id: true, name: true, email: true } });
}

const valor = (v: unknown) => (typeof v === 'string' ? v : null);

router.get(
  '/oauth/authorize',
  asyncHandler(async (req, res) => {
    const q = req.query;
    const cliente = await acharCliente(q.client_id);
    const redirectUri = valor(q.redirect_uri);
    // Cliente ou retorno invalidos: nunca redireciona (seria um redirecionador
    // aberto). Mostra o erro aqui mesmo.
    if (!cliente) return pagina(res, erroHtml('Este conector nao esta registrado neste Chronos. Remova e adicione de novo no Claude.'));
    if (!redirectUri || !cliente.redirect_uris.includes(redirectUri)) {
      return pagina(res, erroHtml('O endereco de retorno nao bate com o registrado pelo conector.'));
    }

    const state = valor(q.state);
    if (q.response_type !== 'code') {
      return voltar(res, redirectUri, { error: 'unsupported_response_type', state });
    }
    const desafio = valor(q.code_challenge);
    if (!desafio || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(desafio)) {
      return voltar(res, redirectUri, {
        error: 'invalid_request',
        error_description: 'PKCE S256 e obrigatorio.',
        state,
      });
    }

    const outraConta = q.outra_conta === '1';
    const pessoa = outraConta ? null : await pessoaDaSessao(req, res);
    const sessao = tokenDaSessao(req);
    const id = novoCodigo();
    pedidos.guardar(id, {
      cliente,
      redirect_uri: redirectUri,
      state,
      code_challenge: desafio,
      sessao: pessoa && sessao ? hashSegredo(sessao) : null,
    });
    pagina(res, consentimento({ id, cliente, redirectUri, pessoa, urlOutraConta: outraContaUrl(req) }), redirectUri);
  }),
);

router.post(
  '/oauth/authorize',
  formulario,
  asyncHandler(async (req, res) => {
    const id = valor(req.body?.pedido);
    const pedido = id ? pedidos.ver(id) : null;
    if (!id || !pedido) {
      return pagina(res, erroHtml('Este pedido expirou. Volte ao Claude e conecte de novo.'));
    }
    const { cliente: c, redirect_uri, state } = pedido;

    if (req.body?.decisao !== 'permitir') {
      pedidos.tirar(id);
      return voltar(res, redirect_uri, { error: 'access_denied', state, iss: origemPublica(req) });
    }

    let userId: string | null = null;
    const email = valor(req.body?.email)?.trim().toLowerCase();
    const senha = valor(req.body?.senha);
    if (email && senha) {
      try {
        userId = (await conferirCredenciais(req, email, senha)).id;
      } catch (e) {
        const msg = e instanceof AppError ? e.message : 'Nao foi possivel entrar.';
        return pagina(
          res,
          consentimento({ id, cliente: c, redirectUri: redirect_uri, pessoa: null, erro: msg, email, urlOutraConta: null }),
          redirect_uri,
        );
      }
    } else {
      // Sem senha no formulario: vale a sessao que viu a tela, e so ela.
      const sessao = tokenDaSessao(req);
      const pessoa = await pessoaDaSessao(req, res);
      if (!pessoa || !sessao || !pedido.sessao || hashSegredo(sessao) !== pedido.sessao) {
        return pagina(
          res,
          consentimento({ id, cliente: c, redirectUri: redirect_uri, pessoa: null, erro: 'Entre com a sua conta para permitir.', urlOutraConta: null }),
          redirect_uri,
        );
      }
      userId = pessoa.id;
    }

    pedidos.tirar(id);
    const codigo = novoCodigo();
    codigos.guardar(hashSegredo(codigo), {
      cliente_id: c.id,
      cliente_nome: c.nome,
      redirect_uri,
      code_challenge: pedido.code_challenge,
      userId,
    });
    voltar(res, redirect_uri, { code: codigo, state, iss: origemPublica(req) });
  }),
);

/* ── Token ───────────────────────────────────────────────────────────────── */

router.post(
  '/oauth/token',
  formulario,
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.grant_type !== 'authorization_code') {
      return erroOAuth(res, 400, 'unsupported_grant_type', 'So authorization_code.');
    }
    const codigo = valor(b.code);
    const guardado = codigo ? codigos.tirar(hashSegredo(codigo)) : null;
    if (
      !guardado ||
      guardado.cliente_id !== b.client_id ||
      guardado.redirect_uri !== b.redirect_uri ||
      !pkceConfere(b.code_verifier, guardado.code_challenge)
    ) {
      return erroOAuth(res, 400, 'invalid_grant', 'Codigo invalido, expirado, ja usado ou que nao confere.');
    }

    const user = await prisma.user.findUnique({ where: { id: guardado.userId }, select: { bloqueado_em: true } });
    if (!user || user.bloqueado_em) return erroOAuth(res, 400, 'invalid_grant', 'Conta indisponivel.');

    // Autorizar de novo o mesmo conector troca o token: nao acumulam.
    const token = novoSegredo('chr_');
    await prisma.$transaction([
      prisma.apiToken.deleteMany({ where: { user_id: guardado.userId, cliente_oauth: guardado.cliente_id } }),
      prisma.apiToken.create({
        data: {
          user_id: guardado.userId,
          name: `Conector: ${guardado.cliente_nome}`.slice(0, 60),
          token_hash: hashSegredo(token),
          prefix: token.slice(0, 10),
          cliente_oauth: guardado.cliente_id,
        },
      }),
    ]);
    res.set('Cache-Control', 'no-store').json({ access_token: token, token_type: 'Bearer', scope: ESCOPO });
  }),
);

/* ── Paginas ─────────────────────────────────────────────────────────────── */

function outraContaUrl(req: Request): string {
  const url = new URL(req.originalUrl, 'http://x');
  url.searchParams.set('outra_conta', '1');
  return `${url.pathname}${url.search}`;
}

/**
 * Pagina propria, sem o app React: e o que o navegador mostra no meio do
 * fluxo do Claude. Nao pode ser emoldurada (clickjacking no "Permitir"), e o
 * formulario so pode enviar para ca e redirecionar para o retorno do conector.
 */
function pagina(res: Response, corpo: string, redirectUri?: string) {
  const destino = redirectUri ? ` ${new URL(redirectUri).origin}` : '';
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${destino}; frame-ancestors 'none'; base-uri 'none'`,
    })
    .send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chronos Flow — conectar</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: #0a0a0a; color: #fafafa; font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  main { width: 100%; max-width: 420px; }
  .marca { text-align: center; margin-bottom: 20px; font-size: 18px; font-weight: 600; }
  .v { font: 10px ui-monospace, Menlo, monospace; background: #262626; color: #a3a3a3; padding: 1px 5px; border-radius: 4px; vertical-align: middle; }
  .cartao { border: 1px solid #262626; background: #0f0f0f; border-radius: 12px; padding: 20px; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  p { margin: 0 0 12px; color: #a3a3a3; line-height: 1.5; font-size: 13px; }
  strong { color: #fafafa; }
  ul { margin: 0 0 14px; padding-left: 18px; color: #a3a3a3; font-size: 13px; line-height: 1.6; }
  .conta { border: 1px solid #262626; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
  .conta a { color: #a3a3a3; font-size: 12px; }
  label { display: block; font-size: 12px; color: #a3a3a3; margin: 10px 0 4px; }
  input { width: 100%; background: #0a0a0a; border: 1px solid #262626; color: inherit; border-radius: 6px; padding: 10px; font: inherit; }
  input:focus { outline: none; border-color: #a3a3a3; }
  .botoes { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; border-radius: 8px; padding: 11px; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid #262626; }
  .sim { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
  .nao { background: transparent; color: #fafafa; }
  .erro { color: #fca5a5; background: #450a0a55; border: 1px solid #7f1d1d; border-radius: 6px; padding: 8px 10px; font-size: 12px; margin-bottom: 12px; }
  .rodape { margin-top: 12px; font-size: 11px; color: #737373; text-align: center; }
</style>
</head>
<body><main><div class="marca">Chronos Flow <span class="v">v2</span></div><div class="cartao">${corpo}</div></main></body>
</html>`);
}

function erroHtml(mensagem: string) {
  return `<h1>Nao deu para conectar</h1><p>${esc(mensagem)}</p>`;
}

function consentimento(o: {
  id: string;
  cliente: Cliente;
  redirectUri: string;
  pessoa: { name: string; email: string | null } | null;
  erro?: string;
  email?: string;
  urlOutraConta: string | null;
}) {
  const destino = new URL(o.redirectUri).host;
  const login = o.pessoa
    ? `<div class="conta">Conta: <strong>${esc(o.pessoa.name)}</strong> · ${esc(o.pessoa.email)}${
        o.urlOutraConta ? `<br /><a href="${esc(o.urlOutraConta)}">Usar outra conta</a>` : ''
      }</div>`
    : `<label for="email">E-mail do Chronos</label>
       <input id="email" name="email" type="email" autocomplete="email" required value="${esc(o.email ?? '')}" />
       <label for="senha">Senha</label>
       <input id="senha" name="senha" type="password" autocomplete="current-password" required />`;

  return `
<h1>Conectar ${esc(o.cliente.nome)} ao Chronos</h1>
<p><strong>${esc(o.cliente.nome)}</strong> quer acessar o Chronos Flow com a sua conta. Ele vai poder:</p>
<ul>
  <li>ver seus espacos, metas, tarefas e atualizacoes;</li>
  <li>criar, editar, concluir e reorganizar tarefas.</li>
</ul>
<p>Nao mexe em senha, tokens nem administracao. Da para revogar quando quiser em Configuracoes &rarr; Tokens de API.</p>
${o.erro ? `<div class="erro" role="alert">${esc(o.erro)}</div>` : ''}
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="pedido" value="${esc(o.id)}" />
  ${login}
  <div class="botoes">
    <button class="nao" type="submit" name="decisao" value="negar" formnovalidate>Cancelar</button>
    <button class="sim" type="submit" name="decisao" value="permitir">${o.pessoa ? 'Permitir' : 'Entrar e permitir'}</button>
  </div>
</form>
<div class="rodape">Depois volta para ${esc(destino)}</div>`;
}

export default router;
