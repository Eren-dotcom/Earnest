/**
 * A very small, intentionally limited formatter used by the sample project.
 *
 * It exists because real agents run tools that rewrite files, and those tools
 * are exactly how out-of-scope edits happen. Earnest allows the command but
 * still verifies which files ended up changed.
 */
import fs from 'node:fs/promises';

const targets = process.argv.slice(2);

if (!targets.length) {
  console.error('Usage: node tools/format.mjs <file...>');
  process.exit(1);
}

for (const target of targets) {
  let source;
  try {
    source = await fs.readFile(target, 'utf8');
  } catch {
    console.error(`Skipping missing file: ${target}`);
    continue;
  }
  const formatted = source
    .replace(/\r\n/g, '\n')
    .replace(/"[^"\n]*"/g, (match) => match)
    .replace(/[ \t]+$/gm, '');
  const withHeader = formatted.startsWith('// formatted by tools/format.mjs')
    ? formatted
    : `// formatted by tools/format.mjs\n${formatted}`;
  if (withHeader !== source) {
    await fs.writeFile(target, withHeader);
    console.log(`formatted ${target}`);
  }
}
