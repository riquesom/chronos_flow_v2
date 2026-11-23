process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ZodError } from 'zod';
import { AppError } from './lib/errors.js';
import { enderecosDaRede } from './lib/rede.js';
import { abrirContexto, exigeLogin } from './lib/sessao.js';
import { prisma } from './db/client.js';
import { missingModels } from './lib/schemaGuard.js';
import { recomputeAll } from './modules/nodes/cascade.service.js';
import nodeRoutes from './modules/nodes/nodes.routes.js';
import dependencyRoutes from './modules/dependencies/dependencies.routes.js';
import spaceRoutes from './modules/spaces/spaces.routes.js';
import memberRoutes from './modules/members/members.routes.js';
import focusRoutes from './modules/focus/focus.routes.js';
import reportRoutes, { captureSnapshots } from './modules/reports/reports.routes.js';
import lifeRoutes from './modules/life/life.routes.js';
import userRoutes from './modules/user/user.routes.js';
import backlogRoutes from './modules/backlog/backlog.routes.js';
import templateRoutes from './modules/templates/templates.routes.js';
import aiRoutes from './modules/ai/ai.routes.js';
import updateRoutes from './modules/updates/updates.routes.js';
import authRoutes from './modules/auth/auth.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import oauthRoutes from './modules/oauth/oauth.routes.js';
import mcpRoutes from './modules/mcp/mcp.routes.js';
import transferRoutes, { nomeDesteComputador } from './modules/transfer/transfer.routes.js';
import { anunciar, PORTA_DESCOBERTA } from './lib/descoberta.js';
import { FORMATO_DO_PACOTE } from '../shared/transferencia.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3101);

// O cookie de sessao so e enviado pela propria origem (SameSite=Lax, sem
// `credentials` no CORS), entao liberar a origem aqui nao abre a API para
// outros sites: serve ao app do iPhone e ao MCP, que usam token.
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
/**
 * Corpo JSON de ate 2mb no resto da API. As duas rotas de corpo grande leem o
 * proprio corpo com limite maior (64mb na importacao, 25mb no audio); se este
 * leitor rodasse antes, ele recusaria com 413 o que elas aceitariam.
 */
const CORPO_GRANDE = new Set(['/api/transfer/import', '/api/ai/transcribe']);
const jsonPadrao = express.json({ limit: '2mb' });
app.use((req, res, next) => (CORPO_GRANDE.has(req.path) ? next() : jsonPadrao(req, res, next)));
app.use(abrirContexto);

// Antes do porteiro: e o que o balanceador ou o tunel consultam para saber se
// o app esta de pe. Nao diz nada sobre os dados.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', app: 'Chronos Flow v2', timestamp: new Date().toISOString() });
});

// Entrar, cadastrar e consultar o estado da sessao precisam funcionar sem login.
// MCP remoto e a autorizacao OAuth dele: o Claude da web e do celular entra
// por aqui. Ficam fora de `/api` (o padrao do OAuth e do MCP) e antes da tela,
// que responderia o index.html para qualquer GET.
app.use(oauthRoutes);
app.use('/mcp', mcpRoutes);

app.use('/api/auth', authRoutes);

/**
 * A transferencia tem porta propria: o celular nao faz login, entao ali vale
 * a sessao de quem esta no computador OU o codigo de seis digitos que essa
 * pessoa liberou na tela. Cada rota de la declara quem pode chama-la.
 */
app.use('/api/transfer', transferRoutes);

// Todo o resto da API exige conta. A tela (o `dist`) continua aberta: sem
// login ela so sabe mostrar o formulario de entrada.
app.use('/api', exigeLogin);

