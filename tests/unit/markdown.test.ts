import { describe, expect, it } from 'vitest';
import { splitTodo } from '../../src/lib/markdown/todo-plugin.mjs';

describe('TODO-Markierung im Markdown', () => {
  it('zerlegt Text in Text und <mark class="todo">', () => {
    const parts: any[] = splitTodo('Abholung: [TODO: Abholzeiten] und [prüfen] fertig')!;
    expect(parts.map((p: any) => (p.type === 'text' ? p.value : `<${p.children[0].value}>`))).toEqual([
      'Abholung: ',
      '<TODO: Abholzeiten>',
      ' und ',
      '<prüfen>',
      ' fertig',
    ]);
    expect(parts[1].properties.className).toEqual(['todo']);
  });
  it('lässt normalen Text in Ruhe', () => {
    expect(splitTodo('Jeden Samstag [offen]')).toBeNull();
  });
});
