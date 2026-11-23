import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * Pecas puras do OAuth do MCP remoto, separadas das rotas para dar para testar
 * sem banco nem servidor.
 */

/**
 * A origem publica do servidor (`https://flow.empresa.com`). Atras do tunel
 * ou do proxy o Express recebe HTTP de 127.0.0.1; quem diz o endereco que o
 * Claude enxerga sao os cabecalhos X-Forwarded-*. `CHRONOS_URL_PUBLICA` fixa
 * o valor quando o proxy nao os manda.
 */
export function origemPublica(req: Request): string {
  const fixa = process.env.CHRONOS_URL_PUBLICA?.trim().replace(/\/+$/, '');
  if (fixa) return fixa;
  const proto = req.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.protocol;
  const host = req.get('x-forwarded-host')?.split(',')[0]?.trim() || req.get('host');
  return `${proto}://${host}`;
}

const LOCAIS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * URL de retorno que um cliente pode registrar: HTTPS, ou HTTP so na propria
 * maquina (ferramentas de teste). Sem fragmento, como manda o OAuth.
 */
export function retornoAceito(uri: unknown): uri is string {
  if (typeof uri !== 'string' || uri.length > 500) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOCAIS.has(url.hostname);
}

/** PKCE (S256): o verificador que chega na troca tem de gerar o desafio que veio na autorizacao. */
export function pkceConfere(verificador: unknown, desafio: string): boolean {
  if (typeof verificador !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verificador)) return false;
  const calculado = Buffer.from(createHash('sha256').update(verificador).digest('base64url'));
  const esperado = Buffer.from(desafio);
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

export const novoCodigo = () => randomBytes(32).toString('base64url');

/** Para as paginas HTML da autorizacao: nome do cliente e e-mail vem de fora. */
export const esc = (texto: unknown) =>
  String(texto ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Hosts de onde aceitamos "Client ID Metadata Document" (o client_id e uma URL
 * com os dados do cliente, que o servidor busca). Buscar uma URL qualquer que
 * chega pela barra de endereco seria abrir o servidor para requisicoes a
 * pedido de terceiros; por isso, so dominios conhecidos.
 */
export function hostDeMetadadosPermitido(host: string): boolean {
  const lista = (process.env.CHRONOS_OAUTH_CIMD_HOSTS ?? 'claude.ai,claude.com,anthropic.com')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const h = host.toLowerCase();
  return lista.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Guarda coisas por pouco tempo, com teto de tamanho: pedidos de autorizacao e codigos. */
export class Temporario<T> {
  private itens = new Map<string, { valor: T; ate: number }>();

  constructor(
    private ttlMs: number,
    private max = 1000,
  ) {}

  guardar(chave: string, valor: T) {
    this.limpar();
    if (this.itens.size >= this.max) {
      const maisAntiga = this.itens.keys().next().value;
      if (maisAntiga !== undefined) this.itens.delete(maisAntiga);
    }
    this.itens.set(chave, { valor, ate: Date.now() + this.ttlMs });
  }

  /** Le sem consumir. */
  ver(chave: string): T | null {
    const item = this.itens.get(chave);
    if (!item) return null;
    if (item.ate < Date.now()) {
      this.itens.delete(chave);
      return null;
    }
    return item.valor;
  }

  /** Le e apaga: o codigo de autorizacao vale uma vez so. */
  tirar(chave: string): T | null {
    const valor = this.ver(chave);
    this.itens.delete(chave);
    return valor;
  }

  private limpar() {
    const agora = Date.now();
    for (const [k, v] of this.itens) if (v.ate < agora) this.itens.delete(k);
  }
}
