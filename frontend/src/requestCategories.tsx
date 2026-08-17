import type { RequestCategoryTreeNode } from './api'

export function collectCategoryPaths(nodes: RequestCategoryTreeNode[]): string[] {
  const out: string[] = []
  const visit = (n: RequestCategoryTreeNode) => {
    if (n.path.trim()) out.push(n.path)
    for (const ch of n.children) visit(ch)
  }
  for (const root of nodes) visit(root)
  return out
}

export function flattenCategoryNodes(
  nodes: RequestCategoryTreeNode[],
  depth = 0,
): Array<{ node: RequestCategoryTreeNode; depth: number }> {
  const out: Array<{ node: RequestCategoryTreeNode; depth: number }> = []
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (n.children.length) out.push(...flattenCategoryNodes(n.children, depth + 1))
  }
  return out
}

export function filterCategoryTree(
  nodes: RequestCategoryTreeNode[],
  query: string,
): RequestCategoryTreeNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return nodes

  function walk(n: RequestCategoryTreeNode): RequestCategoryTreeNode | null {
    const selfMatch =
      n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
    const kids = n.children.map(walk).filter((x): x is RequestCategoryTreeNode => x !== null)
    if (selfMatch || kids.length) {
      return { ...n, children: kids.length ? kids : n.children }
    }
    return null
  }

  return nodes.map(walk).filter((x): x is RequestCategoryTreeNode => x !== null)
}
