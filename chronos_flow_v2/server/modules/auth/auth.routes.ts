import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import { prisma } from '../../db/client.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { AppError, notFound } from '../../lib/errors.js';
import { currentUserId } from '../../lib/currentUser.js';
import { Freio } from '../../lib/freio.js';
import {
  conferirSenha,
  gastarTempoDeConferencia,
  hashSegredo,
  hashSenha,
  novoSegredo,
} from '../../lib/senha.js';
import {
  abrirSessao,
  cliente,
  daPropriaMaquina,
  encerrarSessao,
  exigeLogin,
  resolverUsuario,
  somenteSessao,
  tokenDaSessao,
  type Quem,
} from '../../lib/sessao.js';
import {
  cadastroSchema,
  criarTokenSchema,
  entrarSchema,
  trocarSenhaSchema,
} from '../../../shared/schemas/index.js';
import type { ApiTokenDTO, AuthEstado } from '../../../shared/types.js';

/**
 * Contas.
 *
 * Quem pode se cadastrar:
 * - com `CHRONOS_CONVITE` definido: qualquer um com o codigo, inclusive o
 *   primeiro acesso;
 * - sem convite: so o primeiro acesso, e so desta propria maquina (o app
 *   desktop). Pela rede — tunel, proxy, outro aparelho — o primeiro acesso
 *   sem convite e recusado: senao o primeiro estranho a abrir a URL viraria
 *   o dono dos dados que ja estavam no banco.
 *
 * O primeiro acesso herda esses dados (o usuario unico de antes das contas),
 * entao quem usava o app sozinho nao perde nada ao ligar o login.
 */
const router = Router();

const convite = () => (process.env.CHRONOS_CONVITE ?? '').trim();

function conviteConfere(oferecido: string | undefined): boolean {
  const esperado = convite();
  if (!esperado || !oferecido) return false;
  const [a, b] = [oferecido, esperado].map((v) => createHash('sha256').update(v).digest());
  return timingSafeEqual(a, b);
}

const primeiroAcesso = async () =>
  (await prisma.user.count({ where: { password_hash: { not: null } } })) === 0;

/** Pode criar conta agora, e se nao, por que. */
/** Algum convite individual ainda valido: a tela de entrada precisa oferecer o cadastro. */
const haConviteAtivo = async () =>
  (await prisma.convite.count({
    where: { usado_em: null, revogado_em: null, expira_em: { gt: new Date() } },
  })) > 0;

function regraDeCadastro(
  req: Request,
  primeiro: boolean,
  conviteAtivo = false,
): { aberto: boolean; aviso: string | null } {
  if (convite() || conviteAtivo) return { aberto: true, aviso: null };
  if (!primeiro) return { aberto: false, aviso: null };
  if (daPropriaMaquina(req)) return { aberto: true, aviso: null };
  return {
    aberto: false,
    aviso:
      'Este servidor ainda nao tem conta. Para criar a primeira pela rede, defina CHRONOS_CONVITE no servidor e reinicie.',
  };
}

async function estado(req: Request, quem: Quem | null): Promise<AuthEstado> {
  const real = quem?.adminId ?? quem?.userId ?? null;
  const [primeiro, conviteAtivo, usuario, alvo] = await Promise.all([
    primeiroAcesso(),
    haConviteAtivo(),
    real
      ? prisma.user.findUnique({
          where: { id: real },
          select: { id: true, name: true, email: true, papel: true, dono: true },
        })
      : null,
    quem?.adminId
      ? prisma.user.findUnique({ where: { id: quem.userId }, select: { id: true, name: true, email: true } })
      : null,
  ]);
  const regra = regraDeCadastro(req, primeiro, conviteAtivo);
  return {
    autenticado: Boolean(usuario),
    usuario,
    atuandoComo: alvo,
    primeiroAcesso: primeiro,
    conviteExigido: Boolean(convite()) || (conviteAtivo && !primeiro),
    cadastroAberto: regra.aberto,
    avisoCadastro: regra.aviso,
  };
}

/**
 * Convite individual (link gerado pelo admin). Devolve o id se o token for de
 * um convite valido para este e-mail; null se nao for convite individual.
 */
