// Structural checks of package.json (WP-0.6; WP-2.3 added the when-clause checks and --vsix).
// Usage:
//   node scripts/check-manifest.mjs [--package <path/to/package.json>]
//   node scripts/check-manifest.mjs --vsix [<path/to/file.vsix>] [--package <path>]
// The default package is the repo's package.json; command ids, context keys and the
// ExtensionState union always come from the repo's src/. Prints one "OK <check>" or
// "FAIL <check>: <why>" line per check and exits 1 if any check failed.
// --vsix (npm run check:vsix) runs only the packaging checks: `vsce ls --no-dependencies`
// (run in the package's directory) lists exactly the allowlisted files, and the VSIX
// (default <package dir>/dist/<name>-<version>.vsix, as `npm run package` writes it) is
// smaller than VSIX_MAX_BYTES. `vsce ls` never runs vscode:prepublish.
// It never reads version, displayName, description, categories, keywords, icon or gallery
// fields for a check (WP-4.3 owns the Marketplace listing; --vsix only uses name and version
// to find the default VSIX file).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IDS_FILE = join(REPO_ROOT, "src", "commands", "ids.ts");
const SRC_DIR = join(REPO_ROOT, "src");
const MODEL_TYPES_FILE = join(REPO_ROOT, "src", "model", "types.ts");
const VSCE = join(REPO_ROOT, "node_modules", "@vscode", "vsce", "vsce");
/** The VSIX payload (vsce ls paths): these files, plus anything under media/. */
const VSIX_ALLOWED_FILES = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "dist/extension.js"];
const VSIX_ALLOWED_PREFIXES = ["media/"];
const VSIX_REQUIRED_FILES = ["package.json", "dist/extension.js"];
const VSIX_MAX_BYTES = 512000;
const EXPECTED_ENGINE = "^1.100.0";
const EXPECTED_ACTIVATION_EVENTS = ["workspaceContains:.contexo/config.json", "onFileSystem:contexo"];
const EXPECTED_MAIN = "./dist/extension.js";

function parseArgs(argv) {
  let packagePath = join(REPO_ROOT, "package.json");
  let vsix = false;
  let vsixPath;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package" && argv[i + 1] !== undefined) {
      packagePath = resolve(argv[++i]);
    } else if (argv[i] === "--vsix") {
      vsix = true;
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { vsixPath = resolve(argv[++i]); }
    } else {
      console.error(`usage: node scripts/check-manifest.mjs [--package <path>] [--vsix [<file.vsix>]] (unexpected argument '${argv[i]}')`);
      process.exit(2);
    }
  }
  return { packagePath, vsix, vsixPath };
}

