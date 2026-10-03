/** Supersede-relation graphs for the V4 backfill and its verifier: one implementation for both. */

const link = (map: Map<string, Set<string>>, from: string, to: string) => {
  const set = map.get(from) ?? new Set<string>();
  set.add(to);
  map.set(from, set);
};

/** One workspace's edges: `adjacency` source -> targets (every node is a key), `undirected` both ways. */
export function relationGraph() {
  const adjacency = new Map<string, Set<string>>();
  const undirected = new Map<string, Set<string>>();
  const connect = (source: string, target: string) => {
    link(adjacency, source, target);
    if (!adjacency.has(target)) adjacency.set(target, new Set());
    link(undirected, source, target);
    link(undirected, target, source);
  };
  return { adjacency, undirected, connect };
}

export function hasPath(start: string, goal: string, adjacency: Map<string, Set<string>>): boolean {
  const pending = [start];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === goal) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

/** Connected components of the undirected view, in first-seen order. */
export function* components(undirected: Map<string, Set<string>>): Generator<Set<string>> {
  const visited = new Set<string>();
  for (const start of undirected.keys()) {
    if (visited.has(start)) continue;
    const component = new Set<string>();
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (component.has(current)) continue;
      component.add(current);
      visited.add(current);
      for (const next of undirected.get(current) ?? []) pending.push(next);
    }
    yield component;
  }
}
