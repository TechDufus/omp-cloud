import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height from a PNG's IHDR chunk (big-endian u32 at offsets 16 and 20), or undefined when `bytes` is not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface ImageRef {
  /** Site-root-relative path, e.g. `assets/img/hero.png`. */
  file: string;
  width?: number;
  height?: number;
}

export interface ImageRegistry {
  /** Register a repo-relative image; its basename must be unique among registered images. */
  add(repoPath: string): ImageRef;
  /** Register `docs/assets/<name>.png`. */
  shot(name: string): ImageRef;
  /** Copy every registered image to `<out>/assets/img/<basename>`. */
  copyAll(out: string): void;
}

export function createImages(root: string): ImageRegistry {
  const byName = new Map<string, { path: string; ref: ImageRef }>();
  const registry: ImageRegistry = {
    add(repoPath) {
      const name = basename(repoPath);
      const known = byName.get(name);
      if (known) {
        if (known.path !== repoPath) throw new Error(`site: two images named ${name}`);
        return known.ref;
      }
      const absolute = join(root, repoPath);
      if (!existsSync(absolute)) throw new Error(`site: image ${repoPath} does not exist`);
      const size = pngSize(readFileSync(absolute));
      const ref: ImageRef = size ? { file: `assets/img/${name}`, ...size } : { file: `assets/img/${name}` };
      byName.set(name, { path: repoPath, ref });
      return ref;
    },
    shot(name) {
      return registry.add(`docs/assets/${name}.png`);
    },
    copyAll(out) {
      const dir = join(out, "assets", "img");
      mkdirSync(dir, { recursive: true });
      for (const [name, { path }] of byName) copyFileSync(join(root, path), join(dir, name));
    },
  };
  return registry;
}
