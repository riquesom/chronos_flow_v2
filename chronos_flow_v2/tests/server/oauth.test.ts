import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Temporario,
  esc,
  hostDeMetadadosPermitido,
  pkceConfere,
  retornoAceito,
} from '../../server/modules/oauth/oauth';

describe('PKCE S256', () => {
  const verificador = 'a'.repeat(43) + '-._~XYZ';
  const desafio = createHash('sha256').update(verificador).digest('base64url');

  it('aceita o verificador que gera o desafio', () => {
    expect(pkceConfere(verificador, desafio)).toBe(true);
  });
  it('recusa outro verificador, curto demais ou com caracteres fora do padrao', () => {
    expect(pkceConfere('b'.repeat(50), desafio)).toBe(false);
    expect(pkceConfere('curto', desafio)).toBe(false);
    expect(pkceConfere('a'.repeat(43) + ' ', desafio)).toBe(false);
    expect(pkceConfere(undefined, desafio)).toBe(false);
  });
});

describe('URL de retorno', () => {
  it('aceita HTTPS e HTTP so na propria maquina', () => {
    expect(retornoAceito('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(retornoAceito('http://localhost:6274/oauth/callback')).toBe(true);
    expect(retornoAceito('http://127.0.0.1:33418/cb')).toBe(true);
  });
  it('recusa HTTP na rede, outros esquemas, fragmento e lixo', () => {
    expect(retornoAceito('http://evil.com/cb')).toBe(false);
    expect(retornoAceito('javascript:alert(1)')).toBe(false);
    expect(retornoAceito('https://claude.ai/cb#x')).toBe(false);
    expect(retornoAceito('nao e url')).toBe(false);
    expect(retornoAceito(42)).toBe(false);
    expect(retornoAceito(`https://claude.ai/${'a'.repeat(600)}`)).toBe(false);
  });
});

describe('documento de metadados do cliente', () => {
  afterEach(() => {
    delete process.env.CHRONOS_OAUTH_CIMD_HOSTS;
  });
  it('so busca em dominios conhecidos (e subdominios)', () => {
    expect(hostDeMetadadosPermitido('claude.ai')).toBe(true);
    expect(hostDeMetadadosPermitido('api.claude.ai')).toBe(true);
    expect(hostDeMetadadosPermitido('anthropic.com')).toBe(true);
    expect(hostDeMetadadosPermitido('claude.ai.evil.com')).toBe(false);
    expect(hostDeMetadadosPermitido('evilclaude.ai')).toBe(false);
    expect(hostDeMetadadosPermitido('169.254.169.254')).toBe(false);
  });
  it('a lista pode ser trocada pelo ambiente', () => {
    process.env.CHRONOS_OAUTH_CIMD_HOSTS = 'exemplo.com';
    expect(hostDeMetadadosPermitido('claude.ai')).toBe(false);
    expect(hostDeMetadadosPermitido('app.exemplo.com')).toBe(true);
  });
});

describe('Temporario', () => {
  afterEach(() => vi.useRealTimers());
  it('tirar consome: o codigo vale uma vez', () => {
    const t = new Temporario<number>(60_000);
    t.guardar('c', 1);
    expect(t.tirar('c')).toBe(1);
    expect(t.tirar('c')).toBeNull();
  });
  it('expira', () => {
    vi.useFakeTimers();
    const t = new Temporario<number>(1000);
    t.guardar('c', 1);
    vi.advanceTimersByTime(1001);
    expect(t.ver('c')).toBeNull();
  });
  it('tem teto de tamanho', () => {
    const t = new Temporario<number>(60_000, 2);
    t.guardar('a', 1);
    t.guardar('b', 2);
    t.guardar('c', 3);
    expect(t.ver('a')).toBeNull();
    expect(t.ver('c')).toBe(3);
  });
});

it('escapa o que vai para o HTML da autorizacao', () => {
  expect(esc('<script>"x"&\'')).toBe('&#60;script&#62;&#34;x&#34;&#38;&#39;');
});
