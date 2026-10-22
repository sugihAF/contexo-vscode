// Paths (WP-1.8): a vscode-free core over '/'-separated POSIX paths (Uri.path values), plus
// a small Uri adapter. relPaths are contract paths: '/'-separated, relative to <root>/.contexo/.
// Comparison is case-insensitive on darwin and win32, case-sensitive elsewhere.
import { Uri } from "vscode";

/** True where the default file system compares paths case-insensitively (darwin, win32). */
export function isCaseInsensitive(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** A comparison / map key for p under the platform's case rule. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return isCaseInsensitive(platform) ? p.toLowerCase() : p;
}

/** a and b name the same path under the platform's case rule. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

function trimTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * The '/'-separated path of child below dir (both POSIX paths, e.g. Uri.path), keeping
 * child's own spelling; undefined when child is outside dir or equal to it.
 */
export function relativeUnder(dir: string, child: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const base = `${trimTrailingSlashes(dir)}/`;
  // Compare the prefix itself (lower-casing can change a string's length).
  if (child.length < base.length || pathKey(child.slice(0, base.length), platform) !== pathKey(base, platform)) { return undefined; }
  const rel = trimTrailingSlashes(child.slice(base.length));
  return rel === "" ? undefined : rel;
}

/** The non-empty segments of a '/'-separated relPath. */
export function relPathSegments(relPath: string): string[] {
  return relPath.split("/").filter((s) => s !== "");
}

/** <contexoDir>/<relPath> through Uri.joinPath only: a relPath is never concatenated into a Uri string. */
export function fileUriOf(contexoDir: Uri, relPath: string): Uri {
  return Uri.joinPath(contexoDir, ...relPathSegments(relPath));
}

/**
 * The relPath of a file: or contexo: Uri under contexoDir (a contexo: Uri keeps the working
 * file's path, src/fs/contexoUri.ts); undefined for other schemes or paths outside it.
 */
export function relPathOfUri(contexoDir: Uri, uri: Uri, platform: NodeJS.Platform = process.platform): string | undefined {
  if (uri.scheme !== "file" && uri.scheme !== "contexo") { return undefined; }
  return relativeUnder(contexoDir.path, uri.path, platform);
}

/** True when uri (file: or contexo:) is root itself or below it. */
export function uriContains(root: Uri, uri: Uri, platform: NodeJS.Platform = process.platform): boolean {
  if (uri.scheme !== "file" && uri.scheme !== "contexo") { return false; }
  if (samePath(trimTrailingSlashes(root.path), trimTrailingSlashes(uri.path), platform)) { return true; }
  return relativeUnder(root.path, uri.path, platform) !== undefined;
}
