// The story parser: paragraphs, bold, italic, https links; everything else is plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStory } from '../../public/js/storytext.js';

test('paragraphs from blank lines; single line breaks stay in the text; empty input → no paragraphs', () => {
  assert.deepEqual(parseStory(''), []); assert.deepEqual(parseStory(null), []); assert.deepEqual(parseStory('  \n\n  '), []);
  assert.deepEqual(parseStory('one\ntwo\n\n\nthree\r\n\r\nfour  '), [[{ t: 'text', v: 'one\ntwo' }], [{ t: 'text', v: 'three' }], [{ t: 'text', v: 'four' }]]);
});

test('bold, italic and https links; a link inside bold; stray stars are just text', () => {
  assert.deepEqual(parseStory('I **bought** the *dip* at https://example.com/x.'), [[
    { t: 'text', v: 'I ' }, { t: 'b', v: [{ t: 'text', v: 'bought' }] }, { t: 'text', v: ' the ' }, { t: 'i', v: [{ t: 'text', v: 'dip' }] },
    { t: 'text', v: ' at ' }, { t: 'a', href: 'https://example.com/x', v: 'example.com/x' }, { t: 'text', v: '.' }]]);
  assert.deepEqual(parseStory('**see https://example.com**'), [[{ t: 'b', v: [{ t: 'text', v: 'see ' }, { t: 'a', href: 'https://example.com', v: 'example.com' }] }]]);
  assert.deepEqual(parseStory('5 * 3 = 15 and ** alone'), [[{ t: 'text', v: '5 * 3 = 15 and ** alone' }]]);
  assert.deepEqual(parseStory('*see https://example.com now*'), [[{ t: 'i', v: [{ t: 'text', v: 'see ' }, { t: 'a', href: 'https://example.com', v: 'example.com' }, { t: 'text', v: ' now' }] }]], 'link inside italic');
  assert.deepEqual(parseStory('**a *b* c**'), [[{ t: 'b', v: [{ t: 'text', v: 'a ' }, { t: 'i', v: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }] }]], 'italic inside bold, one level deep');
});

test('never HTML, never non-https links', () => {
  const out = parseStory('<b>x</b> http://example.com javascript:alert(1) <script>');
  assert.deepEqual(out, [[{ t: 'text', v: '<b>x</b> http://example.com javascript:alert(1) <script>' }]]);
  assert.ok(JSON.stringify(out).includes('<b>'), 'markup kept as text, to be shown literally');
});
