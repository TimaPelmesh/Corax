import { describe, expect, it } from 'vitest'
import type { RequestCategoryTreeNode } from '../api'
import { collectExpandableIds, countNodes, findSiblingContext } from './SettingsCategoriesPage'

function node(
  id: number,
  name: string,
  children: RequestCategoryTreeNode[] = [],
  sort_order = id,
): RequestCategoryTreeNode {
  return {
    id,
    name,
    path: name,
    parent_id: null,
    sort_order,
    children,
  }
}

describe('collectExpandableIds', () => {
  it('returns only nodes with children', () => {
    const tree = [
      node(1, 'Root', [node(2, 'Child'), node(3, 'Nested', [node(4, 'Leaf')])]),
      node(5, 'Solo'),
    ]
    expect(collectExpandableIds(tree).sort((a, b) => a - b)).toEqual([1, 3])
  })
})

describe('countNodes', () => {
  it('counts all nodes recursively', () => {
    const tree = [node(1, 'A', [node(2, 'B'), node(3, 'C', [node(4, 'D')])])]
    expect(countNodes(tree)).toBe(4)
  })
})

describe('findSiblingContext', () => {
  it('finds siblings at nested level', () => {
    const a = node(10, 'A')
    const b = node(11, 'B')
    const tree = [node(1, 'Root', [a, b])]
    expect(findSiblingContext(tree, 11)).toEqual({ siblings: [a, b], index: 1 })
  })

  it('returns null when missing', () => {
    expect(findSiblingContext([node(1, 'Root')], 99)).toBeNull()
  })
})
