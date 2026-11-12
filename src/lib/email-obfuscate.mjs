/**
 * Schutz von E-Mail-Adressen vor einfachen Sammlern: Im HTML steht die Adresse nie
 * im Klartext. Ein kleines Skript (public/js/email.js) baut daraus Link und Text.
 * Ohne JavaScript bleibt „hallo (at) treibhausdonaufeld.at“ lesbar.
 */

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Adresse umgedreht und base64-kodiert – dekodiert in public/js/email.js. */
export function encodeEmail(address) {
  return Buffer.from([...address].reverse().join(''), 'utf8').toString('base64');
}

/** Lesbare Form ohne „@“ für Menschen ohne JavaScript. */
export function displayEmail(address) {
  return address.replace('@', ' (at) ');
}

/** hast-Element für einen geschützten mailto-Link. */
export function emailElement(address, subject, children) {
  const properties = { className: ['eml'], dataE: encodeEmail(address) };
  if (subject) properties.dataS = subject;
  return {
    type: 'element',
    tagName: 'a',
    properties,
    children: children ?? [
      { type: 'element', tagName: 'span', properties: { className: ['eml-t'] }, children: [{ type: 'text', value: displayEmail(address) }] },
    ],
  };
}

/** Text in Text-Knoten und geschützte Links zerlegen; null, wenn keine Adresse drin ist. */
export function splitEmails(value) {
  const out = [];
  let last = 0;
  for (const m of value.matchAll(EMAIL_RE)) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) });
    out.push(emailElement(m[0]));
    last = m.index + m[0].length;
  }
  if (!out.length) return null;
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

/** mailto:-URL in Adresse und Betreff zerlegen. */
export function parseMailto(href) {
  const [addr, query = ''] = href.replace(/^mailto:/i, '').split('?');
  const subject = new URLSearchParams(query).get('subject') ?? undefined;
  return { address: decodeURIComponent(addr), subject };
}

/** Kindknoten eines mailto-Links: Adressen im Linktext ebenfalls verbergen. */
function protectChildren(children) {
  return children.flatMap((c) => {
    if (c.type === 'text') {
      if (!EMAIL_RE.test(c.value)) return [c];
      EMAIL_RE.lastIndex = 0;
      return [{ type: 'element', tagName: 'span', properties: { className: ['eml-t'] }, children: [{ type: 'text', value: displayEmail(c.value) }] }];
    }
    if (c.children) return [{ ...c, children: protectChildren(c.children) }];
    return [c];
  });
}

/** Sätteri-Plugin (hast): mailto-Links und nackte Adressen in Markdown schützen. */
export const emailPlugin = {
  name: 'treibhaus-email',
  element: {
    filter: ['a'],
    visit(node, ctx) {
      const href = node.properties?.href;
      if (typeof href !== 'string' || !/^mailto:/i.test(href)) return;
      const { address, subject } = parseMailto(href);
      ctx.replaceNode(node, emailElement(address, subject, protectChildren(node.children ?? [])));
    },
  },
  text(node, ctx) {
    const parent = ctx.parent(node);
    if (parent && parent.type === 'element' && parent.tagName === 'a') return;
    const parts = splitEmails(node.value);
    if (parts) ctx.replaceNode(node, parts);
  },
};
