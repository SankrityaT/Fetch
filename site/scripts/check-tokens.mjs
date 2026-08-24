/**
 * The site claims it cannot drift from the app. This is what makes that true.
 *
 * Reads the palette out of the app's ui/tokens.css and out of the site's
 * @theme block, and fails if any shared token disagrees. Run it in CI and in
 * `npm run build`, so a colour change in the product either reaches the site
 * or breaks the build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "../../ui/tokens.css");
const SITE = resolve(here, "../app/globals.css");

/** `--ink-0:#0A0908;` and `--color-ink-0: #0a0908;` both reduce to ink-0 */
function palette(css, prefix) {
  const out = new Map();
  const re = new RegExp(`--${prefix}([a-z0-9-]+)\\s*:\\s*(#[0-9a-fA-F]{3,8})`, "g");
  for (const [, name, hex] of css.matchAll(re)) out.set(name, hex.toLowerCase());
  return out;
}

/* The two files are not equally available. globals.css always ships with the
   site; ui/tokens.css lives in the desktop app, one level above this directory,
   and a host that deploys only the site subtree cannot see it. Vercel is
   exactly that: root directory `site`, so the app source is simply not there
   and this check has nothing to compare against.
   Skip loudly in that case rather than failing the deploy, and keep failing
   hard whenever the file IS readable and the values have drifted. Silence
   would be worse than either. */
let app, site;
try {
  site = palette(readFileSync(SITE, "utf8"), "color-");
} catch (err) {
  console.error(`tokens: cannot read the site's own tokens at ${SITE}. ${err.message}`);
  process.exit(1);
}
try {
  app = palette(readFileSync(APP, "utf8"), "");
} catch {
  console.log(
    "tokens: skipped. The app's ui/tokens.css is not in this checkout, which is " +
    "expected when only the site subtree is deployed. Run this from a full clone " +
    "to actually check for drift."
  );
  process.exit(0);
}

/* Only the tokens the site actually adopted are checked. The app has some the
   site has no use for, and that is not drift. */
const shared = [...site.keys()].filter((k) => app.has(k));
const drift = shared.filter((k) => app.get(k) !== site.get(k));
const missing = [...site.keys()].filter((k) => !app.has(k));

if (shared.length === 0) {
  console.error("tokens: no shared tokens found. The parser or a path is wrong.");
  process.exit(1);
}

for (const k of drift) {
  console.error(`tokens: --${k} is ${app.get(k)} in the app but ${site.get(k)} on the site`);
}
for (const k of missing) {
  console.error(`tokens: --color-${k} exists on the site but not in ui/tokens.css`);
}

if (drift.length || missing.length) {
  console.error(
    `\ntokens: ${drift.length + missing.length} problem(s). Fix the site, or change the app first and copy the value across.`
  );
  process.exit(1);
}

console.log(`tokens: ${shared.length} shared tokens match ui/tokens.css`);
