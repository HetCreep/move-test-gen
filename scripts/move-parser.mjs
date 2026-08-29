/**
 * move-parser.mjs — lightweight Move source parser for lint rules.
 *
 * NOT a full compiler. Extracts function-level structure:
 *   - function signatures (visibility, name, params with types, return type)
 *   - variable declarations with inferred types
 *   - assert locations
 *   - type casts (as u128, as u256, as u64)
 *
 * Rules receive parsed functions instead of raw text, so they can
 * ask "what type is this variable?" without regex guessing.
 */

import { stripBlockComments } from './strip-comments.mjs';

export const WIDE_TYPES = new Set(['u128', 'u256']);

// A line that is ENTIRELY one or more visibility/entry modifier tokens,
// with no `fun` keyword yet -- the leading tokens of a declaration wrapped
// across lines (`public(package)\nentry fun f(...)`). Never matches a line
// that also has other content, so it can't accidentally swallow an
// unrelated statement.
const BARE_VIS_RE = /^(?:public\s*\(\s*(?:package|friend)\s*\)|public|entry)(?:\s+(?:public\s*\(\s*(?:package|friend)\s*\)|public|entry))*$/;

/**
 * Parse a Move source file into module-level structure.
 * @param {string} source — file content
 * @returns {{ moduleName: string, functions: ParsedFunction[], constants: Constant[] }}
 */
export function parseModule(source) {
  // Strip block comments up front: a #[test_only]/#[test] attribute (or a
  // const/module declaration) sitting inside a commented-out block is not
  // attached to anything real, and extractFunctions()'s attribute
  // pass-through would otherwise walk straight through a /* ... */ line
  // (single- or multi-line) as if it were blank. stripBlockComments()
  // preserves line count, so downstream line numbers stay correct.
  const stripped = stripBlockComments(source);
  const lines = stripped.split('\n');
  const moduleName = extractModuleName(stripped);
  const constants = extractConstants(lines);
  const functions = extractFunctions(lines);
  return { moduleName, constants, functions };
}

function extractModuleName(source) {
  const m = source.match(/module\s+([\w:]+)/);
  return m ? m[1] : 'unknown';
}

/**
 * @typedef {{ name: string, type: string, value: string }} Constant
 */
function extractConstants(lines) {
  const constants = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) continue;
    const m = trimmed.match(/const\s+(\w+)\s*:\s*(\w+)\s*=\s*(.+);/);
    if (m) {
      constants.push({ name: m[1], type: m[2], value: m[3].trim() });
    }
  }
  return constants;
}

/**
 * @typedef {{
 *   name: string,
 *   visibility: 'public'|'public(friend)'|'public entry'|'entry'|'private',
 *   typeParams: string[],
 *   params: { name: string, type: string, isMut: boolean, isRef: boolean }[],
 *   returnType: string|null,
 *   startLine: number,
 *   endLine: number,
 *   isTestOnly: boolean,
 *   isTest: boolean,
 *   body: FunctionBody
 * }} ParsedFunction
 */

/**
 * @typedef {{
 *   variables: { name: string, type: string|null, line: number }[],
 *   asserts: { line: number, code: string|null, condition: string }[],
 *   casts: { line: number, expr: string, fromType: string|null, toType: string }[],
 *   multiplications: { line: number, left: string, right: string, leftType: string|null, rightType: string|null }[],
 *   divisions: { line: number, numerator: string, denominator: string }[],
 *   calls: { line: number, fn: string }[],
 * }} FunctionBody
 */