app.use('/api/nodes', nodeRoutes);
app.use('/api/dependencies', dependencyRoutes);
app.use('/api/spaces', spaceRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/focus', focusRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/life', lifeRoutes);
app.use('/api/user', userRoutes);
app.use('/api/backlog', backlogRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/updates', updateRoutes);
app.use('/api/admin', adminRoutes);

/**
 * A tela sai do mesmo servidor que a API quando `dist` existe. E o que faz o
 * acesso pela rede funcionar sem configurar nada no cliente: um endereco so,
 * mesma origem, e o `/api` relativo continua valendo de qualquer aparelho.
 */
const dist = path.resolve(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rota inexistente.' } });
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err instanceof ZodError) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Dados invalidos.',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    if (err instanceof AppError) {
      return res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if ((err as any)?.code === 'NOT_FOUND') {
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: (err as Error).message } });
    }

    console.error('[api]', err);
    // Em producao a mensagem crua (detalhes do Prisma, do banco) fica so no log.
    return res.status(500).json({
      error: {
        code: 'INTERNAL',
        message:
          process.env.NODE_ENV === 'production'
            ? 'Erro interno.'
            : ((err as Error)?.message ?? 'Erro interno.'),
      },
    });
  },
);

if (process.env.NODE_ENV !== 'test') {
  // 0.0.0.0 por padrao: quem decide quem entra e o login, nao o bind.
  const HOST = process.env.HOST ?? '0.0.0.0';

  app.listen(PORT, HOST, async () => {
    console.log(`Chronos Flow v2 API em http://localhost:${PORT}`);
    for (const ip of enderecosDaRede()) console.log(`  na rede: http://${ip}:${PORT}`);
    console.log(
      process.env.CHRONOS_CONVITE
        ? '  Cadastro: aberto para quem tiver o codigo de CHRONOS_CONVITE.'
        : '  Cadastro: so a primeira conta, criada desta maquina; depois fecha (CHRONOS_CONVITE abre).',
    );
    prisma.user
      .count({ where: { password_hash: { not: null } } })
      .then((contas) => {
        if (contas === 0 && !process.env.CHRONOS_CONVITE) {
          console.warn(
            '  ATENCAO: nenhuma conta ainda e CHRONOS_CONVITE vazio. Pela rede ninguem consegue' +
              ' criar a primeira conta; defina o convite se este servidor for acessado de fora.',
          );
        }
      })
      .catch(() => {});

    // O anuncio na rede nao expoe dado nenhum: diz que existe um Chronos
    // aqui. Na nuvem nao ha rede local para achar, dai o desligamento.
    if (process.env.CHRONOS_DESCOBERTA !== 'off') {
      anunciar({ nome: nomeDesteComputador(), porta: PORT, formato: FORMATO_DO_PACOTE })
        .then(() => console.log(`  descoberta na rede: UDP ${PORTA_DESCOBERTA} e Bonjour _chronos._tcp`))
        .catch((e: Error) => console.warn('[descoberta]', e.message));
    }

    const missing = missingModels();
    if (missing.length > 0) {
      console.warn(
        `\n  ATENCAO: o client do Prisma nao conhece: ${missing.join(', ')}.` +
          '\n  O schema mudou e o client nao foi regenerado.' +
          '\n  Rode:  npm run prisma:migrate' +
          '\n  (banco sem historico de migrations? rode antes: npm run db:baseline)' +
          '\n  Ate la, as telas que dependem desses modelos ficam indisponiveis.\n',
      );
    }
    try {
      // Uma conta por vez: cada uma tem a propria arvore e os proprios snapshots.
      const contas = await prisma.user.findMany({ select: { id: true } });
      let nos = 0;
      let metas = 0;
      for (const { id } of contas) {
        const result = await recomputeAll(id);
        nos += result.nodes;
        metas += result.roots;
        await captureSnapshots(id);
      }
      if (nos > 0) {
        console.log(`Cascata verificada: ${nos} nos em ${metas} meta(s), ${contas.length} conta(s).`);
      }
    } catch {
      // Banco ainda subindo: o app tenta de novo na proxima requisicao.
    }
  });
}

export default app;
