# Servidor MCP — Chronos Flow v2

Ferramentas que expoem a arvore recursiva a agentes de IA. O conjunto e menor
que o da v1 porque a arvore permite composicao: `break_down` + `get_focus_queue`
fazem o que antes exigia uma dezena de chamadas.

| Ferramenta | O que faz |
| --- | --- |
| `get_tree` | Subarvore ate uma profundidade, com filtros |
| `get_node` | Um no com ancestrais, filhas e dependencias |
| `create_node` | Cria no em qualquer nivel |
| `break_down` | Quebra um no em varias filhas numa chamada |
| `complete_leaf` | Conclui e devolve a cascata resultante |
| `get_focus_queue` | Fila do dia com impacto por item |
| `simulate` | Projecao de progresso para um conjunto de folhas |
| `assign` | Delega e reporta a carga do membro |
| `get_risk_map` | Diagnostico por ramificacao |
| `list_spaces` | Espacos com id, cor e progresso |
| `list_members` | Membros com id e carga (para `assignee_id`) |
| `update_node` | Edita titulo, descricao, responsavel, datas, estimativa, criticidade |
| `set_status` | Muda o status como no Kanban (conclui com cascata, reabre ancestrais) |
| `add_update` | Publica uma atualizacao em markdown no feed da tarefa |
| `list_updates` | Le o feed de atualizacoes de uma tarefa |
| `edit_update` | Reescreve uma atualizacao publicada |

## Como funciona

O servidor fala MCP por stdio e nao toca no banco: ele chama a API REST local,
para que a logica de cascata e prioridade viva num lugar so. Por isso **a API
precisa estar rodando** (`npm run dev:server`, ou o app desktop aberto).

## MCP remoto (Claude na web e no celular)

O servidor do Chronos tambem atende MCP em `https://<seu-servidor>/mcp`
(transporte Streamable HTTP, sem sessao), com as mesmas ferramentas. E o que o
Claude da web, do desktop e do celular usam: eles falam com servidores MCP
remotos a partir da nuvem da Anthropic, entao o servidor precisa estar
acessivel pela internet, em HTTPS.

1. No claude.ai, va em Configuracoes > Conectores > Adicionar conector
   personalizado e cole `https://<seu-servidor>/mcp`.
2. O Claude abre a tela de autorizacao do Chronos: entre com a sua conta e
   clique em Permitir.
3. Pronto: o conector aparece tambem no app do Claude no celular.

A autorizacao e OAuth 2.1 (registro automatico do cliente, PKCE S256,
codigo de uso unico). O Claude recebe um token de API comum, que aparece em
Configuracoes > Conta e acesso > Tokens de API como "Conector: ...": le e
escreve os projetos da conta, mas nao mexe em senha, tokens nem
administracao. Revogar ali desconecta o Claude na hora.

Atras de proxy ou tunel, o servidor descobre o proprio endereco pelos
cabecalhos `X-Forwarded-Proto`/`X-Forwarded-Host`; se o proxy nao os mandar,
defina `CHRONOS_URL_PUBLICA=https://<seu-servidor>`.

## Configurar no cliente

Use `npx tsx mcp/server.ts`, e **nao** `npm run mcp`: o npm escreve o
cabecalho `> chronos-flow-v2@2.0.0 mcp` na saida padrao, que e o canal do
protocolo, e o cliente recebe lixo antes do primeiro JSON. Se preferir o
script, use `npm run -s mcp` (o `-s` silencia o npm).

Claude Code:

A API exige login, entao o MCP precisa de um **token de API**: crie em
Configuracoes > Conta e acesso > Tokens de API (ele aparece uma vez so).

```bash
claude mcp add chronos -e CHRONOS_TOKEN=chr_... -- npx tsx /caminho/para/chronos_flow_v2/mcp/server.ts
```

Claude Desktop e outros clientes com arquivo de configuracao:

```json
{
  "mcpServers": {
    "chronos": {
      "command": "npx",
      "args": ["tsx", "/caminho/para/chronos_flow_v2/mcp/server.ts"],
      "env": { "CHRONOS_TOKEN": "chr_..." }
    }
  }
}
```

## Variaveis de ambiente

| Variavel | Padrao | Para que serve |
| --- | --- | --- |
| `CHRONOS_API` | `http://localhost:3101/api` | Endereco da API |
| `CHRONOS_TOKEN` | vazio | Token de API da sua conta (obrigatorio). Os dados lidos e escritos sao os dessa conta |
