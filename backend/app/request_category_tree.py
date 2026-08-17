from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ServiceRequestCategory


@dataclass
class CategoryTreeNode:
    id: int
    parent_id: int | None
    name: str
    path: str
    sort_order: int
    children: list[CategoryTreeNode] = field(default_factory=list)


def category_path(row: ServiceRequestCategory, by_id: dict[int, ServiceRequestCategory]) -> str:
    parts: list[str] = []
    cur: ServiceRequestCategory | None = row
    seen: set[int] = set()
    while cur is not None:
        if cur.id in seen:
            break
        seen.add(cur.id)
        parts.append(cur.name.strip())
        if cur.parent_id is None:
            break
        cur = by_id.get(cur.parent_id)
    parts.reverse()
    return " > ".join(p for p in parts if p)


def build_category_tree(rows: list[ServiceRequestCategory]) -> list[CategoryTreeNode]:
    by_id = {r.id: r for r in rows}
    children_map: dict[int | None, list[ServiceRequestCategory]] = {}
    for r in rows:
        children_map.setdefault(r.parent_id, []).append(r)
    for kids in children_map.values():
        kids.sort(key=lambda x: (x.sort_order, x.name.lower()))

    def walk(row: ServiceRequestCategory) -> CategoryTreeNode:
        return CategoryTreeNode(
            id=row.id,
            parent_id=row.parent_id,
            name=row.name,
            path=category_path(row, by_id),
            sort_order=row.sort_order,
            children=[walk(ch) for ch in children_map.get(row.id, [])],
        )

    return [walk(r) for r in children_map.get(None, [])]


def collect_category_paths(nodes: list[CategoryTreeNode]) -> list[str]:
    out: list[str] = []

    def visit(n: CategoryTreeNode) -> None:
        if n.path.strip():
            out.append(n.path)
        for ch in n.children:
            visit(ch)

    for root in nodes:
        visit(root)
    return out


async def insert_paths_into_session(db: AsyncSession, paths: list[str]) -> None:
    """Создаёт узлы дерева из списка полных путей (legacy «A > B»)."""
    id_by_full: dict[str, int] = {}
    order = 0
    for raw in sorted(paths, key=lambda s: len(s)):
        parts = [p.strip() for p in raw.split(">") if p.strip()]
        if not parts:
            continue
        parent_full: str | None = None
        for i, part in enumerate(parts):
            full = " > ".join(parts[: i + 1])
            if full in id_by_full:
                parent_full = full
                continue
            parent_id = id_by_full.get(parent_full) if parent_full else None
            row = ServiceRequestCategory(name=part[:128], parent_id=parent_id, sort_order=order)
            db.add(row)
            await db.flush()
            id_by_full[full] = row.id
            order += 1
            parent_full = full


def tree_node_to_schema(node: CategoryTreeNode) -> dict:
    return {
        "id": node.id,
        "parent_id": node.parent_id,
        "name": node.name,
        "path": node.path,
        "sort_order": node.sort_order,
        "children": [tree_node_to_schema(ch) for ch in node.children],
    }
