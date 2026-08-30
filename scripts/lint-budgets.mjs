#!/usr/bin/env node
/**
 * Source budgets that oxlint does not cover:
 *   - CSS/JS/TS file size
 *   - ABC magnitude per function (sqrt(A^2 + B^2 + C^2))
 *
 * A = assignments, B = branches, C = conditions.
 * Nested functions count on their own, not in the parent.
 * Uses the package TypeScript parser. Warn-only. Exit 0 unless --deny.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const deny = process.argv.includes('--deny');
const root = process.cwd();
const srcRoot = path.join(root, 'src');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');

const MAX_BYTES = 48 * 1024;
const MAX_ABC = 30;
const SKIP_DIR = new Set([
  'node_modules',
  'dist',
  'coverage',
  '__tests__',
  'migrations',
  'seeds',
]);
const SIZE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.mjs', '.cjs']);
const ABC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

const ASSIGN = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const COMPARE = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    if (SKIP_DIR.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

function isNestedFn(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function abcOf(fn) {
  let A = 0;
  let B = 0;
  let C = 0;
  const visit = (node) => {
    if (node !== fn && isNestedFn(node)) return;
    if (ts.isBinaryExpression(node)) {
      if (ASSIGN.has(node.operatorToken.kind)) A += 1;
      else if (COMPARE.has(node.operatorToken.kind)) C += 1;
      else if (
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        B += 1;
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      ) {
        A += 1;
      }
    }
    if (ts.isVariableDeclaration(node) && node.initializer) A += 1;
    if (ts.isIfStatement(node)) B += 1;
    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) B += 1;
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) B += 1;
    if (ts.isSwitchStatement(node)) B += 1;
    if (ts.isCatchClause(node)) B += 1;
    if (ts.isConditionalExpression(node)) B += 1;
    if (ts.isCaseClause(node)) C += 1;
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return { A, B, C, mag: Math.sqrt(A * A + B * B + C * C) };
}

function fnName(fn, source) {
  if (fn.name) return fn.name.getText(source);
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && parent.name) {
    return parent.name.getText(source);
  }
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  const pos = source.getLineAndCharacterOfPosition(fn.getStart(source));
  return `<anonymous>:${pos.line + 1}`;
}

const sizeHits = [];
const abcHits = [];

for (const file of walk(srcRoot)) {
  const ext = path.extname(file).toLowerCase();
  const rel = path.relative(root, file);
  if (rel.includes('.test.') || rel.includes('.spec.')) continue;

  if (SIZE_EXT.has(ext)) {
    const bytes = fs.statSync(file).size;
    if (bytes > MAX_BYTES) sizeHits.push({ rel, bytes });
  }

  if (!ABC_EXT.has(ext)) continue;
  const text = fs.readFileSync(file, 'utf8');
  const kind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const visit = (node) => {
    if (isNestedFn(node) && node.body) {
      const { mag, A, B, C } = abcOf(node);
      if (mag > MAX_ABC) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        abcHits.push({
          rel,
          line: pos.line + 1,
          name: fnName(node, source),
          mag,
          A,
          B,
          C,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

sizeHits.sort((a, b) => b.bytes - a.bytes);
abcHits.sort((a, b) => b.mag - a.mag);

for (const h of sizeHits) {
  console.warn(`${h.rel}: file is ${(h.bytes / 1024).toFixed(1)} KiB (budget ${MAX_BYTES / 1024} KiB)`);
}
for (const h of abcHits) {
  console.warn(
    `${h.rel}:${h.line}: function ${h.name} ABC ${h.mag.toFixed(1)} (A=${h.A} B=${h.B} C=${h.C}; budget ${MAX_ABC})`,
  );
}

const n = sizeHits.length + abcHits.length;
if (n === 0) {
  console.log(`lint-budgets: ok (filesize <= ${MAX_BYTES / 1024} KiB, ABC <= ${MAX_ABC})`);
} else {
  console.warn(`lint-budgets: ${n} warning(s)`);
}

if (deny && n > 0) process.exit(1);
