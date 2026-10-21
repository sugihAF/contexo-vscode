// Structural checks of package.json (WP-0.6). Usage:
//   node scripts/check-manifest.mjs [--package <path/to/package.json>]
// The default package is the repo's package.json; command ids always come from the repo's
// src/commands/ids.ts. Prints one "OK <check>" or "FAIL <check>: <why>" line per check and
// exits 1 if any check failed.
// It never reads version, displayName, description, categories, keywords, icon or gallery
// fields: WP-4.3 owns the Marketplace listing.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDS_FILE = join(REPO_ROOT, "src", "commands", "ids.ts");
const EXPECTED_ENGINE = "^1.100.0";
const EXPECTED_ACTIVATION_EVENTS = ["workspaceContains:.contexo/config.json", "onFileSystem:contexo"];
const EXPECTED_MAIN = "./dist/extension.js";

function parseArgs(argv) {
  let packagePath = join(REPO_ROOT, "package.json");
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package" && argv[i + 1] !== undefined) {
      packagePath = resolve(argv[++i]);
    } else {
      console.error(`usage: node scripts/check-manifest.mjs [--package <path>] (unexpected argument '${argv[i]}')`);
      process.exit(2);
    }
  }
  return { packagePath };
}

/** The 'contexo.*' string literals of ids.ts, comments stripped. */
function commandIdsFromSource(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
  return [...code.matchAll(/(["'`])(contexo\.[A-Za-z0-9_.-]+)\1/g)].map((m) => m[2]);
}

function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return m ? m.slice(1, 4).map(Number) : undefined;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);

function difference(a, b) {
  const other = new Set(b);
  return [...new Set(a)].filter((x) => !other.has(x)).sort();
}

function duplicates(list) {
  const seen = new Set();
  return [...new Set(list.filter((x) => (seen.has(x) ? true : (seen.add(x), false))))].sort();
}

/** Each check returns undefined (pass) or a failure message. */
function checks(pkg, idsSource) {
  const contributes = isObject(pkg.contributes) ? pkg.contributes : {};
  const contributed = Array.isArray(contributes.commands)
    ? contributes.commands.map((c) => (isObject(c) ? c.command : undefined))
    : [];
  const contributedSet = new Set(contributed);

  return [
    ["no enabledApiProposals", () =>
      "enabledApiProposals" in pkg ? `found enabledApiProposals ${show(pkg.enabledApiProposals)}` : undefined],

    ["no runtime dependencies", () => {
      const deps = pkg.dependencies;
      if (deps === undefined) {
        return undefined;
      }
      return isObject(deps) && Object.keys(deps).length === 0
        ? undefined
        : `dependencies must be absent or empty, found ${show(deps)}`;
    }],

    [`engines.vscode is ${EXPECTED_ENGINE}`, () =>
      pkg.engines?.vscode === EXPECTED_ENGINE ? undefined : `found ${show(pkg.engines?.vscode)}`],

    ["@types/vscode is exact and not newer than the engines.vscode minimum", () => {
      const types = pkg.devDependencies?.["@types/vscode"];
      const typesVersion = typeof types === "string" ? parseVersion(types) : undefined;
      if (!typesVersion) {
        return `devDependencies['@types/vscode'] must be an exact x.y.z version, found ${show(types)}`;
      }
      const engine = typeof pkg.engines?.vscode === "string" ? /^\^?(\d+\.\d+\.\d+)$/.exec(pkg.engines.vscode) : null;
      const engineMin = engine ? parseVersion(engine[1]) : undefined;
      if (!engineMin) {
        return `cannot read a minimum version from engines.vscode ${show(pkg.engines?.vscode)}`;
      }
      return compareVersions(typesVersion, engineMin) <= 0
        ? undefined
        : `@types/vscode ${types} is newer than the engines.vscode minimum ${engine[1]} (vsce refuses to package)`;
    }],

    ["contributes.commands equal the 'contexo.*' ids of src/commands/ids.ts", () => {
      const ids = commandIdsFromSource(idsSource);
      if (ids.length === 0) {
        return `no 'contexo.*' literals found in ${IDS_FILE}`;
      }
      const problems = [];
      const bad = contributed.filter((c) => typeof c !== "string");
      if (bad.length > 0) {
        problems.push(`${bad.length} contributes.commands entr${bad.length === 1 ? "y has" : "ies have"} no string 'command'`);
      }
      const dupContributed = duplicates(contributed.filter((c) => typeof c === "string"));
      if (dupContributed.length > 0) {
        problems.push(`contributed more than once: ${dupContributed.join(", ")}`);
      }
      const dupIds = duplicates(ids);
      if (dupIds.length > 0) {
        problems.push(`repeated in ids.ts: ${dupIds.join(", ")}`);
      }
      const missing = difference(ids, contributed);
      if (missing.length > 0) {
        problems.push(`in ids.ts but not contributed: ${missing.join(", ")}`);
      }
      const extra = difference(contributed.filter((c) => typeof c === "string"), ids);
      if (extra.length > 0) {
        problems.push(`contributed but not in ids.ts: ${extra.join(", ")}`);
      }
      return problems.length > 0 ? problems.join("; ") : undefined;
    }, () => `${contributedSet.size} commands`],

    ["every menus[*][*] command is contributed", () => {
      const menus = contributes.menus ?? {};
      if (!isObject(menus)) {
        return "contributes.menus is not an object";
      }
      const problems = [];
      for (const [menu, items] of Object.entries(menus)) {
        if (!Array.isArray(items)) {
          problems.push(`${menu} is not an array`);
          continue;
        }
        items.forEach((item, i) => {
          if (!isObject(item)) {
            problems.push(`${menu}[${i}] is not an object`);
            return;
          }
          if (item.command === undefined && item.submenu === undefined) {
            problems.push(`${menu}[${i}] has neither command nor submenu`);
          }
          for (const key of ["command", "alt"]) {
            if (item[key] !== undefined && !contributedSet.has(item[key])) {
              problems.push(`${menu}[${i}].${key} ${show(item[key])} is not contributed`);
            }
          }
        });
      }
      return problems.length > 0 ? problems.join("; ") : undefined;
    }],

    ["every command:contexo.* link in viewsWelcome is contributed", () => {
      const welcome = contributes.viewsWelcome ?? [];
      if (!Array.isArray(welcome)) {
        return "contributes.viewsWelcome is not an array";
      }
      const problems = [];
      welcome.forEach((entry, i) => {
        const contents = isObject(entry) && typeof entry.contents === "string" ? entry.contents : "";
        for (const m of contents.matchAll(/command:(contexo\.[A-Za-z0-9_.-]*[A-Za-z0-9_-])/g)) {
          if (!contributedSet.has(m[1])) {
            problems.push(`viewsWelcome[${i}] links ${m[1]}, which is not contributed`);
          }
        }
      });
      return problems.length > 0 ? problems.join("; ") : undefined;
    }],

    ["contexo.path has scope 'machine'", () => {
      const props = contributes.configuration?.properties;
      const setting = isObject(props) ? props["contexo.path"] : undefined;
      if (!isObject(setting)) {
        return "contributes.configuration.properties['contexo.path'] is missing";
      }
      return setting.scope === "machine" ? undefined : `scope is ${show(setting.scope)}`;
    }],

    ["extensionKind is exactly [\"workspace\"]", () =>
      sameJson(pkg.extensionKind, ["workspace"]) ? undefined : `found ${show(pkg.extensionKind)}`],

    ["capabilities.untrustedWorkspaces.supported === false", () =>
      pkg.capabilities?.untrustedWorkspaces?.supported === false
        ? undefined
        : `found ${show(pkg.capabilities?.untrustedWorkspaces?.supported)}`],

    ["activationEvents are exact", () =>
      sameJson(pkg.activationEvents, EXPECTED_ACTIVATION_EVENTS)
        ? undefined
        : `expected ${show(EXPECTED_ACTIVATION_EVENTS)}, found ${show(pkg.activationEvents)}`],

    [`main is ${EXPECTED_MAIN}`, () => (pkg.main === EXPECTED_MAIN ? undefined : `found ${show(pkg.main)}`)],
  ];
}

const { packagePath } = parseArgs(process.argv.slice(2));
let pkg;
let idsSource;
try {
  pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  idsSource = readFileSync(IDS_FILE, "utf8");
} catch (err) {
  console.error(`FAIL cannot read inputs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!isObject(pkg)) {
  console.error(`FAIL ${packagePath} is not a JSON object`);
  process.exit(1);
}

let failed = 0;
for (const [name, run, detail] of checks(pkg, idsSource)) {
  const problem = run();
  if (problem === undefined) {
    console.log(`OK ${name}${detail ? ` (${detail()})` : ""}`);
  } else {
    failed++;
    console.log(`FAIL ${name}: ${problem}`);
  }
}
if (failed > 0) {
  console.error(`check-manifest: ${failed} check(s) failed for ${packagePath}`);
  process.exit(1);
}
console.log(`check-manifest: all checks passed for ${packagePath}`);