/** Every 'when' and 'enablement' string anywhere under contributes, with where it was found. */
function whenClauses(contributes) {
  const out = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`));
    } else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "when" || k === "enablement") && typeof x === "string") {
          out.push({ where: `${where}.${k}`, clause: x });
        } else {
          walk(x, `${where}.${k}`);
        }
      }
    }
  };
  walk(contributes, "contributes");
  return out;
}

/**
 * The contexo.* context keys a when clause reads. An identifier right after a comparison
 * operator ('view == contexo.knowledge') is a value, not a key.
 */
function contextKeysOf(clause) {
  const keys = [];
  for (const m of clause.matchAll(/contexo\.[A-Za-z0-9_.]*[A-Za-z0-9_]/g)) {
    const before = clause.slice(0, m.index);
    if (/(===|!==|==|!=|=~|<=|>=|<|>|\bnot in|\bin)\s*$/.test(before)) { continue; }
    keys.push(m[0]);
  }
  return keys;
}

/** Every src/**\/*.ts file's text, keyed by its repo-relative path. */
function sourceFiles(dir = SRC_DIR) {
  const files = new Map();
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      for (const [k, v] of sourceFiles(p)) { files.set(k, v); }
    } else if (e.name.endsWith(".ts")) {
      files.set(p.slice(REPO_ROOT.length + 1), readFileSync(p, "utf8"));
    }
  }
  return files;
}

/** The string literals of `export type ExtensionState = ...;` in src/model/types.ts. */
function extensionStates(source) {
  const m = /export type ExtensionState\s*=([^;]*);/.exec(source);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
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
function checks(pkg, idsSource, src) {
  const contributes = isObject(pkg.contributes) ? pkg.contributes : {};
  const contributed = Array.isArray(contributes.commands)
    ? contributes.commands.map((c) => (isObject(c) ? c.command : undefined))
    : [];
  const contributedSet = new Set(contributed);
  const idSet = new Set(commandIdsFromSource(idsSource));

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

    ["every menu and keybinding command is contributed and in src/commands/ids.ts", () => {
      const menus = contributes.menus ?? {};
      if (!isObject(menus)) {
        return "contributes.menus is not an object";
      }
      const problems = [];
      const keybindings = contributes.keybindings ?? [];
      if (!Array.isArray(keybindings)) {
        problems.push("contributes.keybindings is not an array");
      } else {
        keybindings.forEach((kb, i) => {
          const command = isObject(kb) ? kb.command : undefined;
          if (typeof command !== "string") {
            problems.push(`keybindings[${i}] has no string command`);
          } else if (!contributedSet.has(command) || !idSet.has(command)) {
            problems.push(`keybindings[${i}].command ${show(command)} is not ${contributedSet.has(command) ? "in ids.ts" : "contributed"}`);
          }
        });
      }
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
            } else if (item[key] !== undefined && !idSet.has(item[key])) {
              problems.push(`${menu}[${i}].${key} ${show(item[key])} is not in ids.ts`);
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

    ["every contexo.* context key in a when clause is set via setContext in src/", () => {
      const problems = [];
      const setters = [...src.entries()].filter(([, text]) => text.includes("setContext"));
      for (const { where, clause } of whenClauses(contributes)) {
        for (const key of contextKeysOf(clause)) {
          const literal = new RegExp(`(["'\`])${key.replace(/\./g, "\\.")}\\1`);
          if (!setters.some(([, text]) => literal.test(text))) {
            problems.push(`${where} reads ${key}, which no src file that calls setContext names`);
          }
        }
      }
      return problems.length > 0 ? [...new Set(problems)].join("; ") : undefined;
    }],

    ["viewsWelcome contexo.state values are ExtensionState values", () => {
      const states = extensionStates(src.get(MODEL_TYPES_FILE.slice(REPO_ROOT.length + 1)) ?? "");
      if (states.length === 0) {
        return `no ExtensionState union found in ${MODEL_TYPES_FILE}`;
      }
      const welcome = Array.isArray(contributes.viewsWelcome) ? contributes.viewsWelcome : [];
      const problems = [];
      welcome.forEach((entry, i) => {
        const when = isObject(entry) && typeof entry.when === "string" ? entry.when : "";
        for (const m of when.matchAll(/contexo\.state\s*(?:==|!=|===|!==)\s*([A-Za-z0-9_-]+)/g)) {
          if (!states.includes(m[1])) {
            problems.push(`viewsWelcome[${i}] tests contexo.state == ${m[1]}, not one of ${states.join("|")}`);
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

/** The --vsix checks: the vsce file list and the VSIX size. */
function vsixChecks(pkg, packagePath, vsixPath) {
  const pkgDir = dirname(packagePath);
  let listed;
  const list = () => {
    if (listed === undefined) {
      const r = spawnSync(process.execPath, [VSCE, "ls", "--no-dependencies"], { cwd: pkgDir, encoding: "utf8", shell: false });
      listed = r.status === 0
        ? { files: r.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "") }
        : { error: `vsce ls exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout || String(r.error ?? "")).trim()}` };
    }
    return listed;
  };
  const vsixFile = vsixPath ?? join(pkgDir, "dist", `${pkg.name}-${pkg.version}.vsix`);
  return [
    ["vsce ls --no-dependencies lists only the allowlisted files", () => {
      const l = list();
      if (l.error) {
        return l.error;
      }
      const extra = l.files.filter((f) => !VSIX_ALLOWED_FILES.includes(f) && !VSIX_ALLOWED_PREFIXES.some((p) => f.startsWith(p)));
      const missing = VSIX_REQUIRED_FILES.filter((f) => !l.files.includes(f));
      const problems = [];
      if (extra.length > 0) { problems.push(`not allowlisted: ${extra.join(", ")}`); }
      if (missing.length > 0) { problems.push(`missing: ${missing.join(", ")}`); }
      return problems.length > 0 ? problems.join("; ") : undefined;
    }, () => list().files?.join(", ") ?? ""],

    [`the VSIX is smaller than ${VSIX_MAX_BYTES} bytes`, () => {
      if (!existsSync(vsixFile)) {
        return `${vsixFile} does not exist (run npm run package first)`;
      }
      const size = statSync(vsixFile).size;
      return size < VSIX_MAX_BYTES ? undefined : `${vsixFile} is ${size} bytes`;
    }, () => `${vsixFile}: ${existsSync(vsixFile) ? statSync(vsixFile).size : "?"} bytes`],
  ];
}

const { packagePath, vsix, vsixPath } = parseArgs(process.argv.slice(2));
let pkg;
let idsSource;
let src;
try {
  pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  idsSource = readFileSync(IDS_FILE, "utf8");
  src = sourceFiles();
} catch (err) {
  console.error(`FAIL cannot read inputs: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!isObject(pkg)) {
  console.error(`FAIL ${packagePath} is not a JSON object`);
  process.exit(1);
}

let failed = 0;
for (const [name, run, detail] of vsix ? vsixChecks(pkg, packagePath, vsixPath) : checks(pkg, idsSource, src)) {
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
