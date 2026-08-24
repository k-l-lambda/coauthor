import { readLineFile } from "../doc/linefile.js";
import { splitBlocks, findAnnotations, type Block } from "../doc/blocks.js";
import { renderNumbered, stats } from "../doc/number.js";
import { expandAgentMd, type Include } from "./agentmd.js";
import { toPosix, type Project } from "../project.js";

const BASE = `你是一个写作助手，通过一组专用工具直接编辑稿件。你没有 shell、没有通用文件读写，
所有改动都通过下面 5 个工具完成。

## 定位方式

下面「当前正文」一节给出了正文全文，每个自然段前带有 \`NNN│\` 形式的序号（标题也占号）。
序号是本工具为定位加上的**外部标记，不是稿件内容**——写回的文本一律不要带序号前缀，
也不要带 \`│\`。

## 工具

- \`read_draft(from?, to?)\` — 重新读取带序号的正文片段。**每次写入后序号会移位，
  需要继续改别处时先用它取最新序号。**
- \`read_setting(file, heading)\` — 按标题读设定文档中的某一节。已经在提示词里
  完整给出的设定文档不必再读。
- \`revise(from, to, expect, text)\` — 用 \`text\` 替换第 \`from\` 到第 \`to\` 个自然段
  （含两端）。\`text\` 传空字符串即删除这些段落。
- \`insert(after, expect, text)\` — 在第 \`after\` 个自然段之后插入。
- \`append(text)\` — 追加到正文末尾。

写工具只能改正文。设定文档是只读的。

## expect 参数

\`revise\` 和 \`insert\` 需要 \`expect\`：被定位那个自然段**开头的至少 4 个字符**，
从正文原文照抄。序号对不上时写入会被拒绝并报错，而不是改错地方。

## 附注协议

正文里出现单独一行 \`---\` 时，它**上方**的段落是被批注的对象，**下方**的段落是批注内容。
改写方式是**一次 \`revise\`**：\`from\` 取被批注段落的序号，\`to\` 取批注文字的序号，
\`text\` 传改写后的正文。这样目标段、\`---\`、批注文字在同一次操作中一起被替换，
标记自动消失，不需要第二步去删。批注常常也要求调整紧随其后的若干段落，
必要时把 \`to\` 往后扩。

\`[[……]]\` 形式的段落是建议性行文，按其中提示重写，不要照搬，省略号处需补全。
用 \`revise(N, N, expect, 新正文)\` 替换。

## 同一轮内改多处

同一轮内要改多个位置时，**从序号大的往小的改**，这样前面的序号不会失效。
或者每次写入后用返回的新序号表，或重新 \`read_draft\`。`;

export interface PromptContext {
  system: string;
  blocks: Block[];
  includes: Include[];
  draftCodepoints: number;
  pendingAnnotations: number;
}

/**
 * Assemble the system prompt from three layers: this harness's tool contract, the
 * project's AGENT.md with its includes expanded, and the full numbered draft.
 *
 * Rebuilt from disk every turn. Because sessions do not accumulate, the prompt is
 * always the current state of the files — there is no cross-turn staleness, and
 * writes from the previous turn are simply visible in the next one.
 */
export function buildPrompt(project: Project): PromptContext {
  const { text: agentMd, includes } = expandAgentMd(project.agentPath, project.root);
  const draft = readLineFile(project.draftPath);
  const blocks = splitBlocks(draft);
  const s = stats(blocks);
  const pending = findAnnotations(blocks);

  const pendingNote = pending.length
    ? `\n\n本轮有 ${pending.length} 处待处理标记：` +
      pending
        .map((a) =>
          a.kind === "note" ? `第 ${a.from}–${a.to} 段（\`---\` 附注）` : `第 ${a.from} 段（骨架段）`,
        )
        .join("、") +
      "。"
    : "";

  const system = [
    BASE,
    `# 写作要求\n\n${agentMd.trim()}`,
    `# 当前正文（${toPosix(project.root)}/${project.draftName}，共 ${s.blocks} 段，` +
      `${s.codepoints} 字）${pendingNote}\n\n${renderNumbered(blocks)}`,
  ].join("\n\n---\n\n");

  return {
    system,
    blocks,
    includes,
    draftCodepoints: s.codepoints,
    pendingAnnotations: pending.length,
  };
}
