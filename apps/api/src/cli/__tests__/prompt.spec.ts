/**
 * 命令行提问的测试
 * ============================================================
 * ★ 这组测试的存在理由，是这段逻辑**没法靠肉眼在终端上验**：
 *
 *   · "密码有没有被回显" —— 手工试十次也未必注意到屏幕上多了几个字符，
 *     而这恰恰是重置密码时最该保证的一件事。
 *   · "连着问三次会不会丢输入" —— 真实终端上偶发，脚本里必现。
 *
 *   把输入输出换成内存流之后，这两条都能断言。
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { Prompter } from '../prompt';

/** 收集所有写出去的内容，用来断言"屏幕上会出现什么" */
function collector(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** 把若干行喂给输入流（模拟用户逐行敲入） */
function feeder(lines: string[]): PassThrough {
  const input = new PassThrough();
  for (const l of lines) input.write(`${l}\n`);
  return input;
}

describe('Prompter', () => {
  it('★ 连着问三次能依次拿到三行，不会丢输入', async () => {
    // 这是踩过的坑：每次提问新建一个 readline 接口时，
    // 第一个接口会吃掉已缓冲的全部输入，后面几行就没了。
    const out = collector();
    const p = new Prompter({ input: feeder(['aaa', 'bbb', 'ccc']), output: out.stream });

    expect(await p.ask('一：')).toBe('aaa');
    expect(await p.ask('二：')).toBe('bbb');
    expect(await p.ask('三：')).toBe('ccc');
    p.close();
  });

  it('★ secret 提问时，用户敲的内容不能出现在输出里', async () => {
    const out = collector();
    const p = new Prompter({ input: feeder(['my-secret-pw']), output: out.stream });

    await p.ask('密码：', { secret: true });
    p.close();

    expect(out.text()).not.toContain('my-secret-pw');
    // 但提示语本身要留着，否则用户不知道在等什么
    expect(out.text()).toContain('密码：');
  });

  it('非 secret 提问时正常回显（证明抑制是有条件的，不是恰好没输出）', async () => {
    const out = collector();
    const p = new Prompter({ input: feeder(['plain-answer']), output: out.stream });

    await p.ask('确认：');
    p.close();

    expect(out.text()).toContain('plain-answer');
  });

  it('secret 提问后回显恢复正常（不会把后面的输入一起吞掉）', async () => {
    const out = collector();
    const p = new Prompter({ input: feeder(['secret-pw', 'visible']), output: out.stream });

    await p.ask('密码：', { secret: true });
    await p.ask('确认：');
    p.close();

    expect(out.text()).not.toContain('secret-pw');
    expect(out.text()).toContain('visible');
  });

  it('空行返回空串（调用方据此判断"用户直接回车了"）', async () => {
    const out = collector();
    const p = new Prompter({ input: feeder(['']), output: out.stream });

    expect(await p.ask('随便：')).toBe('');
    p.close();
  });

  it('close 之后可以再建新会话（close 是幂等的）', () => {
    const out = collector();
    const p = new Prompter({ input: feeder([]), output: out.stream });
    expect(() => {
      p.close();
      p.close();
    }).not.toThrow();
  });
});
