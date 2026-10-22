// Bundles one service entrypoint into a single ESM file so runtime images need no node_modules.
// Usage (from a package dir): node ../../scripts/bundle.mjs src/index.ts dist/index.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Resolve esbuild from the package being built (each app lists it as a devDependency).
const req = createRequire(pathToFileURL(`${process.cwd()}/package.json`));
const { build } = await import(pathToFileURL(req.resolve('esbuild')).href);

const [entry, outfile] = process.argv.slice(2);
await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  // Some CJS deps call require(); give the ESM bundle a real require.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'info',
});
