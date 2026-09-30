/**
 * 命令行交互提问
 * ============================================================
 * ★ 为什么单独抽出来，而且输入输出是**注入**的
 *
 *   重置密码要连着问三次（新密码、确认密码、确认执行），
 *   而"连着问"这件事踩过坑：最初每次提问都新建一个 readline 接口，
 *   第一个接口会把 stdin 里已缓冲的全部输入吃掉，关掉之后后面几行就丢了 ——
 *   表现为"密码输了两遍、yes 也输了，结果什么都没发生、退出码还是 0"。
 *
 *   所以这里约束成：**一个会话只有一个 readline 接口**。
 *
 *   输入输出做成参数注入，是为了能在单元测试里用内存流驱动它 ——
 *   否则这段逻辑只能在真实终端上手工试，而"密码有没有被回显"
 *   恰恰是最需要断言、又最容易被忽略的一条。
 */

import { createInterface, type Interface } from 'node:readline';

/** 提问需要的最小流接口。真实运行时就是 process.stdin / process.stdout */
export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

interface WritableWithWrite extends NodeJS.WritableStream {
  write(chunk: unknown, encoding?: unknown, cb?: unknown): boolean;
}

export class Prompter {
  private rl: Interface | null = null;
  private suppressEcho = false;

  constructor(private readonly streams: PromptStreams) {}

  private ensureReadline(): Interface {
    if (this.rl) return this.rl;

    const out = this.streams.output as WritableWithWrite;
    const originalWrite = out.write.bind(out);

    /*
     * 接管输出流：在需要保密的提问期间，把 readline 回显的字符吞掉。
     *
     * 判据是"只放行换行"。readline 在终端模式下会把用户敲的每个字符
     * 通过 output.write 回显出去（还有退格之类的控制序列），
     * 这些都必须拦住，否则密码会明晃晃地留在屏幕上 ——
     * 而重置密码时旁边常常有人在看。
     */
    out.write = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
      if (this.suppressEcho) {
        const text = String(chunk);
        if (text === '\n' || text === '\r\n') {
          return originalWrite(text, encoding, cb);
        }
        return true; // 吞掉
      }
      return originalWrite(chunk, encoding, cb);
    };

    this.rl = createInterface({
      input: this.streams.input,
      output: this.streams.output,
      terminal: true,
    });
    return this.rl;
  }

  /**
   * 提一个问题，等一个答案。
   *
   * 提示语由我们自己写（不交给 readline 的 question 首参），
   * 否则它会被上面的回显抑制一起吞掉。
   */
  ask(question: string, opts: { secret?: boolean } = {}): Promise<string> {
    const rl = this.ensureReadline();
    return new Promise((resolve) => {
      // ★ 顺序很重要：**先写提示语，再开回显抑制**。
      //   反过来的话提示语本身会被当成"用户敲的字符"一起吞掉，
      //   用户面对一个空屏，不知道程序在等什么。
      //   （这条是被 prompt.spec.ts 抓出来的，肉眼在终端上很难注意到
      //      "少了一行提示"和"程序卡住了"的区别。）
      this.streams.output.write(question);
      this.suppressEcho = opts.secret === true;

      // ★ 每问一次前 resume、答完 pause，不能省。
      //   readline 只在 question() 被调用时才装好"下一行"的监听；
      //   若输入流一直处在上游可读状态，**先到的行会被直接丢弃** ——
      //   一次性喂入多行（管道、脚本、`echo -e` 那一类）时必然丢数据，
      //   表现为"三行只读到一行，然后卡死"。
      //   真实终端下用户是看到提示才敲，所以这个洞只在非交互场景暴露。
      rl.resume();
      rl.question('', (answer) => {
        this.suppressEcho = false;
        rl.pause();
        resolve(answer);
      });
    });
  }

  /** 关闭底层接口。不关会让进程挂住不退出 */
  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}