function extractFunctions(lines) {
  const functions = [];
  let i = 0;

  // An attribute belongs to the item it is directly attached to, never to
  // whatever function happens to follow within N lines. These flags carry
  // an attribute across blank lines, comments, and stacked attribute lines
  // (none of which are items of their own) but are cleared the instant we
  // reach an actual item -- `use`, `struct`, `const`, or a `fun` that
  // consumes them. That is the only way an attribute is "attached": nothing
  // but pass-through lines between it and its item.
  let pendingTestOnly = false;
  let pendingTest = false;
  // A visibility/entry modifier with nothing else on its line (a wrapped
  // `public(package)\nentry fun f(...)` declaration) is not a complete item
  // on its own -- accumulate it and hand it to whichever `fun` line follows,
  // the same "attach forward" shape as the attribute pending flags above.
  let pendingVisPrefix = '';

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (trimmed === '' || trimmed.startsWith('//')) { i++; continue; }

    // A line that is ONLY an attribute (no same-line item) -- carry its
    // flag forward and keep scanning for the item it decorates. A trailing
    // `//` comment (`#[test_only] // helper used by the suite`) doesn't
    // disqualify it -- strip that before checking, same idiom parseBody()
    // already uses for the identical reason.
    const attrCodeOnly = trimmed.replace(/\/\/.*$/, '').trim();
    const attrOnly = attrCodeOnly.match(/^#\[([^\]]*)\]$/);
    if (attrOnly) {
      if (/^test_only\b/.test(attrOnly[1])) pendingTestOnly = true;
      else if (/^test\b/.test(attrOnly[1])) pendingTest = true;
      // any other attribute (#[allow(...)], #[expected_failure(...)]) is
      // just another line stacked above the same item -- leave flags as-is.
      i++;
      continue;
    }

    // A bare visibility/entry fragment, no `fun` on the line yet -- hold it
    // rather than treating it as a "different item" boundary.
    if (!/\bfun\b/.test(trimmed) && BARE_VIS_RE.test(trimmed)) {
      pendingVisPrefix = pendingVisPrefix ? `${pendingVisPrefix} ${trimmed}` : trimmed;
      i++;
      continue;
    }

    // detect function start -- tolerates a leading same-line attribute
    // (`#[test_only] fun helper() {`) and a leading visibility fragment
    // held on an earlier line, see parseFunctionSignature.
    const fnInfo = parseFunctionSignature(lines, i, pendingVisPrefix);
    pendingVisPrefix = '';
    if (fnInfo) {
      if (/^#\[test_only\]/.test(trimmed)) fnInfo.isTestOnly = true;
      if (/^#\[test[\],\s]/.test(trimmed)) fnInfo.isTest = true;
      if (pendingTestOnly) fnInfo.isTestOnly = true;
      if (pendingTest) fnInfo.isTest = true;
      pendingTestOnly = false;
      pendingTest = false;

      // find function body boundaries
      const bodyRange = findBraceBlock(lines, fnInfo.sigEndLine);
      if (bodyRange) {
        fnInfo.endLine = bodyRange.end;
        const bodyLines = lines.slice(bodyRange.start, bodyRange.end + 1);
        fnInfo.body = parseBody(bodyLines, bodyRange.start);
        functions.push(fnInfo);
        i = bodyRange.end + 1;
        continue;
      }
    }

    // Reached a different item (use/struct/const, an unmatched fun, or any
    // other code) -- any pending attribute belonged to THIS item, not to
    // whatever function comes later, so it does not carry any further.
    pendingTestOnly = false;
    pendingTest = false;
    i++;
  }

  return functions;
}

function parseFunctionSignature(lines, startIdx, externalPrefix = '') {
  const rawLine = lines[startIdx].trim();
  // A caller may have accumulated leading visibility/entry tokens from
  // earlier lines (`public(package)\nentry fun f(...)`) -- fold them in
  // before matching, so a wrapped declaration is seen as one signature.
  const line = externalPrefix ? `${externalPrefix} ${rawLine}` : rawLine;

  // Strip a leading same-line attribute (`#[test_only] fun foo() {`) so the
  // signature regex still anchors correctly. A stripped attribute CAN carry
  // its own parens (`#[allow(lint(self_transfer))] public fun payout(...)`)
  // -- the param-collector loop below uses this stripped line rather than
  // the raw one for its own starting line, specifically so a balanced
  // paren pair inside the attribute never gets mistaken for the real
  // parameter list and truncates it early.
  const sigLine = line.replace(/^(?:#\[[^\]]*\]\s*)+/, '');

  // match function declaration. `public(package) entry` / `public(friend)
  // entry` (package-scoped in name only -- `entry` makes it a PTB target
  // regardless) are distinct alternatives, not derived from combining the
  // bare forms: the bare-form alternatives on their own stop consuming at
  // the closing `)`, so `entry` right after would never be reached without
  // its own explicit alternative.
  const fnRegex = /^(public\s+entry\s+|public\(package\)\s+entry\s+|public\(friend\)\s+entry\s+|public\(friend\)\s+|public\(package\)\s+|public\s+|entry\s+)?fun\s+(\w+)(?:<([^>]*)>)?\s*\(/;
  const m = sigLine.match(fnRegex);
  if (!m) return null;

  const visRaw = (m[1] || '').trim();
  const visibility = visRaw === '' ? 'private' :
    visRaw.includes('friend') && visRaw.includes('entry') ? 'public(friend) entry' :
    visRaw.includes('package') && visRaw.includes('entry') ? 'public(package) entry' :
    visRaw.includes('friend') ? 'public(friend)' :
    visRaw.includes('entry') && visRaw.includes('public') ? 'public entry' :
    visRaw.includes('entry') ? 'entry' : 'public';

  const name = m[2];
  const typeParams = m[3] ? m[3].split(',').map(t => t.trim()) : [];

  // Where the REAL parameter list's own opening paren sits in sigLine --
  // fnRegex's match already ends with `\s*\(`, consuming exactly up to and
  // including it, so m[0]'s length is that position. A visibility prefix
  // can carry its own balanced parens before this point (`public(package)`,
  // `public(friend)`) -- starting the scan here, not at char 0, is what
  // keeps them from being mistaken for the parameter list itself.
  const parenStart = m[0].length - 1;

  // collect full parameter list (may span multiple lines)
  let paramStr = '';
  let sigEndLine = startIdx;
  let depth = 0;
  let started = false;
  for (let j = startIdx; j < Math.min(startIdx + 15, lines.length); j++) {
    // The starting line may carry a same-line attribute prefix, and/or a
    // visibility modifier with its own parens, before the real parameter
    // list (see sigLine/parenStart above) -- slice both away so only the
    // real `(...)` is ever counted. Every later line has no such prefix.
    const lineText = j === startIdx ? sigLine.slice(parenStart) : lines[j];
    for (const ch of lineText) {
      if (ch === '(') { depth++; started = true; }
      if (started && depth > 0) paramStr += ch;
      if (ch === ')') { depth--; if (started && depth === 0) { sigEndLine = j; break; } }
    }
    if (started && depth === 0) break;
  }

  // remove outer parens
  paramStr = paramStr.slice(1);
  const params = parseParams(paramStr);

  // find return type (after `)` and before `{`)
  let returnType = null;
  for (let j = sigEndLine; j < Math.min(sigEndLine + 3, lines.length); j++) {
    const retMatch = lines[j].match(/\)\s*:\s*([^{]+)/);
    if (retMatch) {
      returnType = retMatch[1].trim();
      sigEndLine = j;
      break;
    }
  }

  return {
    name,
    visibility,
    typeParams,
    params,
    returnType,
    startLine: startIdx + 1,
    sigEndLine,
    endLine: startIdx + 1,
    isTestOnly: false,
    isTest: false,
    body: null,
  };
}

function parseParams(paramStr) {
  if (!paramStr.trim()) return [];
  const params = [];
  // split by comma, but respect angle brackets
  let depth = 0;
  let current = '';
  for (const ch of paramStr) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      params.push(parseOneParam(current.trim()));
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(parseOneParam(current.trim()));
  return params.filter(Boolean);
}

function parseOneParam(s) {
  if (!s) return null;
  // patterns: `name: Type`, `name: &Type`, `name: &mut Type`, `_: Type`
  const m = s.match(/(\w+)\s*:\s*(&mut\s+|&)?(.+)/);
  if (!m) return null;
  // clean trailing parens/commas/whitespace from type
  const rawType = m[3].trim().replace(/[),;\s]+$/, '');
  return {
    name: m[1],
    type: rawType,
    isMut: !!m[2] && m[2].includes('mut'),
    isRef: !!m[2],
  };
}

function findBraceBlock(lines, startSearch) {
  let depth = 0;
  let blockStart = null;
  for (let i = startSearch; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        if (blockStart === null) blockStart = i;
        depth++;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0 && blockStart !== null) {
          return { start: blockStart, end: i };
        }
      }
    }
  }
  return null;
}

function parseBody(bodyLines, offset) {
  const variables = [];
  const asserts = [];
  const casts = [];
  const multiplications = [];
  const divisions = [];
  const calls = [];

  // track known variable types
  const varTypes = {};

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const trimmed = line.trim();
    const lineNo = offset + i + 1;

    if (trimmed.startsWith('//')) continue;

    // variable declaration: let name: Type = ...
    const letTyped = trimmed.match(/let\s+(?:mut\s+)?(\w+)\s*:\s*(\w+)/);
    if (letTyped) {
      const [, vname, vtype] = letTyped;
      variables.push({ name: vname, type: vtype, line: lineNo });
      varTypes[vname] = vtype;
    }

    // variable declaration with cast: let name = (expr as u128)
    const letCast = trimmed.match(/let\s+(?:mut\s+)?(\w+)\s*=.*\bas\s+(u(?:8|16|32|64|128|256))\s*\)/);
    if (letCast && !letTyped) {
      const [, vname, castType] = letCast;
      variables.push({ name: vname, type: castType, line: lineNo });
      varTypes[vname] = castType;
    }

    // destructuring with casts: let (a, b) = ((x as u256), (y as u256))
    const letDestruct = trimmed.match(/let\s+\(([^)]+)\)\s*=\s*\((.+)\)/);
    if (letDestruct && !letTyped) {
      const names = letDestruct[1].split(',').map(s => s.trim());
      const exprs = letDestruct[2];
      // find all cast types in order
      const castTypes = [...exprs.matchAll(/as\s+(u(?:128|256))\)/g)].map(c => c[1]);
      for (let k = 0; k < names.length && k < castTypes.length; k++) {
        const vname = names[k];
        if (vname && castTypes[k]) {
          variables.push({ name: vname, type: castTypes[k], line: lineNo });
          varTypes[vname] = castTypes[k];
        }
      }
    }

    // variable assigned from expression involving a known-wide variable
    // let numerator1 = liquidity_u256 << RESOLUTION → u256
    // let diff = a_u128 - b_u128 → u128
    if (!letTyped && !letCast) {
      const letExpr = trimmed.match(/let\s+(?:mut\s+)?(\w+)\s*=\s*(.+)/);
      if (letExpr) {
        const [, vname, expr] = letExpr;
        const tokens = expr.match(/\w+/g) || [];
        for (const tok of tokens) {
          const tokType = varTypes[tok];
          if (tokType && WIDE_TYPES.has(tokType)) {
            variables.push({ name: vname, type: tokType, line: lineNo });
            varTypes[vname] = tokType;
            break;
          }
        }
      }
    }

    // variable from function call with known return type suffix
    // let x_u256 = ...; (naming convention)
    const letSuffix = trimmed.match(/let\s+(?:mut\s+)?(\w+_(u(?:128|256)))\b/);
    if (letSuffix && !letTyped && !letCast) {
      const [, vname, inferredType] = letSuffix;
      variables.push({ name: vname, type: inferredType, line: lineNo });
      varTypes[vname] = inferredType;
    }

    // assert
    const assertMatch = trimmed.match(/assert!\s*\((.+)/);
    if (assertMatch) {
      const condStr = assertMatch[1];
      const codeMatch = condStr.match(/,\s*(\w+)\s*\)$/);
      asserts.push({
        line: lineNo,
        code: codeMatch ? codeMatch[1] : null,
        condition: condStr,
      });
    }

    // A trailing `//` comment is not code -- matching against it can turn a
    // lookalike mention (e.g. `// old code used (x as u64) here`) into a
    // phantom finding alongside the real one. The loop-level comment-only-
    // line skip above only covers a comment that IS the whole line.
    const codeOnly = trimmed.replace(/\/\/.*$/, '').trim();

    // type casts: (expr as uXX) — handle both simple and nested parens
    for (const cm of codeOnly.matchAll(/\(([^)]+?)\s+as\s+(u(?:8|16|32|64|128|256))\)/g)) {
      casts.push({
        line: lineNo,
        expr: cm[1].trim(),
        fromType: inferType(cm[1].trim(), varTypes),
        toType: cm[2],
      });
    }
    // also catch `) as uXX)` pattern (closing a multi-line expression)
    const trailingCast = codeOnly.match(/\)\s+as\s+(u(?:8|16|32|64|128|256))\)\s*;?\s*$/);
    if (trailingCast) {
      casts.push({
        line: lineNo,
        expr: '(multi-line expression)',
        fromType: null,
        toType: trailingCast[1],
      });
    }

    // multiplications
    for (const mm of codeOnly.matchAll(/(\w+)\s*\*\s*(\w+)/g)) {
      multiplications.push({
        line: lineNo,
        left: mm[1],
        right: mm[2],
        leftType: varTypes[mm[1]] || null,
        rightType: varTypes[mm[2]] || null,
      });
    }

    // divisions
    for (const dm of codeOnly.matchAll(/(\w+)\s*\/\s*(\w+)/g)) {
      divisions.push({
        line: lineNo,
        numerator: dm[1],
        denominator: dm[2],
      });
    }

    // function calls
    const callMatch = trimmed.match(/(\w+(?:::\w+)*)\s*(?:<[^>]*>)?\s*\(/);
    if (callMatch && !trimmed.match(/^(let|if|while|assert!|fun)\b/)) {
      calls.push({ line: lineNo, fn: callMatch[1] });
    }
  }

  return { variables, asserts, casts, multiplications, divisions, calls };
}

function inferType(expr, varTypes) {
  // direct variable lookup
  if (varTypes[expr]) return varTypes[expr];
  // literal number
  if (/^\d+$/.test(expr)) return 'literal';
  return null;
}

/**
 * Get the type of a variable at a given line within a parsed function.
 */
export function getVarType(fn, varName) {
  if (!fn.body) return null;
  for (const v of fn.body.variables) {
    if (v.name === varName) return v.type;
  }
  // check params
  for (const p of fn.params) {
    if (p.name === varName) return p.type;
  }
  return null;
}

/**
 * Check if a function has an assert guarding a specific condition
 * before a given line.
 */
export function hasAssertBefore(fn, lineNo, pattern) {
  if (!fn.body) return false;
  for (const a of fn.body.asserts) {
    if (a.line < lineNo && pattern.test(a.condition)) return true;
  }
  return false;
}
