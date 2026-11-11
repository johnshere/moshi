/**
 * 钩子文本清洗（`src/core/hook/clean.ts`）单测。
 *
 * 夹具都抄自真实库（`~/.moshi/moshi.db` 的 `query_log.query_text` 与
 * `~/.moshi/hook/trace.jsonl`）：ACP 引用标记、压缩段、时间采样三连行、
 * 宿主提醒块、折叠媒体、后台起标题提示。
 */
import { describe, expect, it } from 'vitest';

import { cleanHookText } from '../../src/core/hook/clean.js';

describe('cleanHookText：宿主脚手架', () => {
  it('剥掉 ACP 引用标记，保留用户正文', () => {
    const raw = [
      '<acp tokens="75" type="text" time="2026-11-11 19:57:40">m03908</acp>',
      '那么先做清洗。就以现在库里记录的数据做测试。',
      '先只做清洗的代码',
    ].join('\n');
    expect(cleanHookText(raw)).toBe(
      ['那么先做清洗。就以现在库里记录的数据做测试。', '先只做清洗的代码'].join('\n'),
    );
  });

  it('行内 ACP 标记也去掉', () => {
    expect(cleanHookText('继续<acp tokens="1">m00012</acp>做')).toBe('继续做');
  });

  it('剥掉压缩段（含续行与小标题），保留段后的用户正文', () => {
    const raw = [
      '[Compressed conversation section] — / m03890–m03891 源码取证（harvest 相关读取）',
      '【目的】回答用户 m03879 的"harvest 才是重点"。',
      '- `src/core/hook/capture.ts`（130 行）：`captureSignal` 把信封变成 `RawEvent` 后交 `ingestEvent`。',
      '- `src/core/write/ingest.ts:76-126 ingestEvent`：纯文本事件只写 episode。',
      '',
      '1',
    ].join('\n');
    expect(cleanHookText(raw)).toBe('1');
  });

  it('只有时间采样三连行时判空', () => {
    const raw = [
      'Time sampled while preparing turn 26, step 9: 2026-11-11T19:54:53+08:00[Asia/Shanghai]',
      'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.',
      'Elapsed since the preceding step context: unavailable.',
    ].join('\n');
    expect(cleanHookText(raw)).toBe('');
  });

  it('剥掉 system-reminder 大块，保留块外正文', () => {
    const raw = [
      '<system-reminder>',
      'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:',
      '- `accounts`: 账号簿',
      '</system-reminder>',
      '继续',
    ].join('\n');
    expect(cleanHookText(raw)).toBe('继续');
  });

  it('后台起标题提示整段判空（不是用户意图）', () => {
    const raw =
      '以下是这条会话的对话记录（JSON）：\n[{"role":"user","seq":9,"text":"先启动"}]\n\n请为它写一行标题。';
    expect(cleanHookText(raw)).toBe('');
  });

  it('剥掉折叠媒体占位', () => {
    const raw = ['[folded images: [image: png 1600x900 · m03681]]', '看看这张图'].join('\n');
    expect(cleanHookText(raw)).toBe('看看这张图');
  });

  it('压缩段中间有空行也整段丢掉，段后正文保留', () => {
    const raw = [
      '[Compressed conversation section] — 主题',
      '【目的】xxx',
      '- 要点一',
      '',
      '【Open objectives】①还在跑',
      '- 要点二',
      '',
      '真正的正文',
    ].join('\n');
    expect(cleanHookText(raw)).toBe('真正的正文');
  });

  it('压缩段标题跟在半句正文后：半句保留，摘要丢掉', () => {
    const raw = ['先看结论 → 结论链：[Compressed conversation section] — 主题', '- 要点一', '下一句'].join('\n');
    expect(cleanHookText(raw)).toBe(['先看结论 → 结论链：', '下一句'].join('\n'));
  });

  it('压缩提醒（billion-context nudge）整段判空', () => {
    const raw = [
      'This is an efficiency nudge to compress early and keep context lean — not an overflow warning.',
      '',
      'Compression Philosophy:',
      '- All compression serves the primary task, but be frugal.',
    ].join('\n');
    expect(cleanHookText(raw)).toBe('');
  });

  it('后台任务通知整段判空，正文里的 Open objectives 段落也丢弃', () => {
    expect(cleanHookText('background job pwsh-1 (...) finished [status: completed, exit code: 1]. No new output.')).toBe('');
    const raw = ['Open objectives（仍有效）：① 改 vue.config.js', '- 细节', '', '继续做清洗'].join('\n');
    expect(cleanHookText(raw)).toBe('继续做清洗');
  });

  it('普通正文原样保留，只做首尾裁剪', () => {
    expect(cleanHookText('  把 query 清洗掉  ')).toBe('把 query 清洗掉');
  });

  it('清洗后只剩标点/空白时判空', () => {
    expect(cleanHookText('<acp tokens="1">m00001</acp>\n\n---')).toBe('');
  });

  it('空输入返回空串', () => {
    expect(cleanHookText('')).toBe('');
    expect(cleanHookText('   ')).toBe('');
  });
});
