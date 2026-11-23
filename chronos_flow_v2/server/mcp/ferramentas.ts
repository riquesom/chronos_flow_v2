/**
 * As ferramentas do MCP do Chronos. As mesmas para o MCP local (stdio, no
 * computador de quem usa) e para o remoto (`/mcp`, que o Claude da web e do
 * celular alcancam): cada ferramenta e uma chamada a API REST, entao a logica
 * de cascata, prioridade e dono dos dados vive num lugar so.
 *
 * Quem chama decide como a requisicao sai (`Chamar`): o local vai pela rede
 * com o token do .env; o remoto, com o token da pessoa que autorizou o Claude.
 */

export interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  run: (args: Record<string, any>) => Promise<unknown>;
}

/** Faz a chamada a API (`/nodes/...`) e devolve o corpo, ou lanca com a mensagem do servidor. */
export type Chamar = (path: string, init?: RequestInit) => Promise<any>;

/**
 * Um id vira um pedaco de URL, codificado. Os argumentos vem do modelo, e um
 * "id" como `../ai/settings` mudaria a rota chamada.
 */
export const seg = (valor: unknown) => encodeURIComponent(String(valor ?? ''));

export const CAMPOS_DO_NO = [
  'title',
  'description',
  'assignee_id',
  'start_date',
  'due_date',
  'estimated_minutes',
  'importance',
];