async function conviteIndividual(token: string | undefined, email: string) {
  if (!token) return null;
  const c = await prisma.convite.findUnique({ where: { token_hash: hashSegredo(token) } });
  if (!c) return null;
  if (c.usado_em) throw new AppError('CADASTRO_FECHADO', 'Este convite ja foi usado.');
  if (c.revogado_em) throw new AppError('CADASTRO_FECHADO', 'Este convite foi revogado.');
  if (c.expira_em.getTime() < Date.now()) throw new AppError('CADASTRO_FECHADO', 'Este convite expirou. Peca outro ao administrador.');
  if (c.email && c.email !== email) {
    throw new AppError('CADASTRO_FECHADO', 'Este convite e para outro e-mail.');
  }
  return c.id;
}

/**
 * Freios. Contam antes do scrypt (ver `freio.ts`).
 * - por e-mail: protege a conta de quem tenta adivinhar a senha dela;
 * - por cliente: protege o servidor de quem varre e-mails ou codigos de
 *   convite, e do custo de CPU de cada tentativa.
 */
const JANELA = 15 * 60 * 1000;
const porEmail = new Freio(10, JANELA);
const porCliente = new Freio(30, JANELA);
const porConta = new Freio(5, JANELA);

const devagar = () =>
  new AppError('MUITAS_TENTATIVAS', 'Muitas tentativas. Espere alguns minutos e tente de novo.');

router.get(
  '/estado',
  asyncHandler(async (req, res) => {
    const quem = await resolverUsuario(req, res, { aceitarToken: false });
    res.json(await estado(req, quem));
  }),
);

router.post(
  '/cadastro',
  asyncHandler(async (req, res) => {
    if (!porCliente.tentar(cliente(req))) throw devagar();
    const body = cadastroSchema.parse(req.body);
    const primeiro = await primeiroAcesso();

    // Primeiro o convite individual (link do admin); depois o codigo unico do
    // .env; sem nenhum dos dois, so o primeiro acesso desta maquina.
    const conviteId = await conviteIndividual(body.convite, body.email);
    if (conviteId) {
      // valido: segue
    } else if (convite()) {
      if (!conviteConfere(body.convite)) throw new AppError('CADASTRO_FECHADO', 'Codigo de convite invalido.');
    } else if (body.convite) {
      throw new AppError('CADASTRO_FECHADO', 'Codigo de convite invalido.');
    } else {
      const regra = regraDeCadastro(req, primeiro);
      if (!regra.aberto) {
        throw new AppError('CADASTRO_FECHADO', regra.aviso ?? 'O cadastro esta fechado neste servidor.');
      }
    }

    if (await prisma.user.findUnique({ where: { email: body.email }, select: { id: true } })) {
      throw new AppError('EMAIL_EM_USO', 'Ja existe uma conta com esse e-mail.');
    }

    const password_hash = await hashSenha(body.senha);

    // O primeiro acesso reivindica o usuario antigo, que e dono dos dados de
    // antes das contas. Dali em diante, cada cadastro e uma conta nova e vazia.
    const antigo = primeiro
      ? await prisma.user.findFirst({ where: { password_hash: null }, orderBy: { created_at: 'asc' } })
      : null;

    // A primeira conta do servidor e a dona: admin para sempre (ver `dono`).
    const papel = primeiro ? 'ADMIN' : 'MEMBRO';

    const userId = await prisma.$transaction(async (tx) => {
      // O convite individual e queimado na mesma transacao: dois cadastros
      // com o mesmo link, ao mesmo tempo, nao passam os dois.
      if (conviteId) {
        const { count } = await tx.convite.updateMany({
          where: { id: conviteId, usado_em: null, revogado_em: null },
          data: { usado_em: new Date() },
        });
        if (count === 0) throw new AppError('CADASTRO_FECHADO', 'Este convite ja foi usado.');
      }

      let id: string;
      if (antigo) {
        // Atomico: se duas pessoas cadastrarem ao mesmo tempo no primeiro
        // acesso, so uma leva os dados; a outra recebe o cadastro fechado.
        const { count } = await tx.user.updateMany({
          where: { id: antigo.id, password_hash: null },
          data: { name: body.nome, email: body.email, password_hash, papel, dono: primeiro },
        });
        if (count === 0) throw new AppError('CADASTRO_FECHADO', 'Outra pessoa acabou de criar a primeira conta.');
        id = antigo.id;
      } else {
        id = (
          await tx.user.create({
            data: { name: body.nome, email: body.email, password_hash, papel, dono: primeiro },
          })
        ).id;
      }

      if (conviteId) await tx.convite.update({ where: { id: conviteId }, data: { usado_por_id: id } });
      return id;
    });

    const sessao = await abrirSessao(req, res, userId, { app: Boolean(body.app) });
    res.status(201).json({
      ...(await estado(req, { userId, via: 'sessao' })),
      ...(body.app ? { tokenDoApp: sessao } : {}),
    });
  }),
);

