// mend: applies AI-written edits (unified diff, SEARCH/REPLACE, V4A, JSON)
// to a tree of text files. Node 22 stdlib only. See SPEC.md.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { writeSync } from 'node:fs';
import { dirname } from 'node:path';

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface Fail {
  code: string;
  path: string;
}

interface FileState {
  lines: string[];
  brk: '\n' | '\r\n';
  eol: boolean;
}

function isBlank(s: string): boolean {
  return /^\s*$/.test(s);
}

function trimEnd(s: string): string {
  return s.replace(/[ \t\r]+$/, '');
}

function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Split text at \n, strip one trailing \r per line, drop the empty piece
// after a final \n. Used for patch lines and JSON insert new_str.
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// A file's line break is CRLF when its first line feed follows a CR.
function parseText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const firstLf = text.indexOf('\n');
  const brk: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let eol = false;
  if (text.endsWith(brk)) {
    parts.pop();
    eol = true;
  }
  return { lines: parts, brk, eol };
}

function serialize(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.brk) + (st.eol ? st.brk : '');
}

// In-memory view of the tree. Original bytes are snapshotted lazily on
// first touch so the final change list and the atomic write are exact.
class Tree {
  private cur = new Map<string, FileState | null>();
  private orig = new Map<string, string | null>();

  private ensure(path: string): void {
    if (this.orig.has(path)) return;
    let raw: string | null = null;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      raw = null;
    }
    this.orig.set(path, raw);
    this.cur.set(path, raw === null ? null : parseText(raw));
  }

  get(path: string): FileState | null {
    this.ensure(path);
    const s = this.cur.get(path);
    return s === undefined ? null : s;
  }

  set(path: string, st: FileState): void {
    this.ensure(path);
    this.cur.set(path, st);
  }

  setRaw(path: string, text: string): void {
    this.set(path, parseText(text));
  }

  delete(path: string): void {
    this.ensure(path);
    this.cur.set(path, null);
  }

  origEntries(): IterableIterator<[string, string | null]> {
    return this.orig.entries();
  }

  currentRaw(path: string): string | null {
    const s = this.cur.get(path);
    if (s === undefined || s === null) return null;
    return serialize(s);
  }
}

// ---- matching (SPEC section 5) ----

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

// Positions i where O matches lines[i..] at this tier (overlaps allowed).
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

