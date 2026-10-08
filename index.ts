// Directory-loading entrypoint.
//
// When this plugin is loaded from a local directory (a `plugins` entry with a
// relative/absolute/file:// path, or a copy under `.opencode/plugins/` or
// `~/.config/opencode/plugins/`), the v2 host resolves `<directory>/index.ts`
// directly and does not consult `package.json` exports. Published installs
// resolved by package name use `./src/index.ts` through the exports map.
// Both entries share the same implementation below.
import definition from "./src/index.js";

export default definition;
