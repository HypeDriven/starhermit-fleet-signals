// Converts tools/ui-style.css (the browser build's css/main.css rewritten
// class-based) into assets/ui-style.json with `starhermit css`, and prints
// what it dropped. STARHERMIT names the runtime (default: the published
// 1.27.0 Linux runtime under ~/sh/runtime).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.27.0/starhermit-1.27.0-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
if (!exe) { console.error('set STARHERMIT to the engine runtime'); process.exit(1); }
execFileSync(exe, ['css', 'tools/ui-style.css', '--out', 'assets/ui-style.json', '--font-size', '16', '--path', 'tools/ui-style.css'], { cwd: root, stdio: 'inherit' });