// First tier at which O occurs at least once (positions >= from).
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// First line at or after `from` equal to a single-line anchor, at the
// first tier where one is.
function findSingleLine(lines: string[], anchor: string, strict: boolean, from: number): number {
  for (const t of tiers(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

// Replace lines[pos..pos+O.length) with N. ctx[j] is the index into O of
// N[j] when N[j] is a context line (written as the file's own line);
// at tier 2 every other N line is re-indented (P replaced by F).
function applyReplace(
  lines: string[],
  pos: number,
  o: string[],
  n: string[],
  tier: number,
  ctx: (number | null)[],
): string[] {
  const out: string[] = lines.slice(0, pos);
  const f = o.length > 0 ? leadWs(lines[pos]) : '';
  const p = o.length > 0 ? leadWs(o[0]) : '';
  for (let j = 0; j < n.length; j++) {
    if (ctx[j] !== null && ctx[j] !== undefined) {
      out.push(lines[pos + (ctx[j] as number)]);
    } else if (tier === 2 && o.length > 0) {
      const line = n[j];
      if (line !== '' && stripBoth(line) !== '' && line.startsWith(p)) {
        out.push(f + line.slice(p.length));
      } else {
        out.push(line);
      }
    } else {
      out.push(n[j]);
    }
  }
  for (let i = pos + o.length; i < lines.length; i++) out.push(lines[i]);
  return out;
}

// ---- invocation (SPEC section 1) ----

interface Args {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Args | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(a);
      if (positional.length > 1) return null;
    }
  }
  return { format, check, strict, patch: positional.length > 0 ? positional[0] : null };
}

// ---- format detection (SPEC section 4) ----

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => trimEnd(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---- unified diffs (SPEC section 6) ----

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  createMode: boolean;
  delMode: boolean;
  hunks: Hunk[];
}

interface Edit {
  apply: (t: Tree) => Fail | null;
  move?: { old: string; nw: string };
}

function headerPath(line: string): string | null {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  const p = trimBoth(tab >= 0 ? rest.slice(0, tab) : rest);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isBodyLine(line: string): boolean {
  if (line === '') return true;
  const c = line[0];
  return c === ' ' || c === '-' || c === '+' || c === '\\';
}

function parseBodyLine(line: string): BodyLine {
  if (line === '') return { kind: ' ', text: '' };
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+') return { kind: c as ' ' | '-' | '+', text: line.slice(1) };
  return { kind: '\\', text: line.slice(1) };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: Section | null = null;
  let inHeader = false;
  const flush = (): void => {
    if (section !== null) edits.push(buildUnifiedEdit(section, strict));
    section = null;
  };
  const startFromDiff = (line: string, lineNo: number): void => {
    const m = DIFF_GIT_RE.exec(line);
    if (m === null) throw new ParseError(lineNo);
    section = {
      pairOld: null, pairNew: null, hasPair: false,
      renOld: null, renNew: null, diffOld: m[1], diffNew: m[2],
      createMode: false, delMode: false, hunks: [],
    };
    inHeader = true;
  };
  const startFromPair = (oldLine: string, newLine: string): void => {
    section = {
      pairOld: headerPath(oldLine), pairNew: headerPath(newLine), hasPair: true,
      renOld: null, renNew: null, diffOld: null, diffNew: null,
      createMode: false, delMode: false, hunks: [],
    };
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      if (section === null) throw new ParseError(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      inHeader = false;
      // Collect the body; it ends at the first non-body line, at a
      // diff --git line, or at a --- line followed by a +++ line.
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j];
        if (bl.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
        if (!isBodyLine(bl)) break;
        body.push(parseBodyLine(bl));
        j++;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const lastRaw = lines[i + body.length];
        if (lastRaw === '') body.pop();
        else break;
      }
      section.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (section === null) {
      if (line.startsWith('diff --git ')) {
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        startFromPair(line, lines[i + 1]);
        i += 2;
      } else {
        i++; // prose outside sections is ignored
      }
      continue;
    }
    if (inHeader) {
      if (line.startsWith('diff --git ')) {
        flush();
        startFromDiff(line, i + 1);
        i++;
      } else if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          if (!section.hasPair) {
            section.pairOld = headerPath(line);
            section.pairNew = headerPath(lines[i + 1]);
            section.hasPair = true;
            i += 2;
          } else {
            flush();
            startFromPair(line, lines[i + 1]);
            i += 2;
          }
        } else {
          throw new ParseError(i + 2);
        }
      } else if (line.startsWith('rename from ')) {
        section.renOld = trimBoth(line.slice('rename from '.length));
        i++;
      } else if (line.startsWith('rename to ')) {
        section.renNew = trimBoth(line.slice('rename to '.length));
        i++;
      } else if (line.startsWith('new file mode')) {
        section.createMode = true;
        i++;
      } else if (line.startsWith('deleted file mode')) {
        section.delMode = true;
        i++;
      } else {
        i++; // index / modes / any other header line is ignored
      }
      continue;
    }
    // Between hunks: a new section starts, anything else is ignored.
    if (line.startsWith('diff --git ')) {
      flush();
      startFromDiff(line, i + 1);
      i++;
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      flush();
      startFromPair(line, lines[i + 1]);
      i += 2;
    } else {
      i++;
    }
  }
  flush();
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// O = context + '-' lines, N = context + '+' lines, in body order;
// ctx[j] is the O index of N[j] when N[j] is a context line.
function hunkON(h: Hunk): { o: string[]; n: string[]; ctx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: (number | null)[] = [];
  for (const b of h.body) {
    if (b.kind === ' ') {
      ctx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      ctx.push(null);
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

// True when a '\' line follows the hunk's last context or '+' line.
function backslashAfterLastCtxPlus(h: Hunk): boolean {
  let idx = -1;
  for (let k = 0; k < h.body.length; k++) {
    if (h.body[k].kind === ' ' || h.body[k].kind === '+') idx = k;
  }
  if (idx === -1) return false;
  return idx + 1 < h.body.length && h.body[idx + 1].kind === '\\';
}

function buildUnifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.hasPair ? s.pairOld : (s.renOld ?? s.diffOld);
  const newPath = s.hasPair ? s.pairNew : (s.renNew ?? s.diffNew);
  const isCreate = s.createMode || oldPath === null;
  const isDelete = !isCreate && (s.delMode || newPath === null);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;
  const target = isCreate ? newPath : oldPath;
  const edit: Edit = {
    apply: (tree: Tree): Fail | null => {
      if (target === null || target === undefined) return null; // no path named: nothing to do
      if (isCreate) {
        if (!isSafePath(newPath as string)) return { code: 'unsafe', path: newPath as string };
        if (tree.get(newPath as string) !== null) return { code: 'exists', path: newPath as string };
        const newLines: string[] = [];
        for (const h of s.hunks) {
          for (const b of h.body) if (b.kind === '+') newLines.push(b.text);
        }
        let eol = true;
        // A created file ends with a line break unless a '\' line
        // follows its last '+' line.
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const h = s.hunks[hi];
          for (let k = h.body.length - 1; k >= 0; k--) {
            if (h.body[k].kind === '+') {
              eol = !(k + 1 < h.body.length && h.body[k + 1].kind === '\\');
              break outer;
            }
          }
        }
        tree.set(newPath as string, { lines: newLines, brk: '\n', eol });
        return null;
      }
      if (!isSafePath(oldPath as string)) return { code: 'unsafe', path: oldPath as string };
      if (isDelete) {
        if (tree.get(oldPath as string) === null) return { code: 'missing', path: oldPath as string };
        tree.delete(oldPath as string);
        return null;
      }
      if (isMove && !isSafePath(newPath as string)) return { code: 'unsafe', path: newPath as string };
      const cur = tree.get(oldPath as string);
      if (cur === null) return { code: 'missing', path: oldPath as string };
      if (isMove && tree.get(newPath as string) !== null) return { code: 'exists', path: newPath as string };
      let lines = [...cur.lines];
      let eol = cur.eol;
      let d = 0;
      for (const h of s.hunks) {
        const { o, n, ctx } = hunkON(h);
        if (o.length > 0) {
          const found = findTier(lines, o, strict, 0);
          if (found === null) return { code: 'no-match', path: oldPath as string };
          const want = h.a - 1 + d;
          let best = found.occ[0];
          let bestDist = Math.abs(best - want);
          for (const p of found.occ) {
            const dist = Math.abs(p - want);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const atEnd = best + o.length === lines.length;
          lines = applyReplace(lines, best, o, n, found.tier, ctx);
          if (atEnd) eol = !backslashAfterLastCtxPlus(h);
        } else {
          const at = Math.min(h.a + d, lines.length);
          const atEnd = at === lines.length;
          lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
          if (atEnd) eol = !backslashAfterLastCtxPlus(h);
        }
        d += n.length - o.length;
      }
      const result: FileState = { lines, brk: cur.brk, eol };
      if (isMove) {
        tree.delete(oldPath as string);
        tree.set(newPath as string, result);
      } else {
        tree.set(oldPath as string, result);
      }
      return null;
    },
  };
  if (isMove) edit.move = { old: oldPath as string, nw: newPath as string };
  return edit;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  for (;;) {
    let s = -1;
    for (let j = searchFrom; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s === -1) break;
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j--) {
      const t = trimBoth(lines[j]);
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(s + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '=======') {
        eq = j;
        break;
      }
      if (trimEnd(lines[j]) === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new ParseError(s + 1);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (trimEnd(lines[j]) === '<<<<<<< SEARCH') break;
    }
    if (end === -1) throw new ParseError(s + 1);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(buildSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    searchFrom = end + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function buildSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    apply: (tree: Tree): Fail | null => {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) return { code: 'exists', path };
        tree.set(path, { lines: [...newLines], brk: '\n', eol: true });
        return null;
      }
      const cur = tree.get(path);
      if (cur === null) return { code: 'missing', path };
      const found = findTier(cur.lines, oldLines, strict, 0);
      if (found === null) return { code: 'no-match', path };
      if (found.occ.length > 1) return { code: 'ambiguous', path };
      const lines = applyReplace(cur.lines, found.occ[0], oldLines, newLines, found.tier, newLines.map(() => null));
      tree.set(path, { lines, brk: cur.brk, eol: cur.eol });
      return null;
    },
  };
}

// ---- V4A patches (SPEC section 8) ----

interface VChunk {
  anchor: string | null; // null = no @@ line; '' = empty anchor = none
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // add-file lines
  chunks: VChunk[];
}

const V_SECTION_RE = /^\*\*\* (Add|Delete|Update) File: (.*)$/;

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let j = 0; j < lines.length; j++) {
    if (!isBlank(lines[j])) {
      first = j;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlank(lines[j])) {
      last = j;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const m = V_SECTION_RE.exec(line);
    if (m === null) throw new ParseError(i + 1);
    const kind = m[1].toLowerCase() as 'add' | 'delete' | 'update';
    const path = trimBoth(m[2]);
    const sec: VSection = { kind, path, moveTo: null, lines: [], chunks: [] };
    i++;
    if (kind === 'add') {
      while (i < last && V_SECTION_RE.exec(lines[i]) === null) {
        const l = lines[i];
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new ParseError(i + 1);
        i++;
      }
      while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    } else if (kind === 'delete') {
      while (i < last && V_SECTION_RE.exec(lines[i]) === null) {
        if (!isBlank(lines[i])) throw new ParseError(i + 1);
        i++;
      }
    } else {
      // Update: optional Move to first, then chunks.
      const updateLine = i - 1;
      let chunk: VChunk | null = null;
      let sawChunk = false;
      const closeChunk = (): void => {
        if (chunk !== null) {
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        sec.moveTo = trimBoth(lines[i].slice('*** Move to: '.length));
        i++;
      }
      while (i < last && V_SECTION_RE.exec(lines[i]) === null) {
        const l = lines[i];
        if (isBlank(l)) {
          if (chunk !== null) {
            chunk.body.push({ kind: ' ', text: '' });
          } else if (!sawChunk) {
            // An empty line is a body line: it can start the first chunk.
            chunk = { anchor: null, eof: false, body: [{ kind: ' ', text: '' }] };
            sawChunk = true;
          }
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: l.slice(2).trim(), eof: false, body: [] };
          sawChunk = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new ParseError(i + 1);
          chunk.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (l.startsWith('***')) throw new ParseError(i + 1);
        const c = l[0];
        if (c === ' ' || c === '-' || c === '+') {
          if (chunk === null) {
            if (sawChunk) throw new ParseError(i + 1);
            chunk = { anchor: null, eof: false, body: [] };
            sawChunk = true;
          }
          chunk.body.push({ kind: c as ' ' | '-' | '+', text: l.slice(1) });
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it.
      if (sec.chunks.length > 0) {
        const b = sec.chunks[sec.chunks.length - 1].body;
        while (b.length > 0 && b[b.length - 1].kind === ' ' && b[b.length - 1].text === '') b.pop();
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseError(updateLine + 1);
    }
    edits.push(buildV4aEdit(sec, strict));
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function buildV4aEdit(sec: VSection, strict: boolean): Edit {
  const edit: Edit = {
    apply: (tree: Tree): Fail | null => {
      if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
      if (sec.kind === 'add') {
        if (tree.get(sec.path) !== null) return { code: 'exists', path: sec.path };
        tree.set(sec.path, { lines: [...sec.lines], brk: '\n', eol: true });
        return null;
      }
      if (sec.kind === 'delete') {
        if (tree.get(sec.path) === null) return { code: 'missing', path: sec.path };
        tree.delete(sec.path);
        return null;
      }
      if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
      const cur = tree.get(sec.path);
      if (cur === null) return { code: 'missing', path: sec.path };
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) return { code: 'exists', path: sec.moveTo };
      let lines = [...cur.lines];
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          const idx = findSingleLine(lines, ch.anchor, strict, cursor);
          if (idx === -1) return { code: 'no-match', path: sec.path };
          cursor = idx + 1;
        }
        const { o, n, ctx } = hunkON({ a: 0, body: ch.body });
        if (o.length > 0) {
          let taken: { tier: number; pos: number } | null = null;
          for (const t of tiers(strict)) {
            const occ = occurrencesAt(lines, o, t, cursor);
            for (const p of occ) {
              if (ch.eof && p + o.length !== lines.length) continue;
              taken = { tier: t, pos: p };
              break;
            }
            if (taken !== null) break;
          }
          if (taken === null) return { code: 'no-match', path: sec.path };
          lines = applyReplace(lines, taken.pos, o, n, taken.tier, ctx);
          cursor = taken.pos + n.length;
        } else {
          const at = ch.eof ? lines.length : cursor;
          lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
          cursor = at + n.length;
        }
      }
      const result: FileState = { lines, brk: cur.brk, eol: cur.eol };
      if (sec.moveTo !== null) {
        tree.delete(sec.path);
        tree.set(sec.moveTo, result);
      } else {
        tree.set(sec.path, result);
      }
      return null;
    },
  };
  if (sec.kind === 'update' && sec.moveTo !== null) edit.move = { old: sec.path, nw: sec.moveTo };
  return edit;
}

// ---- JSON edits (SPEC section 9) ----

function parseJson(patchText: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let j = 0; j < lines.length; j++) {
    if (!isBlank(lines[j])) {
      firstIdx = j;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const edits: Edit[] = [];
  if (lines[firstIdx].trimStart().startsWith('[')) {
    // Array form: any fault is parse at the line where the array starts.
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(firstIdx + 1);
    for (const el of arr) edits.push(buildJsonEdit(el, firstIdx + 1));
  } else {
    for (let j = 0; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[j]);
      } catch {
        throw new ParseError(j + 1);
      }
      edits.push(buildJsonEdit(obj, j + 1));
    }
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function buildJsonEdit(obj: unknown, errLine: number): Edit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseError(errLine);
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') throw new ParseError(errLine);
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(errLine);
    const text = o.file_text;
    return {
      apply: (tree: Tree): Fail | null => {
        if (!isSafePath(path)) return { code: 'unsafe', path };
        if (tree.get(path) !== null) return { code: 'exists', path };
        tree.setRaw(path, text);
        return null;
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(errLine);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(errLine);
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    return {
      apply: (tree: Tree): Fail | null => {
        if (!isSafePath(path)) return { code: 'unsafe', path };
        const cur = tree.get(path);
        if (cur === null) return { code: 'missing', path };
        const isCrlf = cur.brk === '\r\n';
        let text = serialize(cur);
        let oldS = oldStr;
        let newS = newStr;
        if (isCrlf) {
          text = text.replace(/\r\n/g, '\n');
          oldS = oldS.replace(/\r\n/g, '\n');
          newS = newS.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let idx = -1;
        let from = 0;
        for (;;) {
          const p = text.indexOf(oldS, from);
          if (p === -1) break;
          count++;
          if (idx === -1) idx = p;
          from = p + 1; // positions may overlap
        }
        if (count === 0) return { code: 'no-match', path };
        if (count > 1) return { code: 'ambiguous', path };
        const result = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
        tree.setRaw(path, isCrlf ? result.replace(/\n/g, '\r\n') : result);
        return null;
      },
    };
  }
  if (o.command === 'insert') {
    if (!Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') throw new ParseError(errLine);
    const lineNo = o.insert_line as number;
    const newStr = o.new_str;
    return {
      apply: (tree: Tree): Fail | null => {
        if (!isSafePath(path)) return { code: 'unsafe', path };
        const cur = tree.get(path);
        if (cur === null) return { code: 'missing', path };
        if (lineNo < 0 || lineNo > cur.lines.length) return { code: 'no-match', path };
        const ins = splitLines(newStr);
        const lines = [...cur.lines.slice(0, lineNo), ...ins, ...cur.lines.slice(lineNo)];
        tree.set(path, { lines, brk: cur.brk, eol: cur.eol });
        return null;
      },
    };
  }
  throw new ParseError(errLine);
}

// ---- order, atomicity, output (SPEC sections 2 and 10) ----

function computeChanges(tree: Tree, moves: { old: string; nw: string }[]): { line: string; key: string }[] {
  const entries: { line: string; key: string }[] = [];
  const deleted = new Set<string>();
  const added = new Set<string>();
  const modified: string[] = [];
  for (const [path, origRaw] of tree.origEntries()) {
    const curRaw = tree.currentRaw(path);
    if (origRaw === curRaw) continue;
    if (origRaw === null) added.add(path);
    else if (curRaw === null) deleted.add(path);
    else modified.push(path);
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const m of moves) {
    if (deleted.has(m.old) && added.has(m.nw) && !usedOld.has(m.old) && !usedNew.has(m.nw)) {
      entries.push({ line: `R ${m.old} -> ${m.nw}`, key: m.nw });
      usedOld.add(m.old);
      usedNew.add(m.nw);
    }
  }
  for (const p of deleted) if (!usedOld.has(p)) entries.push({ line: `D ${p}`, key: p });
  for (const p of added) if (!usedNew.has(p)) entries.push({ line: `A ${p}`, key: p });
  for (const p of modified) entries.push({ line: `M ${p}`, key: p });
  entries.sort((a, b) => byteCompare(a.key, b.key));
  return entries;
}

function writeChanges(tree: Tree): void {
  for (const [path, origRaw] of tree.origEntries()) {
    const curRaw = tree.currentRaw(path);
    if (origRaw === curRaw) continue;
    if (curRaw === null) {
      try {
        unlinkSync(path);
      } catch {
        // already gone
      }
    } else {
      const dir = dirname(path);
      if (dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(path, curRaw);
    }
  }
}

function run(argv: string[]): { code: number; out: string[] } {
  const args = parseArgs(argv);
  if (args === null) return { code: 2, out: ['error: usage'] };
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      patchText = '';
    }
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const det = detectFormat(lines);
    if (det === null) return { code: 2, out: ['error: format'] };
    format = det;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines, args.strict);
    else if (format === 'search-replace') edits = parseSearchReplace(lines, args.strict);
    else if (format === 'v4a') edits = parseV4a(lines, args.strict);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const failures: Fail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const ed of edits) {
    const f = ed.apply(tree);
    if (f !== null) failures.push(f);
    else if (ed.move !== undefined) moves.push(ed.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }
  const changes = computeChanges(tree, moves);
  if (!args.check) writeChanges(tree);
  const out = changes.map((c) => c.line);
  out.push(`ok: ${changes.length} file${changes.length === 1 ? '' : 's'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
