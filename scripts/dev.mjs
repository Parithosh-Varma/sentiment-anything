import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

const kids = [];

function run(script, label, color) {
  const child = spawn(node, [script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited (${code})\n`);
    shutdown();
  });
  kids.push(child);
}

function shutdown() {
  for (const k of kids) {
    if (!k.killed) k.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

run('server/index.mjs', 'server', '36');
setTimeout(() => run('cli/watch.mjs', 'watch', '35'), 600);
