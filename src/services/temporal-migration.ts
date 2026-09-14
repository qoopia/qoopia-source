/**
 * SYSTEM maintenance API для миграции 033 (ТЗ §5.0, R6).
 *
 * НЕ экспонируется через MCP и не достижима из request-пайплайна: функция
 * принимает сырой `Database`, а не `AuthContext`, и не выполняет ни одной
 * проверки видимости. Это осознанно — классификация продакшн-графа по
 * видимости вызывающего (как в `getSupersedeChain`, note-relations.ts:437,
 * через `visibleComponentState`) пропустила бы private-ноты и исказила бы
 * состав компонент и число активных голов.
 *
 * Существующий код непригоден для preflight по двум причинам:
 *   - `supersedeComponent` (note-relations.ts:92) не экспортирован;
 *   - `getSupersedeChain` visibility-scoped.
 *
 * Функция чистая: ни одной записи в БД.
 */
import type { Database } from "bun:sqlite";

export type SupersedeComponentClass = "linear" | "split_head" | "cyclic" | "oversize";

export interface SupersedeComponent {
  workspace_id: string;
  /** ДЕТЕРМИНИРОВАННО: лексикографически минимальный note_id компонента. */
  component_rep: string;
  /** sorted asc */
  node_ids: string[];
  /** sorted asc; узлы, НИКОГДА не являющиеся target supersedes-ребра в этом workspace */
  active_head_ids: string[];
  klass: SupersedeComponentClass;
  /** true, если классификация oversize-компонента была ограничена. */
  truncated: boolean;
}

export interface ClassifySupersedeOptions {
  workspaceId?: string;
  /** default 1000 — совпадает с существующим bound в v4-pipeline.ts:77. */
  maxComponentSize?: number;
}

export const DEFAULT_MAX_COMPONENT_SIZE = 1000;

interface EdgeRow {
  workspace_id: string;
  source_note_id: string;
  target_note_id: string;
}

interface WorkspaceGraph {
  /** неориентированная смежность — обход связных компонент */
  undirected: Map<string, string[]>;
  /** ориентированная смежность source->target — детекция циклов */
  directed: Map<string, string[]>;
  /** множество узлов, являющихся target хотя бы одного ребра в workspace */
  targets: Set<string>;
  /** число ориентированных рёбер, оба конца которых в наборе */
  nodes: Set<string>;
}

function pushEdge(map: Map<string, string[]>, from: string, to: string): void {
  const list = map.get(from);
  if (list) list.push(to);
  else map.set(from, [to]);
}

/**
 * Классифицировать все связные компоненты supersedes-графа.
 *
 * Алгоритм детерминирован и итеративен (явные очереди/стеки, без рекурсии —
 * безопасно для больших графов):
 *   1. читаем сырые рёбра `note_relations.relation_type='supersedes'`;
 *   2. строим неориентированную и ориентированную смежность на workspace
 *      (компоненты не пересекают workspace: рёбра workspace-scoped по FK);
 *   3. связные компоненты — итеративный BFS по неориентированным рёбрам;
 *   4. `nodes+edges > maxComponentSize` -> `oversize`/`truncated`, детекция
 *      цикла не выполняется (backfill такой компонент пропускает); иначе —
 *      итеративный DFS с раскраской white/gray/black по ориентированным
 *      рёбрам, back-edge к gray -> `cyclic`;
 *   5. `active_heads` = узлы компонента вне множества target'ов workspace;
 *      `klass = cyclic | (|active_heads| == 1 ? 'linear' : 'split_head')`.
 *
 * Порядок результата — по `(workspace_id, component_rep)`.
 */
