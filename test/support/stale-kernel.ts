import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';

// 用法：node test/support/stale-kernel.ts <home 根目录>
// 冒充一个内核：把自己的 pid 写进 <根>/kernel.pid，在 <根>/kernel.sock 上 listen，打印 ready，然后一直等着。
// 测试把它强杀，造出「被强杀的内核留下的残留」。
const root = process.argv[2];
if (root === undefined || !isAbsolute(root)) {
  process.stderr.write('usage: node test/support/stale-kernel.ts <absolute home root>\n');
  process.exit(2);
}
writeFileSync(join(root, 'kernel.pid'), String(process.pid), { mode: 0o600 });
createServer().listen(join(root, 'kernel.sock'), () => {
  process.stdout.write('ready\n');
});
