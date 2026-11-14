// Builds a single-file preview of the app that runs without a server:
//   node scripts/preview.mjs [out.html]
// Everything is inlined, and the app runs in preview mode (data stays in the browser).
import { readFileSync, writeFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const out = process.argv[2] || 'preview.html';

let css = read('styles.css').replace(/url\(\/fonts\/([^)]+)\)/g, (_, f) =>
  `url(data:font/woff2;base64,${readFileSync(new URL(`../public/fonts/${f}`, import.meta.url)).toString('base64')})`);

// shared.js becomes one object; app.js reads its imports from it.
const shared = read('shared.js');
const names = [...shared.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const sharedJs = `const shared = (() => {\n${shared.replace(/^export /gm, '')}\nreturn { ${names.join(', ')} };\n})();`;
const appJs = read('app.js').replace(/import\s*\{([^}]*)\}\s*from\s*'\.\/shared\.js';/, 'const {$1} = shared;');

let html = read('index.html')
  .replace(/\s*<link rel="(manifest|apple-touch-icon|icon)"[^>]*>/g, '')
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="/app.js"></script>', () => `<script>globalThis.PLANNER_DEMO = true;</script>\n<script>\n(() => {\n${sharedJs}\n${appJs}\n})();\n</script>`)
  .replace('<title>Study Planner</title>', '<title>Study Planner preview</title>');

writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1024).toFixed(0)} KB`);
