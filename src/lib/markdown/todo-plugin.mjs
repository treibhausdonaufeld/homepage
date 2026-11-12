/**
 * Sätteri-Plugin (hast): markiert offene Punkte „[TODO: …]“ und „[prüfen]“ in Markdown
 * gelb als <mark class="todo">.
 */
const RE = /\[(TODO[^\]]*|prüfen)\]/g;

/** Text in Text- und mark-Knoten zerlegen; null, wenn nichts zu markieren ist. */
export function splitTodo(value) {
  const out = [];
  let last = 0;
  for (const m of value.matchAll(RE)) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push({
      type: 'element',
      tagName: 'mark',
      properties: { className: ['todo'] },
      children: [{ type: 'text', value: m[1] }],
    });
    last = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

export const todoPlugin = {
  name: 'treibhaus-todo',
  text(node, ctx) {
    const parts = splitTodo(node.value);
    if (parts) ctx.replaceNode(node, parts);
  },
};
