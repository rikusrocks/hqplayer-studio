import { createInterface } from 'node:readline';
import type { GateIO, StepAnswer } from './run';

/** Interactive console for hqp-gatec.exe. */
export function consoleIO(): GateIO & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const q = (prompt: string) => new Promise<string>((resolve) => rl.question(prompt, resolve));
  return {
    print: (text) => console.log(text),
    async confirm(id, summary): Promise<StepAnswer> {
      console.log(`\n[${id}] ${summary}`);
      const a = (
        await q(
          '  回车 = 执行 / Enter = run   s = 跳过 / skip   q = 中止并恢复 / abort & restore > ',
        )
      )
        .trim()
        .toLowerCase();
      return a === 'q' ? 'quit' : a === 's' ? 'skip' : 'go';
    },
    async ask(question, choices) {
      const keys = Object.keys(choices);
      const hint = keys.map((k) => `${k} = ${choices[k]}`).join('   ');
      for (;;) {
        const a = (await q(`  ${question}\n    ${hint} > `)).trim().toLowerCase();
        if (keys.includes(a)) return a;
        console.log(`    请输入 / please type: ${keys.join(' / ')}`);
      }
    },
    text: (question) => q(`\n${question}\n> `),
    close: () => rl.close(),
  };
}