/**
 * E-mail e senha conferidos, com os mesmos freios da tela de entrada. Usada
 * aqui e na autorizacao do conector do Claude (`/oauth/authorize`): as duas
 * portas contam tentativas juntas.
 */
export async function conferirCredenciais(req: Request, email: string, senha: string) {
  // As duas contagens antes de qualquer await: uma rajada paralela nao
  // passa toda pela checagem antes da primeira falha ser registrada.
  const emailOk = porEmail.tentar(email);
  const clienteOk = porCliente.tentar(cliente(req));
  if (!emailOk || !clienteOk) throw devagar();

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user ? await conferirSenha(senha, user.password_hash) : false;
  if (!user) await gastarTempoDeConferencia(senha);

  if (!user || !ok) throw new AppError('CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.');
  // Dito so depois da senha certa: quem nao tem a senha nao fica sabendo nem
  // que a conta existe, muito menos que esta bloqueada.
  if (user.bloqueado_em) {
    throw new AppError('CONTA_BLOQUEADA', 'Esta conta esta bloqueada. Fale com o administrador.');
  }

  porEmail.liberar(email);
  return user;
}

router.post(
  '/entrar',
  asyncHandler(async (req, res) => {
    const { email, senha, app } = entrarSchema.parse(req.body);
    const user = await conferirCredenciais(req, email, senha);
    const sessao = await abrirSessao(req, res, user.id, { app: Boolean(app) });
    res.json({
      ...(await estado(req, { userId: user.id, via: 'sessao' })),
      ...(app ? { tokenDoApp: sessao } : {}),
    });
  }),
);

router.post(
  '/sair',
  asyncHandler(async (req, res) => {
    await encerrarSessao(req, res);
    res.json(await estado(req, null));
  }),
);

/* Daqui para baixo, so com login, e so pela tela (nao com token de API). */

router.post(
  '/senha',
  exigeLogin,
  somenteSessao,
  asyncHandler(async (req: Request, res) => {
    const userId = await currentUserId();
    if (!porConta.tentar(userId)) throw devagar();
    const { atual, nova } = trocarSenhaSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await conferirSenha(atual, user.password_hash))) {
      throw new AppError('CREDENCIAIS_INVALIDAS', 'A senha atual nao confere.');
    }
    porConta.liberar(userId);

    // Quem troca a senha por desconfianca quer derrubar o resto: os outros
    // aparelhos e os tokens de API (um token vazado sobreviveria a troca).
    const desta = tokenDaSessao(req);
    const [, sessoes, tokens] = await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { password_hash: await hashSenha(nova) } }),
      prisma.session.deleteMany({
        where: { user_id: userId, ...(desta ? { token_hash: { not: hashSegredo(desta) } } : {}) },
      }),
      prisma.apiToken.deleteMany({ where: { user_id: userId } }),
    ]);
    res.json({ trocada: true, sessoesEncerradas: sessoes.count, tokensRevogados: tokens.count });
  }),
);

const toTokenDTO = (t: {
  id: string;
  name: string;
  prefix: string;
  created_at: Date;
  last_used_at: Date | null;
}): ApiTokenDTO => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  created_at: t.created_at.toISOString(),
  last_used_at: t.last_used_at?.toISOString() ?? null,
});

router.get(
  '/tokens',
  exigeLogin,
  somenteSessao,
  asyncHandler(async (_req, res) => {
    const userId = await currentUserId();
    const tokens = await prisma.apiToken.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
    });
    res.json(tokens.map(toTokenDTO));
  }),
);

/** O token aparece so nesta resposta; o banco guarda o hash. */
router.post(
  '/tokens',
  exigeLogin,
  somenteSessao,
  asyncHandler(async (req, res) => {
    const userId = await currentUserId();
    const { nome } = criarTokenSchema.parse(req.body);
    const token = novoSegredo('chr_');
    const criado = await prisma.apiToken.create({
      data: { user_id: userId, name: nome, token_hash: hashSegredo(token), prefix: token.slice(0, 10) },
    });
    res.status(201).json({ ...toTokenDTO(criado), token });
  }),
);

router.delete(
  '/tokens/:id',
  exigeLogin,
  somenteSessao,
  asyncHandler(async (req, res) => {
    const userId = await currentUserId();
    const { count } = await prisma.apiToken.deleteMany({ where: { id: req.params.id, user_id: userId } });
    if (count === 0) throw notFound('Token');
    res.json({ deleted: true });
  }),
);

export default router;