export function classifySupersedeComponents(
  db: Database,
  opts?: ClassifySupersedeOptions,
): SupersedeComponent[] {
  const maxComponentSize = opts?.maxComponentSize ?? DEFAULT_MAX_COMPONENT_SIZE;
  const rows = (
    opts?.workspaceId === undefined
      ? db
          .query(
            `SELECT workspace_id, source_note_id, target_note_id
               FROM note_relations
              WHERE relation_type = 'supersedes'
              ORDER BY workspace_id, source_note_id, target_note_id`,
          )
          .all()
      : db
          .query(
            `SELECT workspace_id, source_note_id, target_note_id
               FROM note_relations
              WHERE relation_type = 'supersedes' AND workspace_id = ?
              ORDER BY workspace_id, source_note_id, target_note_id`,
          )
          .all(opts.workspaceId)
  ) as EdgeRow[];

  const graphs = new Map<string, WorkspaceGraph>();
  for (const row of rows) {
    let graph = graphs.get(row.workspace_id);
    if (!graph) {
      graph = {
        undirected: new Map(),
        directed: new Map(),
        targets: new Set(),
        nodes: new Set(),
      };
      graphs.set(row.workspace_id, graph);
    }
    pushEdge(graph.undirected, row.source_note_id, row.target_note_id);
    pushEdge(graph.undirected, row.target_note_id, row.source_note_id);
    pushEdge(graph.directed, row.source_note_id, row.target_note_id);
    graph.targets.add(row.target_note_id);
    graph.nodes.add(row.source_note_id);
    graph.nodes.add(row.target_note_id);
  }

  const out: SupersedeComponent[] = [];
  for (const workspaceId of [...graphs.keys()].sort()) {
    const graph = graphs.get(workspaceId)!;
    const seen = new Set<string>();
    // Стартовые узлы перебираются в отсортированном порядке — состав компонент
    // от порядка не зависит, но детерминизм обхода упрощает воспроизведение.
    for (const start of [...graph.nodes].sort()) {
      if (seen.has(start)) continue;
      const component = collectComponent(graph, start, seen);
      out.push(classifyComponent(workspaceId, graph, component, maxComponentSize));
    }
  }
  out.sort((a, b) =>
    a.workspace_id === b.workspace_id
      ? a.component_rep < b.component_rep
        ? -1
        : a.component_rep > b.component_rep
          ? 1
          : 0
      : a.workspace_id < b.workspace_id
        ? -1
        : 1,
  );
  return out;
}

/** Итеративный BFS по неориентированным рёбрам. Без рекурсии. */
function collectComponent(
  graph: WorkspaceGraph,
  start: string,
  seen: Set<string>,
): Set<string> {
  const component = new Set<string>([start]);
  seen.add(start);
  const queue: string[] = [start];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++]!;
    for (const next of graph.undirected.get(current) ?? []) {
      if (component.has(next)) continue;
      component.add(next);
      seen.add(next);
      queue.push(next);
    }
  }
  return component;
}

function classifyComponent(
  workspaceId: string,
  graph: WorkspaceGraph,
  component: Set<string>,
  maxComponentSize: number,
): SupersedeComponent {
  const nodeIds = [...component].sort();
  let edgeCount = 0;
  for (const node of nodeIds) {
    for (const target of graph.directed.get(node) ?? []) {
      if (component.has(target)) edgeCount++;
    }
  }
  const activeHeadIds = nodeIds.filter((id) => !graph.targets.has(id));
  const base = {
    workspace_id: workspaceId,
    component_rep: nodeIds[0]!,
    node_ids: nodeIds,
    active_head_ids: activeHeadIds,
  };

  if (nodeIds.length + edgeCount > maxComponentSize) {
    // Обход неориентированного графа доводится до конца, чтобы
    // `component_rep` и `node_ids` оставались детерминированными; ограничена
    // именно классификация — детекция цикла не выполняется, компонент
    // помечается `oversize` и backfill его пропускает (conservative).
    return { ...base, klass: "oversize", truncated: true };
  }

  if (hasDirectedCycle(graph, component, nodeIds)) {
    return { ...base, klass: "cyclic", truncated: false };
  }
  return {
    ...base,
    klass: activeHeadIds.length === 1 ? "linear" : "split_head",
    truncated: false,
  };
}

const WHITE = 0;
const GRAY = 1;
const BLACK = 2;

/** Итеративный DFS с раскраской. back-edge к gray-узлу => цикл. */
function hasDirectedCycle(
  graph: WorkspaceGraph,
  component: Set<string>,
  nodeIds: string[],
): boolean {
  const color = new Map<string, number>();
  for (const id of nodeIds) color.set(id, WHITE);
  for (const root of nodeIds) {
    if (color.get(root) !== WHITE) continue;
    // Кадр стека: узел + позиция следующего необработанного соседа.
    const stack: Array<{ node: string; index: number }> = [{ node: root, index: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const neighbours = graph.directed.get(frame.node) ?? [];
      if (frame.index >= neighbours.length) {
        color.set(frame.node, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbours[frame.index++]!;
      if (!component.has(next)) continue;
      const state = color.get(next);
      if (state === GRAY) return true;
      if (state === WHITE) {
        color.set(next, GRAY);
        stack.push({ node: next, index: 0 });
      }
    }
  }
  return false;
}
