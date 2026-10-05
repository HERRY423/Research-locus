// Installed-plugin entrypoint: persistent data must live outside the plugin cache.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Research Locus requires Node.js 22 or newer.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.LOCUS_DATA_DIR || join(
  process.platform === 'win32' ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ResearchLocus');
process.env.LOCUS_STATE_PATH ||= join(dataRoot, 'state.json');
process.env.LOCUS_CATALOG_DIR ||= join(dirname(process.env.LOCUS_STATE_PATH), 'catalog');
const entry = join(root, 'dist', 'server.js');
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
