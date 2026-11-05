export interface TreeNode {
  name: string;
  path: string;
  children?: TreeNode[];
}

/** Build a sorted folder tree (folders first, then files, alphabetical) from flat paths. */
export function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", children: [] };
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");
      node.children ??= [];
      let next = node.children.find((c) => c.name === part && !!c.children === !isFile);
      if (!next) {
        next = isFile ? { name: part, path } : { name: part, path, children: [] };
        node.children.push(next);
      }
      node = next;
    });
  }
  const sort = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => (!!a.children === !!b.children ? a.name.localeCompare(b.name) : a.children ? -1 : 1))
      .map((n) => (n.children ? { ...n, children: sort(n.children) } : n));
  return sort(root.children ?? []);
}

/** Validate a user-entered file path the same way the API does. */
export function validPath(p: string): boolean {
  return p.length > 0 && p.length <= 400 && !p.includes("..") && !p.startsWith("/") && !p.includes("\0") && !/\/$/.test(p);
}
