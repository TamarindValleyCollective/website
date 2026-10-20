import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, parseMarkdown, toHtml, toPlain, linksIn, linkAt, toggleMark, setLink, removeLink } from './member-markdown.mjs';

test('normalizeUrl adds https and refuses anything that is not a web address', () => {
  assert.deepEqual(normalizeUrl('linkedin.com/in/asha-test'), { ok: true, url: 'https://linkedin.com/in/asha-test' });
  assert.equal(normalizeUrl('  https://example.com/a  ').url, 'https://example.com/a');
  assert.equal(normalizeUrl('javascript:alert(1)').ok, false);
  assert.equal(normalizeUrl('mailto:a@b.com').ok, false);
  assert.equal(normalizeUrl('two words.com').ok, false);
  assert.equal(normalizeUrl('localhost').ok, false);
  assert.equal(normalizeUrl('').ok, false);
  assert.equal(normalizeUrl('https://user:pw@example.com').ok, false);
  assert.equal(normalizeUrl('https://example.com/' + 'a'.repeat(300)).ok, false);
});

test('normalizeUrl writes brackets and parentheses as codes so they cannot end a link early', () => {
  assert.equal(normalizeUrl('https://en.example.org/wiki/Tea_(drink)').url, 'https://en.example.org/wiki/Tea_%28drink%29');
});

test('bold, italic, links and line breaks', () => {
  const html = toHtml('**Asha** works on *soil*. See [her page](https://example.com/asha).\nNext line.\n\nSecond paragraph.');
  assert.equal(html, '<strong>Asha</strong> works on <em>soil</em>. See <a href="https://example.com/asha" target="_blank" rel="noopener noreferrer nofollow">her page</a>.<br>Next line.<br><br>Second paragraph.');
});

test('plain text with no marks comes out unchanged, and HTML is never passed through', () => {
  assert.equal(toHtml('Asha works at <b>Acme</b> & Sons.'), 'Asha works at &lt;b&gt;Acme&lt;/b&gt; &amp; Sons.');
  assert.equal(toHtml('3 * 4 = 12 and snake_case_name'), '3 * 4 = 12 and snake_case_name');
});

test('a link needs a real https address; anything else stays as the typed text', () => {
  assert.equal(toHtml('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
  assert.equal(toHtml('[x](example.com)'), '[x](example.com)');
  assert.equal(toHtml('[x](https://localhost/a)'), '[x](https://localhost/a)');
  assert.match(toHtml('[x](https://example.com/a)'), /<a href="https:\/\/example.com\/a"/);
});

test('an address with quotes cannot break out of the attribute', () => {
  const html = toHtml('[x](https://example.com/"onmouseover="alert(1))');
  assert.ok(!html.includes('"onmouseover'));
});

test('unmatched marks are just characters, and a backslash escapes one', () => {
  assert.equal(toHtml('**open and never closed'), '**open and never closed');
  assert.equal(toHtml('a \\*star\\* here'), 'a *star* here');
  assert.equal(toHtml('** spaced **'), '** spaced **');
});

test('the text of a link can be bold but a link cannot contain a link', () => {
  assert.match(toHtml('[**Asha**](https://example.com/a)'), /<a [^>]*><strong>Asha<\/strong><\/a>/);
  assert.equal(linksIn('[a [b](https://example.com/b)](https://example.com/a)').length >= 1, true);
});

test('textHtml lets a caller decorate plain pieces without touching links or marks', () => {
  const html = toHtml('Asha and [Ben](https://example.com/b)', { textHtml: (s) => s.replace(/Asha/g, '<span>Asha</span>') });
  assert.equal(html, '<span>Asha</span> and <a href="https://example.com/b" target="_blank" rel="noopener noreferrer nofollow">Ben</a>');
});

test('toPlain drops the marks and joins lines', () => {
  assert.equal(toPlain('**Asha** works on [soil](https://example.com/s).\n\nNext.'), 'Asha works on soil. Next.');
  assert.equal(toPlain(''), '');
});

test('linksIn lists each link with its words and address', () => {
  assert.deepEqual(linksIn('[Asha](https://example.com/a) and [Ben](https://example.com/b)'), [
    { label: 'Asha', href: 'https://example.com/a' },
    { label: 'Ben', href: 'https://example.com/b' },
  ]);
});

test('linkAt finds the link the cursor or selection is in', () => {
  const v = 'Hi [Asha](https://example.com/a) there';
  assert.equal(linkAt(v, 6)?.label, 'Asha');
  assert.equal(linkAt(v, 4, 8)?.label, 'Asha');
  assert.equal(linkAt(v, 1), null);
  assert.equal(linkAt(v, 1, 10), null);
});

test('toggleMark wraps the selection and unwraps it again', () => {
  const on = toggleMark('Asha works', 0, 4, '**');
  assert.deepEqual(on, { value: '**Asha** works', from: 2, to: 6 });
  assert.deepEqual(toggleMark(on.value, on.from, on.to, '**'), { value: 'Asha works', from: 0, to: 4 });
});

test('setLink wraps the selection, edits an existing link, and removeLink keeps the words', () => {
  const added = setLink('Asha works', 0, 4, 'https://example.com/a');
  assert.equal(added.value, '[Asha](https://example.com/a) works');
  assert.equal(added.value.slice(added.from, added.to), '[Asha](https://example.com/a)');
  const changed = setLink(added.value, 2, 2, 'https://example.com/new');
  assert.equal(changed.value, '[Asha](https://example.com/new) works');
  assert.equal(removeLink(changed.value, 2, 2).value, 'Asha works');
  // brackets in the selected words would break the link, so they are left out of it
  assert.equal(setLink('a [b] c', 2, 5, 'https://example.com/x').value, 'a [b](https://example.com/x) c');
});

test('parseMarkdown of nothing is nothing', () => {
  assert.deepEqual(parseMarkdown('  \n '), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});
