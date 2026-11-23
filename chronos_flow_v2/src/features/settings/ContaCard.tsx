import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, LogOut, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AuthEstado } from '@shared/types';
import { api, ApiError } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AUTH_KEY, useSair } from '@/features/auth/AuthGate';
import { ServidorAtual } from '@/features/auth/ServidorAtual';

/** Conta, senha e os tokens que o MCP usa para falar em nome desta conta. */
export function ContaCard() {
  const queryClient = useQueryClient();
  const estado = queryClient.getQueryData<AuthEstado>(AUTH_KEY);
  const sair = useSair();

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          Conta e acesso
          <Button size="sm" variant="outline" onClick={() => sair.mutate()} disabled={sair.isPending}>
            <LogOut className="h-3.5 w-3.5" />
            Sair
          </Button>
        </CardTitle>
        <CardDescription>
          {estado?.usuario
            ? `${estado.usuario.name} · ${estado.usuario.email ?? 'sem e-mail'}${
                estado.usuario.dono
                  ? ' · dona do servidor (sempre admin)'
                  : estado.usuario.papel === 'ADMIN'
                    ? ' · administrador'
                    : ''
              }`
            : 'Sua conta neste servidor.'}
        </CardDescription>
        {estado?.usuario?.papel === 'MEMBRO' && (
          <p className="text-xs text-muted-foreground">
            Os administradores deste servidor conseguem ver e editar seus projetos. O que eles mudarem aparece na
            atividade da tarefa com o nome deles.
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <ServidorAtual className="justify-start" />
        <TrocarSenha />
        <ConectarAoClaude />
        <TokensDeApi />
      </CardContent>
    </Card>
  );
}

function TrocarSenha() {
  const queryClient = useQueryClient();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');

  const trocar = useMutation({
    mutationFn: () => api.trocarSenha(atual, nova),
    onSuccess: (res) => {
      setAtual('');
      setNova('');
      const partes = [
        res.sessoesEncerradas > 0 ? `${res.sessoesEncerradas} outra(s) sessao(oes) encerrada(s).` : null,
        res.tokensRevogados > 0
          ? `${res.tokensRevogados} token(s) de API revogado(s): gere outro para o MCP.`
          : null,
      ].filter(Boolean);
      toast.success('Senha trocada.', { description: partes.join(' ') || undefined });
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        trocar.mutate();
      }}
      className="space-y-2"
    >
      <div className="text-sm font-medium">Trocar senha</div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <Label htmlFor="senha-atual" className="sr-only">
            Senha atual
          </Label>
          <Input
            id="senha-atual"
            type="password"
            autoComplete="current-password"
            placeholder="Senha atual"
            value={atual}
            onChange={(e) => setAtual(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="senha-nova" className="sr-only">
            Nova senha
          </Label>
          <Input
            id="senha-nova"
            type="password"
            autoComplete="new-password"
            placeholder="Nova senha (8+)"
            minLength={8}
            value={nova}
            onChange={(e) => setNova(e.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={trocar.isPending}>
          Trocar
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Os outros aparelhos saem na hora, e os tokens de API sao revogados.
      </p>
    </form>
  );
}

/**
 * O MCP remoto: o Claude da web e do celular fala com este servidor em
 * `/mcp`, com a autorizacao que a pessoa da no proprio Chronos (OAuth). A
 * origem e a desta tela: no app desktop, a do servidor escolhido.
 */
function ConectarAoClaude() {
  const url = `${window.location.origin}/mcp`;
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
    } catch {
      toast.error('Nao deu para copiar. Selecione o endereco e copie na mao.');
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Claude na web e no celular</div>
      <p className="text-xs text-muted-foreground">
        No claude.ai, va em Configuracoes &rarr; Conectores &rarr; Adicionar conector personalizado, cole este endereco e
        entre com a sua conta do Chronos. Depois o conector aparece tambem no app do Claude no celular.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
        <Button type="button" variant="outline" onClick={copiar}>
          {copiado ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copiado ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        A autorizacao aparece em Tokens de API como "Conector: ...". Revogar desconecta o Claude na hora.
      </p>
    </div>
  );
}

function TokensDeApi() {
  const queryClient = useQueryClient();
  const [nome, setNome] = useState('');
  const [novo, setNovo] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);
  const { data: tokens = [] } = useQuery({ queryKey: ['api-tokens'], queryFn: api.tokens });

  const criar = useMutation({
    mutationFn: () => api.criarToken(nome),
    onSuccess: (res) => {
      setNome('');
      setNovo(res.token);
      setCopiado(false);
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  const revogar = useMutation({
    mutationFn: (id: string) => api.revogarToken(id),
    onSuccess: () => {
      toast.success('Token revogado. Quem usava ele perde o acesso na hora.');
      queryClient.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (e: ApiError) => toast.error(e.message),
  });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4" />
        Tokens de API
      </div>
      <p className="text-[11px] text-muted-foreground">
        Para o MCP e scripts. Passe em <code className="font-mono">CHRONOS_TOKEN</code>: o agente le e
        escreve nesta conta.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (nome.trim()) criar.mutate();
        }}
        className="flex gap-2"
      >
        <Input
          placeholder="Nome (ex.: Claude no notebook)"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          maxLength={80}
        />
        <Button type="submit" variant="outline" disabled={!nome.trim() || criar.isPending}>
          <Plus className="h-3.5 w-3.5" />
          Criar
        </Button>
      </form>

      {novo && (
        <div className="rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-xs">
          <p className="mb-2 font-medium">Copie agora: este token nao aparece de novo.</p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 font-mono">{novo}</code>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                await navigator.clipboard.writeText(novo);
                setCopiado(true);
              }}
            >
              {copiado ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copiado ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y rounded-md border">
          {tokens.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{t.name}</div>
                <div className="text-muted-foreground">
                  <code className="font-mono">{t.prefix}…</code> · criado{' '}
                  {formatRelativeTime(t.created_at)} ·{' '}
                  {t.last_used_at ? `usado ${formatRelativeTime(t.last_used_at)}` : 'nunca usado'}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Revogar o token ${t.name}`}
                title="Revogar"
                onClick={() => revogar.mutate(t.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
