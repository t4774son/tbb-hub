// The admin's story, from plain text to a small token tree. No DOM in here, so the same code runs in the server
// tests and in the admin's editor preview. Paragraphs come from blank lines; inside a paragraph only **bold**,
// *italic* and https:// links mean anything. Nothing is ever HTML.
const INLINE = /\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|\*([^*\s][^*\n]*?)\*|https:\/\/[^\s<>"'*]+[^\s<>"'.,;:!?)\]*]/g;

function inline(s, nested = false) {
  const out = []; let i = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > i) out.push({ t: 'text', v: s.slice(i, m.index) });
    if (m[1] !== undefined) out.push({ t: 'b', v: nested ? [{ t: 'text', v: m[1] }] : inline(m[1], true) });
    else if (m[2] !== undefined) out.push({ t: 'i', v: nested ? [{ t: 'text', v: m[2] }] : inline(m[2], true) });
    else out.push({ t: 'a', href: m[0], v: m[0].replace(/^https:\/\//, '') });
    i = m.index + m[0].length;
  }
  if (i < s.length) out.push({ t: 'text', v: s.slice(i) });
  return out;
}

// → [paragraph, ...]; a paragraph is a list of {t:'text'|'b'|'i'|'a', ...} tokens. Single line breaks stay inside the text.
export function parseStory(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean).map((p) => inline(p));
}
