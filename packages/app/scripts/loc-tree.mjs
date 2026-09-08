import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const appRoot = path.resolve(path.dirname(scriptPath), '..');
const repoRoot = path.resolve(appRoot, '..', '..');

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith('--')) {
    continue;
  }

  const [key, inlineValue] = arg.slice(2).split('=', 2);
  if (inlineValue !== undefined) {
    args.set(key, inlineValue);
    continue;
  }

  const nextValue = process.argv[index + 1];
  if (nextValue && !nextValue.startsWith('--')) {
    args.set(key, nextValue);
    index += 1;
  } else {
    args.set(key, 'true');
  }
}

const rootDir = path.resolve(args.get('root') ?? repoRoot);
const outputFile = path.resolve(args.get('output') ?? path.join(repoRoot, 'loc-tree.md'));

const skippedDirectoryNames = new Set([
  '.git', '.venv', '.venv310', 'node_modules', 'dist', 'build', 'coverage',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
]);

const skippedExactDirectories = [
  path.join(rootDir, 'packages', 'app', 'site'),
  path.join(rootDir, 'packages', 'app', 'public', 'data'),
];

const excludedExtensions = new Set([
  '.md', '.csv', '.json', '.txt', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.svg', '.pdf', '.ipynb',
]);

const excludedNames = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'site.config.json',
]);

const codeExtensions = new Set([
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss',
  '.sass', '.less', '.jsonc', '.sh', '.ps1', '.html', '.toml', '.ini', '.cfg',
  '.yml', '.yaml', '.xml', '.sql',
]);

function isWithin(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function countLines(contents) {
  if (contents.length === 0) {
    return 0;
  }
  return contents.split(/\r\n|\r|\n/).length;
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    try {
      return fs.readFileSync(filePath, 'latin1');
    } catch {
      return null;
    }
  }
}

const entries = [];

function walk(currentPath) {
  const directoryEntries = fs.readdirSync(currentPath, { withFileTypes: true });
  for (const entry of directoryEntries) {
    const entryPath = path.join(currentPath, entry.name);
    const relativePath = path.relative(rootDir, entryPath);
    if (!relativePath || relativePath.startsWith('..')) {
      continue;
    }

    if (entry.isDirectory()) {
      if (skippedDirectoryNames.has(entry.name)) {
        continue;
      }
      if (skippedExactDirectories.some((directory) => entryPath === directory || isWithin(entryPath, directory))) {
        continue;
      }
      walk(entryPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }
    if (excludedNames.has(entry.name)) {
      continue;
    }
    if (excludedExtensions.has(path.extname(entry.name).toLowerCase())) {
      continue;
    }
    if (!codeExtensions.has(path.extname(entry.name).toLowerCase()) && entry.name !== 'README' && entry.name !== 'LICENSE') {
      continue;
    }

    const contents = readTextFile(entryPath);
    if (contents === null) {
      continue;
    }
    entries.push([relativePath.split(path.sep).join('/'), countLines(contents)]);
  }
}

walk(rootDir);
entries.sort((left, right) => left[0].localeCompare(right[0]));

class Node {
  constructor() {
    this.children = new Map();
    this.isFile = false;
    this.lines = 0;
    this.total = 0;
  }
}

const rootNode = new Node();
for (const [relativePath, lineCount] of entries) {
  const parts = relativePath.split('/');
  let node = rootNode;
  node.total += lineCount;
  for (const part of parts.slice(0, -1)) {
    if (!node.children.has(part)) {
      node.children.set(part, new Node());
    }
    node = node.children.get(part);
    node.total += lineCount;
  }
  if (!node.children.has(parts.at(-1))) {
    node.children.set(parts.at(-1), new Node());
  }
  const leaf = node.children.get(parts.at(-1));
  leaf.isFile = true;
  leaf.lines = lineCount;
  leaf.total = lineCount;
}

const outputLines = [];
outputLines.push('# Line Counts by File');
outputLines.push('');
outputLines.push(`Total counted LOC: ${rootNode.total}`);
outputLines.push(`Counted files: ${entries.length}`);
outputLines.push('');

function emit(name, node, indent = '') {
  if (node.isFile) {
    outputLines.push(`${indent}${name} - ${node.lines}`);
    return;
  }
  outputLines.push(`${indent}${name}/ - ${node.total}`);
  const nextIndent = `${indent}  `;
  for (const childName of [...node.children.keys()].sort((left, right) => left.localeCompare(right))) {
    emit(childName, node.children.get(childName), nextIndent);
  }
}

emit(path.basename(rootDir), rootNode);
fs.writeFileSync(outputFile, `${outputLines.join('\n')}\n`, 'utf8');

console.log(outputFile);
console.log(`Total counted LOC: ${rootNode.total}`);
console.log(`Counted files: ${entries.length}`);