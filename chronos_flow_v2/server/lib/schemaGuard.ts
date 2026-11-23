import { prisma } from '../db/client.js';
import { AppError } from './errors.js';

/**
 * O client do Prisma e gerado a partir do schema. Quando o schema ganha um
 * modelo e ninguem roda `prisma generate`, o acesso vira `undefined` e o erro
 * que chega e um TypeError sem contexto. Este guarda troca isso por uma
 * mensagem que diz o que fazer.
 */
const REQUIRED_MODELS = [
  'user',
  'space',
  'spaceMember',
  'member',
  'node',
  'nodeDependency',
  'progressSnapshot',
  'nodeActivity',
  'backlogItem',
  'backlogRole',
  'taskTemplate',
  'nodeUpdate',
  'convite',
  'oAuthCliente',
] as const;

export function hasModel(name: string): boolean {
  return Boolean((prisma as unknown as Record<string, unknown>)[name]);
}

export function missingModels(): string[] {
  return REQUIRED_MODELS.filter((m) => !hasModel(m));
}

export function requireModel(name: string): void {
  if (hasModel(name)) return;
  throw new AppError(
    'INTERNAL',
    `O client do Prisma esta desatualizado: o modelo "${name}" nao existe nele. ` +
      `Rode "npm run prisma:migrate" (gera e aplica a migration) e reinicie o servidor. ` +
      `Se o banco ainda nao tem historico de migrations, rode "npm run db:baseline" antes.`,
    { missing: missingModels() },
  );
}

/** Middleware: bloqueia um modulo inteiro quando o modelo dele nao existe. */
export function requireModels(...names: string[]) {
  return (_req: unknown, _res: unknown, next: (err?: unknown) => void) => {
    try {
      for (const name of names) requireModel(name);
      next();
    } catch (err) {
      next(err);
    }
  };
}