export function criarFerramentas(call: Chamar): Tool[] {
  return [
    {
      name: 'get_tree',
      description: 'Subarvore de metas e tarefas ate uma profundidade, com filtros opcionais.',
      inputSchema: {
        type: 'object',
        properties: {
          rootId: { type: 'string', description: 'Meta macro a partir da qual ler' },
          spaceId: { type: 'string' },
          assigneeId: { type: 'string' },
          maxDepth: { type: 'number', description: 'Niveis abaixo da raiz (padrao 2)' },
          status: { type: 'string', description: 'Lista separada por virgula' },
        },
      },
      run: (args) => call(`/nodes/tree?${new URLSearchParams(args as any)}`),
    },
    {
      name: 'get_node',
      description:
        'Um no com ancestrais, filhas, dependencias e atividade recente. ' +
        '`updates_count` diz quantas atualizacoes ele tem (leia com list_updates).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args) => call(`/nodes/${seg(args.id)}`),
    },
    {
      name: 'create_node',
      description: 'Cria um no em qualquer nivel. Sem parent_id, vira uma nova meta macro.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          parent_id: { type: 'string' },
          space_id: { type: 'string' },
          assignee_id: { type: 'string' },
          estimated_minutes: { type: 'number' },
          due_date: { type: 'string', description: 'ISO 8601' },
          importance: { type: 'number', description: '1 a 5' },
        },
        required: ['title'],
      },
      run: (args) => call('/nodes', { method: 'POST', body: JSON.stringify(args) }),
    },
    {
      name: 'break_down',
      description:
        'Quebra um no em varias subtarefas numa chamada. As filhas herdam o prazo do pai e dividem o peso na cascata.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          children: {
            type: 'array',
            description: 'Subtarefas a criar como filhas do no',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                assignee_id: { type: 'string' },
                estimated_minutes: { type: 'number' },
                due_date: { type: 'string', description: 'ISO 8601' },
              },
              required: ['title'],
            },
          },
        },
        required: ['id', 'children'],
      },
      run: (args) =>
        call(`/nodes/${seg(args.id)}/breakdown`, {
          method: 'POST',
          body: JSON.stringify({ children: args.children }),
        }),
    },
    {
      name: 'complete_leaf',
      description:
        'Conclui uma tarefa folha e devolve a cascata: quanto cada ancestral subiu e o que foi destravado.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: (args) => call(`/nodes/${seg(args.id)}/complete`, { method: 'POST' }),
    },
    {
      name: 'get_focus_queue',
      description:
        'Fila do dia ordenada por impacto ascendente, com o ganho percentual de cada item na meta macro.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'today | next48 | all' },
          assigneeId: { type: 'string' },
        },
      },
      run: (args) => call(`/focus/queue?${new URLSearchParams(args as any)}`),
    },
    {
      name: 'simulate',
      description: 'Projeta o progresso das metas macro se este conjunto de folhas for concluido.',
      inputSchema: {
        type: 'object',
        properties: { nodeIds: { type: 'array', items: { type: 'string' } } },
        required: ['nodeIds'],
      },
      run: (args) =>
        call('/focus/simulate', { method: 'POST', body: JSON.stringify({ nodeIds: args.nodeIds }) }),
    },
    {
      name: 'assign',
      description: 'Delega um no a um membro da equipe.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, assignee_id: { type: 'string' } },
        required: ['id', 'assignee_id'],
      },
      run: async (args) => {
        const node = await call(`/nodes/${seg(args.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ assignee_id: args.assignee_id }),
        });
        const members = (await call('/members')) as Array<{ id: string; name: string; loadPercent: number }>;
        const member = members.find((m) => m.id === args.assignee_id);
        return { node, member };
      },
    },
    {
      name: 'get_risk_map',
      description: 'Diagnostico de risco por ramificacao da arvore.',
      inputSchema: { type: 'object', properties: {} },
      run: () => call('/reports/risk-map'),
    },
    {
      name: 'list_spaces',
      description: 'Lista os espacos (agrupadores de projetos) com id, cor e progresso.',
      inputSchema: { type: 'object', properties: {} },
      run: () => call('/spaces'),
    },
    {
      name: 'list_members',
      description:
        'Lista os membros da equipe com id, papel e carga atual. Use o id em assignee_id.',
      inputSchema: { type: 'object', properties: {} },
      run: () => call('/members'),
    },
    {
      name: 'update_node',
      description:
        'Edita campos de um no: titulo, descricao, responsavel, datas, estimativa, criticidade. ' +
        'E o que muda as colunas da visao Tabela. Para status use set_status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Texto da tarefa (o que ela e)' },
          assignee_id: { type: ['string', 'null'], description: 'null tira o responsavel' },
          start_date: { type: ['string', 'null'], description: 'ISO 8601' },
          due_date: { type: ['string', 'null'], description: 'ISO 8601' },
          estimated_minutes: { type: ['number', 'null'] },
          importance: { type: 'number', description: '1 (minimo) a 5 (critico)' },
        },
        required: ['id'],
      },
      run: ({ id, ...resto }) => {
        // So os campos do schema: o modelo nao pode mandar campo inventado.
        const body = Object.fromEntries(
          Object.entries(resto).filter(([k]) => CAMPOS_DO_NO.includes(k)),
        );
        return call(`/nodes/${seg(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      },
    },
    {
      name: 'set_status',
      description:
        'Muda o status de um no, como arrastar o cartao no Kanban. COMPLETED numa folha dispara a ' +
        'cascata (igual a complete_leaf); sair de COMPLETED/CANCELLED reabre os ancestrais. ' +
        'BLOCKED nao se define a mao: vem das dependencias.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] },
        },
        required: ['id', 'status'],
      },
      run: (args) =>
        call(`/nodes/${seg(args.id)}/status`, {
          method: 'POST',
          body: JSON.stringify({ status: args.status }),
        }),
    },
    {
      name: 'add_update',
      description:
        'Publica uma atualizacao no feed da tarefa (estilo Monday). O corpo e markdown: titulos, ' +
        'listas, checklists "- [ ]", tabelas, links e codigo. Use para registrar andamento, ' +
        'decisoes e pendencias; a descricao da tarefa fica para o que ela e.',
      inputSchema: {
        type: 'object',
        properties: {
          node_id: { type: 'string' },
          body: { type: 'string', description: 'Markdown' },
          author: {
            type: 'string',
            description: 'Quem assina. Padrao: "IA via MCP"',
          },
        },
        required: ['node_id', 'body'],
      },
      run: (args) =>
        call('/updates', {
          method: 'POST',
          body: JSON.stringify({
            node_id: args.node_id,
            body: args.body,
            author: args.author ?? 'IA via MCP',
          }),
        }),
    },
    {
      name: 'list_updates',
      description: 'Lista as atualizacoes de uma tarefa, a mais nova primeiro, com o markdown cru.',
      inputSchema: {
        type: 'object',
        properties: { node_id: { type: 'string' } },
        required: ['node_id'],
      },
      run: (args) => call(`/updates?${new URLSearchParams({ nodeId: args.node_id })}`),
    },
    {
      name: 'edit_update',
      description: 'Reescreve o markdown de uma atualizacao ja publicada (fica marcada como editada).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, body: { type: 'string', description: 'Markdown' } },
        required: ['id', 'body'],
      },
      run: (args) =>
        call(`/updates/${seg(args.id)}`, { method: 'PATCH', body: JSON.stringify({ body: args.body }) }),
    },
  ];
}
