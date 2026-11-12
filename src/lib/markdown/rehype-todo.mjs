/**
 * Markiert offene Punkte „[TODO: …]“ und „[prüfen]“ in Markdown gelb (<mark class="todo">).
 */
const RE = /\[(TODO[^\]]*|prüfen)\]/g;

function transform(node) {
  if (!node.children) return;
  const out = [];
  for (const child of node.children) {
    if (child.type === 'text' && RE.test(child.value)) {
      RE.lastIndex = 0;
      let last = 0;
      let m;
      while ((m = RE.exec(child.value))) {
        if (m.index > last) out.push({ type: 'text', value: child.value.slice(last, m.index) });
        out.push({
          type: 'element',
          tagName: 'mark',
          properties: { className: ['todo'] },
          children: [{ type: 'text', value: m[1] }],
        });
        last = m.index + m[0].length;
      }
      if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) });
    } else {
      transform(child);
      out.push(child);
    }
  }
  node.children = out;
}

export default function rehypeTodo() {
  return (tree) => transform(tree);
}
