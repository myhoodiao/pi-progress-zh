import { posix, win32 } from "node:path";
import { VERSION, type ExtensionAPI, type MarkdownTransformContext, type Theme, type ToolRenderContext, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, parseColor, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export const PLUGIN_VERSION = "0.10.1";
export const TESTED_PI_VERSIONS = ["1.3.0", "1.4.0"];
// These releases have identical assistant/tool spacing components. Unknown releases retain native spacing.
const SPACING_SUPPORTED = TESTED_PI_VERSIONS.includes(VERSION);
const STAGE_GAP = 2;
// Independent visual options: G+H+I+J uses INTRA_GAP = 2 and ENABLE_DITTO = false.
const INTRA_GAP = 2; // K: set to 1 for tighter spacing within a narration node.
const ENABLE_DITTO = false; // L: repeated completed tools in the same group use ·.
const FILE_COLOR = parseColor("#C9BA9A");
const NEUTRAL_DARK = parseColor("#B5BEBF");
const NEUTRAL_LIGHT = parseColor("#3E4E53");
const DIR_FILE_DARK = parseColor("#8E846E");
const DIR_FILE_LIGHT = parseColor("#8C826E");
const DIR_DARK = parseColor("#7A8588");
const DIR_LIGHT = parseColor("#687377");
const RANGE_DARK = parseColor("#6E797C");
const RANGE_LIGHT = parseColor("#687377");
const SEP_DARK = parseColor("#5F696C");
const SEP_LIGHT = parseColor("#788286");
const ADDED_DARK = parseColor("#8FB58D");
const ADDED_LIGHT = parseColor("#4A7A4C");
const SOFT_ERROR_DARK = parseColor("#D99083");
const SOFT_ERROR_LIGHT = parseColor("#A65B52");
const RAIL_DARK = parseColor("#4F5550");
const RAIL_LIGHT = parseColor("#8C8574");
export const NARRATION_RULES = [
  "任务过程说明：所有面向用户的节点说明必须使用简体中文，命令、路径和代码标识符保留原文。处理需要操作的任务时，在开始、关键发现、方向调整和进入验证等有意义的节点，用普通可见助手文字给用户一至两句简体中文说明。说明当前判断或事实及下一步，用非专业用户能理解的表达；不要引用、翻译或展示原生 thinking。每条说明独立成段，用单个星号包住整个段落（*说明文字*），段内不要再加 Markdown 格式。最终答复正常排版，不使用整段斜体的说明格式。",
  "过程说明按任务节点出现，不按工具次数或模型轮次出现；每个节点只用一个简短说明段落，尽量与随后实际工具调用在同一响应中输出，不额外插入空白段落。不要逐条播报命令，不要重复没有变化的状态，不要为说明另调用工具或模型。简单问题直接回答，无需凑齐所有节点。",
  "工具默认显示简短操作摘要，Ctrl+O 展开详情。重要失败、验证结果和方向变化应在普通可见文字中说明；区分准备执行、正在执行、已经完成和未验证，不能把已启动的操作描述为已撤销。最终答复仍正常给出结果及必要限制。",
] as const;

const nativeSlot = Symbol("progress-native-renderer");
const imageSlot = Symbol("progress-result-has-images");
const diffSlot = Symbol("progress-result-diff-counts");
const priorityKeys = ["file_path", "path", "paths", "url", "uri", "resource", "resource_uri", "query", "pattern", "command", "cmd", "code"];
const bodyKeys = /^(content|text|oldText|newText|old_string|new_string|data|base64|body|code|script)$/i;
interface DiffCounts { added: number; removed: number; }
function countTextLines(value: unknown): number {
  if (typeof value !== "string" || !value) return 0;
  const trimmed = value.replace(/\r?\n$/, "");
  return trimmed ? trimmed.split(/\r?\n/).length : 0;
}
function diffLineCounts(oldValue: unknown, newValue: unknown): DiffCounts {
  const oldStr = typeof oldValue === "string" ? oldValue : "";
  const newStr = typeof newValue === "string" ? newValue : "";
  if (!oldStr && !newStr) return { added: 0, removed: 0 };
  const oldLines = oldStr ? oldStr.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const newLines = newStr ? newStr.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const a = oldLines.slice(start, oldEnd), b = newLines.slice(start, newEnd);
  if (!a.length || !b.length || a.length * b.length > 160000) return { added: b.length, removed: a.length };
  const stride = b.length + 1;
  const dp = new Uint16Array(stride * 2);
  for (let i = 0; i < a.length; i++) {
    const prev = (i & 1) * stride, curr = ((i + 1) & 1) * stride;
    for (let j = 0; j < b.length; j++) {
      dp[curr + j + 1] = a[i] === b[j] ? dp[prev + j] + 1 : Math.max(dp[prev + j + 1], dp[curr + j]);
    }
  }
  const lcs = dp[(a.length & 1) * stride + b.length];
  return { added: b.length - lcs, removed: a.length - lcs };
}
function extractDiffCounts(toolName: string, args: any, stored?: DiffCounts): DiffCounts | undefined {
  if (stored && (stored.added > 0 || stored.removed > 0)) return stored;
  if (toolName === "write") {
    const added = countTextLines(args?.content ?? args?.text);
    return added > 0 ? { added, removed: 0 } : undefined;
  }
  if (toolName === "edit") {
    const edits = Array.isArray(args?.edits) ? args.edits
      : (args?.oldText !== undefined || args?.newText !== undefined || args?.old_string !== undefined || args?.new_string !== undefined) ? [args] : [];
    let added = 0, removed = 0;
    for (const entry of edits) {
      if (!entry || typeof entry !== "object") continue;
      const counts = diffLineCounts(entry.oldText ?? entry.old_string, entry.newText ?? entry.new_string);
      added += counts.added;
      removed += counts.removed;
    }
    return added > 0 || removed > 0 ? { added, removed } : undefined;
  }
}
function patchDiffCounts(details: any): DiffCounts | undefined {
  if (typeof details?.patch === "string" && details.patch.trim()) {
    let added = 0, removed = 0;
    for (const line of details.patch.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    if (added > 0 || removed > 0) return { added, removed };
  }
  if (typeof details?.diff === "string" && details.diff.trim()) {
    let added = 0, removed = 0;
    for (const line of details.diff.split(/\r?\n/)) {
      if (/^\s*\+(?!\+)/.test(line)) added++;
      else if (/^\s*-(?!-)/.test(line)) removed++;
    }
    if (added > 0 || removed > 0) return { added, removed };
  }
}
function formatArguments(args: unknown): string {
  try { return JSON.stringify(args, null, 2) ?? String(args); } catch { return "参数无法格式化。"; }
}
function clean(value: unknown): string {
  return typeof value === "string" ? stripTerminalSequences(value).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim() : "";
}
function firstLine(value: unknown): string {
  return typeof value === "string" ? clean(value.split(/\r?\n/).find(line => line.trim()) ?? "") : "";
}

function isPathKey(key: string): boolean { return ["file_path", "path", "paths"].includes(key); }
function target(args: any): { detail: string; path: boolean } {
  if (!args || typeof args !== "object") return { detail: clean(args), path: false };
  for (const key of priorityKeys) {
    const value = args[key];
    const detail = Array.isArray(value) ? value.filter(item => typeof item === "string").map(clean).join(", ")
      : ["command", "cmd", "code"].includes(key) ? firstLine(value) : clean(value);
    if (detail) return { detail, path: isPathKey(key) };
  }
  for (const [key, value] of Object.entries(args)) {
    if (!bodyKeys.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
      return { detail: `${key}=${clean(String(value))}`, path: false };
    }
  }
  return { detail: "", path: false };
}
function stateOf(context: ToolRenderContext): string {
  return context.isError ? "error" : !context.isPartial ? "done" : context.executionStarted ? "running" : "pending";
}
function background(context: ToolRenderContext) {
  return context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
}
/** Remove shell display escapes and edge quotes, never ordinary path/regexp backslashes. */
function cleanDisplayToken(raw: string): string {
  let text = raw.replace(/\\(["$])/g, "$1");
  const pair = text.match(/^(['"])(.*)\1$/);
  if (pair && text.length > 1) text = pair[2];
  for (const quote of ["'", '"']) {
    if ((text.split(quote).length - 1) % 2) {
      if (text.startsWith(quote)) text = text.slice(1);
      if (text.endsWith(quote)) text = text.slice(0, -1);
    }
  }
  return text;
}
function middlePath(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return truncateToWidth(text, width, "…");
  const range = text.match(/:\d+(?:-\d+)?$/)?.[0] ?? "";
  const body = range ? text.slice(0, -range.length) : text;
  const sep = body.match(/[\\/]/)?.[0];
  if (sep) {
    const urlOrigin = body.match(/^[a-z][a-z\d+.-]*:\/\/[^\\/]+/i)?.[0];
    const segs = urlOrigin ? [urlOrigin, ...body.slice(urlOrigin.length).split(/[\\/]/).filter(Boolean)] : body.split(/[\\/]/);
    const last = segs.at(-1)! + range;
    const prefix = segs[0] === "…" ? "…" : `${segs[0]}${sep}…`;
    let candidate = `${prefix}${sep}${last}`;
    if (visibleWidth(candidate) <= width) {
      const tail = [last];
      for (let index = segs.length - 2; index > 0; index--) {
        const next = `${prefix}${sep}${segs[index]}${sep}${tail.join(sep)}`;
        if (visibleWidth(next) > width) break;
        tail.unshift(segs[index]); candidate = next;
      }
      return candidate;
    }
    candidate = `…${sep}${last}`;
    if (visibleWidth(candidate) <= width) return candidate;
  }
  return truncateToWidth(text, width, "…");
}
/** Display-only path labels; no filesystem access or changes to tool arguments. */
class PathLabels {
  private buckets = new Map<string, Set<string>>();
  clear() { this.buckets.clear(); }
  label(raw: string, cwd: string): () => string {
    const quote = /^(['"]).*\1$/.test(raw) ? raw[0] : "";
    const value = quote ? raw.slice(1, -1) : raw;
    if (!value || value === "…" || /^[a-z][a-z\d+.-]*:\/\//i.test(value) || value.startsWith("~") || /^[A-Za-z]:[^\\/]/.test(value)) return () => raw;
    const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value) || (!value.startsWith("/") && (value.includes("\\") || /^[A-Za-z]:[\\/]/.test(cwd)));
    const api = windows ? win32 : posix;
    const normalized = api.normalize(value).replace(/\\/g, "/");
    if (!api.isAbsolute(value)) return () => quote + normalized + quote;
    if (api.isAbsolute(cwd)) {
      const relative = api.relative(cwd, value);
      if (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`)) return () => quote + (relative.replace(/\\/g, "/") || ".") + quote;
    }
    const parts = normalized.split("/").filter(Boolean);
    if (parts.length <= 3) return () => quote + normalized + quote;
    const fold = (text: string) => windows ? text.toLowerCase() : text;
    const bucketKey = `${windows ? "win" : "posix"}:${fold(parts.slice(-3).join("/"))}`;
    const bucket = this.buckets.get(bucketKey) ?? new Set<string>();
    bucket.add(fold(normalized));
    this.buckets.set(bucketKey, bucket);
    // Re-evaluate on repaint: a later same-tail path also disambiguates earlier rows.
    return () => {
      let count = 3;
      while (count < parts.length && [...bucket].some(other => other !== fold(normalized)
        && other.split("/").filter(Boolean).slice(-count).join("/") === fold(parts.slice(-count).join("/")))) count++;
      return quote + (count < parts.length ? `…/${parts.slice(-count).join("/")}` : normalized) + quote;
    };
  }
}
interface SummarySegment { text: string; file?: boolean; path?: boolean; reference?: boolean; suffix?: string; }
interface Summary { title: string; detail: string; path: boolean; fileTitle?: boolean; segments?: SummarySegment[]; subline?: string; preview?: PreviewPart[]; continuation?: string; diff?: DiffCounts; }
function fileSummary(title: string, fileTarget: string, prefix = "", suffix = "", diff?: DiffCounts): Summary {
  return {
    title, detail: fileTarget + suffix, path: true, fileTitle: true,
    segments: [{ text: fileTarget, file: true, path: true, suffix }], subline: prefix ? prefix.trim() : undefined,
    diff: diff && (diff.added > 0 || diff.removed > 0) ? diff : undefined,
  };
}
/** Accept literal operands only. This is display parsing, never shell execution. */
function literalTokens(value: string): string[] | undefined {
  if (value.trim().split(/\r?\n/).length !== 1 || /[`$]/.test(value)) return;
  const source = value.trim();
  const tokens = source.match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  if (tokens.join(" ") !== source.replace(/\s+/g, " ") || tokens.some(token => !/^['"]/.test(token) && /[;&|<>#()]/.test(token))) return;
  return tokens;
}
function pathSegments(values: string[], file: boolean): SummarySegment[] {
  return values.flatMap((text, index) => [...(index ? [{ text: ", " }] : []), { text: clean(text), path: true, file }]);
}
function literalCommandTarget(value: string): { segments: SummarySegment[]; file: boolean } | undefined {
  const tokens = literalTokens(value);
  if (!tokens?.length) return;
  const verb = tokens[0].split(/[\\/]/).pop()?.replace(/\.exe$/i, "").toLowerCase();
  const operands: string[] = [];
  let endOptions = false;
  const valued = new Set(["-encoding", "-first", "-last", "-totalcount", "-tail", "-filter", "-include", "-exclude"]);
  const flags = new Set(["-r", "-R", "-f", "-v", "-p", "-a", "-l", "-la", "-al", "-n", "-force", "-recurse", "-raw", "-file", "-directory"]);
  const files = new Set(["ls", "cat", "type", "cp", "mv", "rm", "get-content", "get-childitem", "copy-item", "move-item", "remove-item"]);
  if (verb && files.has(verb)) {
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i], lower = token.toLowerCase();
      if (!endOptions && token === "--") { endOptions = true; continue; }
      if (!endOptions && ["-literalpath", "-path", "-destination"].includes(lower)) {
        if (!tokens[i + 1] || tokens[i + 1].startsWith("-")) return;
        operands.push(tokens[++i]); continue;
      }
      if (!endOptions && valued.has(lower)) { if (!tokens[++i]) return; continue; }
      if (!endOptions && token.startsWith("-")) { if (!flags.has(token) && !flags.has(lower)) return; continue; }
      operands.push(token);
    }
    if (!operands.length || (["cp", "mv", "copy-item", "move-item"].includes(verb) && operands.length !== 2)) return;
    return { segments: pathSegments(operands, true), file: true };
  }
  if (verb === "rg" || verb === "grep") {
    let pattern = false;
    const searchFlags = new Set(["-n", "--line-number", "-i", "--ignore-case", "-s", "-S", "--smart-case", "-F", "--fixed-strings", "-l", "--files-with-matches", "--hidden", "--no-ignore", "-r", "-R", "-q", "--quiet", "-w", "--word-regexp"]);
    const searchValues = new Set(["-g", "--glob", "-t", "--type", "-T", "--type-not", "-m", "--max-count", "-A", "-B", "-C", "--context", "--encoding"]);
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!endOptions && token === "--") { endOptions = true; continue; }
      if (!endOptions && ["-e", "--regexp"].includes(token)) { if (!tokens[++i]) return; pattern = true; continue; }
      if (!endOptions && searchValues.has(token)) { if (!tokens[++i]) return; continue; }
      if (!endOptions && token.startsWith("-")) { if (!searchFlags.has(token)) return; continue; }
      if (!pattern) pattern = true; else operands.push(token);
    }
    if (operands.length) return { segments: pathSegments(operands, false), file: false };
  }
  if (["node", "python", "python3", "py"].includes(verb ?? "")) {
    const rest = tokens.slice(1);
    if (verb === "node" && rest[0] === "--test") {
      const tests = rest.slice(1);
      if (tests.length && tests.every(file => !file.startsWith("-") && /\.(?:[cm]?[jt]s|tsx)["']?$/i.test(file))) return { segments: pathSegments(tests, false), file: false };
      return;
    }
    const file = rest[0];
    if (file && !file.startsWith("-") && /\.(?:[cm]?js|tsx?|py)["']?$/i.test(file)) {
      return { segments: pathSegments([file], false), file: false };
    }
  }
}
interface PreviewPart { text: string; priority: number; compact?: string; }
interface CommandScan { steps: string[]; operators: string[]; complete: boolean; }
/** A display lexer, not a shell interpreter. Quotes and nested expressions stay opaque. */
function scanCommand(source: string): CommandScan {
  const steps: string[] = [], operators: string[] = [];
  let start = 0, quote = "", depth = 0, comment = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment) { if (ch !== "\n") continue; comment = false; }
    if (ch === "`" || (ch === "\\" && /["'|;&\s]/.test(next ?? ""))) { i++; continue; }
    if (quote) { if (ch === quote) { if (quote === "'" && next === "'") i++; else quote = ""; } continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /\s/.test(source[i - 1]))) { comment = true; continue; }
    if ("([{".includes(ch)) { depth++; continue; }
    if (")]}".includes(ch)) { depth = Math.max(0, depth - 1); continue; }
    if (!depth && /[|;&\n]/.test(ch)) {
      const step = source.slice(start, i).trim();
      if (step) steps.push(step);
      const op = next === ch && /[|&]/.test(ch) ? ch + source[++i] : ch;
      if (step) operators.push(op);
      start = i + 1;
    }
  }
  const last = source.slice(start).trim();
  if (last) steps.push(last);
  return { steps, operators, complete: !quote && !depth };
}
function commandWords(source: string): string[] {
  // Keep quoted strings and script blocks intact so their contents never become operands.
  const words: string[] = [];
  let start = 0, quote = "", depth = 0;
  for (let i = 0; i <= source.length; i++) {
    const ch = source[i] ?? " ";
    if (ch === "`" || (ch === "\\" && /["'\s]/.test(source[i + 1] ?? ""))) { i++; continue; }
    if (quote) { if (ch === quote) { if (quote === "'" && source[i + 1] === "'") i++; else quote = ""; } continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (!depth && /\s/.test(ch)) { if (i > start) words.push(source.slice(start, i)); start = i + 1; }
  }
  return words;
}
function unquoteWord(value: string): string { return /^(?:'[^']*'|"[^"]*")$/.test(value) ? value.slice(1, -1) : value; }
function programName(value: string): string { return unquoteWord(value).split(/[\\/]/).pop()?.replace(/\.(?:exe|cmd|bat)$/i, "") ?? value; }
function textSegments(value: string): SummarySegment[] { return [{ text: clean(value) }]; }
function primarySummary(title: string, detail: string, preview?: PreviewPart[]): Summary {
  return { title, detail: clean(detail) || "…", path: false, preview };
}
function referenceTarget(value: string): string {
  const raw = clean(value);
  const registry = raw.replace(/^Registry::/i, "").replace(/^HKEY_LOCAL_MACHINE/i, "HKLM").replace(/^HKEY_CURRENT_USER/i, "HKCU").replace(/^HKEY_CLASSES_ROOT/i, "HKCR").replace(/^HKEY_USERS/i, "HKU");
  if (!/^HK(?:LM|CU|CR|U|CC)(?::)?[\\/]/i.test(registry)) return raw;
  const parts = registry.split(/[\\/]/);
  return parts.length > 4 ? `${parts[0]}/…/${parts.slice(-2).join("/")}` : registry.replace(/\\/g, "/");
}
function previewText(parts: PreviewPart[], width: number): string {
  if (width < 1 || !parts.length) return "";
  const chosen = parts.map((part, index) => ({ ...part, index }));
  const assemble = () => chosen.map((part, i) => `${part.index > (i ? chosen[i - 1].index + 1 : 0) ? "… " : ""}${part.text}`).join(" ") + (chosen.at(-1)?.index !== parts.length - 1 ? " …" : "");
  if (visibleWidth(assemble()) > width) for (const part of chosen) if (part.compact) part.text = part.compact;
  while (chosen.length > 1 && visibleWidth(assemble()) > width) {
    const candidates = chosen.slice(1).filter(part => part.priority < 90);
    if (!candidates.length) break;
    const lowest = candidates.reduce((a, b) => a.priority < b.priority ? a : b);
    chosen.splice(chosen.indexOf(lowest), 1);
  }
  // Reserve the operation and explicit mutation switches before shortening long values.
  let result = assemble();
  if (visibleWidth(result) > width && chosen.length > 1) {
    // Shorten each remaining operation/switch rather than letting one long value
    // push every later operation out of view. The ellipses denote excerpts.
    const gap = chosen.length > 1 ? 3 : 0;
    const budget = Math.max(0, width - gap * (chosen.length - 1));
    result = chosen.map(part => truncateToWidth(part.text, Math.floor(budget / chosen.length), "…")).join(" … ");
  }
  return truncateToWidth(result.replace(/…(?:\s+…)+/g, "…"), width, "…");
}
function optionParts(words: string[], targetIndexes = new Set<number>()): PreviewPart[] {
  const parts: PreviewPart[] = [];
  for (let index = 0; index < words.length; index++) {
    const text = words[index];
    if (/^(?:--?(?:data(?:-raw|-binary)?|header|password|token|body|content|script|message)|-(?:Value|ArgumentList|ScriptBlock|H|d|m))$/i.test(text)) {
      parts.push({ text: `${text} …`, priority: 20 }); index++; continue;
    }
    parts.push({ text: targetIndexes.has(index) ? "…" : clean(text), priority: index === 0 ? 100 : /^(?:--(?:force|hard|delete|recursive|global)|-(?:Recurse|Force|WhatIf|NoClobber|Append|Confirm|f|D)(?::\$?(?:true|false))?)$/i.test(text) ? 95 : targetIndexes.has(index) ? 20 : /^-/.test(text) ? 75 : 60 });
  }
  return parts;
}
/** Only literal syntax is inspected. No script evaluation or invented calls. */
function parsedPowerShell(title: string, source: string, single = false): Summary | undefined {
  const scan = scanCommand(source);
  if (!single) {
    const subjects: SummarySegment[] = [];
    const variables = new Map<string, string>();
    let selected: Summary | undefined, selectedIndex = -1;
    for (let index = 0; index < scan.steps.length; index++) {
      const step = scan.steps[index];
      const literal = step.match(/^\s*(\$\w+)\s*=\s*('([^']*)'|"([^"$`]*)")\s*$/);
      if (literal) { variables.set(literal[1].toLowerCase(), literal[3] ?? literal[4]); continue; }
      const assigned = step.match(/^\s*(\$\w+)\s*=/);
      if (assigned) variables.delete(assigned[1].toLowerCase());
      const summary = parsedPowerShell(title, step, true);
      if (!summary) { variables.clear(); continue; }
      if (!selected) { selected = summary; selectedIndex = index; }
      for (const segment of summary.segments ?? textSegments(summary.detail)) {
        if (segment.text === ", ") continue;
        const value = variables.get(segment.text.toLowerCase());
        const registry = value !== undefined && /^(?:Registry::|HK(?:LM|CU|CR|U|CC)[:\\/])/i.test(value);
        const candidate = value === undefined ? segment : { ...segment, text: referenceTarget(value), path: !registry && !value.includes("$"), reference: registry };
        // Commands without a literal operand are still honest code anchors.
        if (!subjects.some(previous => previous.text === candidate.text)) subjects.push(candidate);
      }
      // A preceding literal assignment is useful only until intervening code runs.
      variables.clear();
    }
    if (!selected) return;
    if (scan.steps.length === 1) return selected;
    const later = scan.steps.slice(selectedIndex + 1);
    const preview = [...(selected.preview ?? [{ text: selected.detail, priority: 100 }])];
    const firstSeparator = scan.operators[selectedIndex];
    // Keep native pipeline punctuation; never turn it into an arrow diagram.
    if (firstSeparator === "|") {
      const pipeline = later.slice(0, Math.max(0, later.findIndex((_, offset) => scan.operators[selectedIndex + 1 + offset] !== "|") + 1) || later.length);
      for (const step of pipeline) {
        const verb = step.match(/^([A-Za-z]+-[A-Za-z]+)/)?.[1];
        if (/^(?:Format-|Out-)/i.test(verb ?? "")) { preview.push({ text: "…", priority: 10 }); break; }
        if (/^Sort-Object$/i.test(verb ?? "")) preview.push({ text: `| ${excerptPayload(step)}`, priority: 85 });
        else if (/^Select-Object$/i.test(verb ?? "")) {
          preview.push({ text: `| ${verb}`, priority: 70 });
          preview.push(...commandWords(step).slice(1).map(word => ({ text: /[{}]/.test(word) ? "…" : word, priority: /[{}]/.test(word) ? 10 : 60 })));
        } else if (/^Where-Object$/i.test(verb ?? "")) {
          const filter = step.match(/\$_\.[A-Za-z_]\w*\s+-(?:eq|like|match|in|contains)\s+(?:'[^']*'|"[^"]*")/i)?.[0];
          preview.push({ text: filter ? `… ${filter}` : "| Where-Object …", priority: 85 });
        } else if (/^ForEach-Object$/i.test(verb ?? "")) preview.push({ text: "| ForEach-Object …", priority: 70 });
        else preview.push({ text: `| ${excerptPayload(step)}`, priority: /^(?:Remove|Set|Stop|Restart|Disable)-/i.test(verb ?? "") ? 95 : 70 });
      }
    }
    const chained = scan.operators.slice(selectedIndex).find(op => op !== "|");
    const segments = subjects.flatMap((segment, index) => [...(index ? [{ text: ", " }] : []), segment]);
    return { ...selected, segments, fileTitle: false, preview,
      continuation: chained ? chained === "\n" ? "…" : `${chained} …` : undefined };
  }
  const head = source.trim();
  const match = head.match(/^(?:(\$\w+\s*=\s*)|\(\s*)?([A-Za-z]+-[A-Za-z][\w-]*)\b/);
  if (!match || !/^(?:Get|Set|New|Remove|Copy|Move|Rename|Test|Start|Stop|Restart|Enable|Disable|Register|Unregister|Invoke|Measure|Resolve|Join|Import|Export|Add|Clear)-/i.test(match[2])) return;
  const verb = match[2];
  const words = commandWords(head.slice(head.indexOf(verb)).replace(/\)\.[A-Za-z_]\w*\s*$/, ""));
  const fields = new Map<string, { value: string; index: number }>();
  const positional: { value: string; index: number }[] = [];
  const switches = /^-(?:Recurse|Force|Raw|File|Directory|WhatIf|NoClobber|Append|PassThru|Confirm)(?::\$?(?:true|false))?$/i;
  const ignored = /^-(?:ErrorAction|WarningAction|InformationAction|Verbose|Debug|OutVariable|OutBuffer)$/i;
  const parts: PreviewPart[] = [{ text: `${match[1] ?? ""}${verb}`, compact: match[1] ? `… ${verb}` : undefined, priority: 100 }];
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith("#")) break;
    if (ignored.test(word)) { if (!/^-(?:Verbose|Debug)$/i.test(word)) i++; parts.push({ text: "…", priority: 10 }); continue; }
    if (switches.test(word)) { parts.push({ text: word, priority: 95 }); continue; }
    if (/^-\w+$/.test(word) && words[i + 1] && !/^-\w/.test(words[i + 1])) {
      const index = ++i;
      let value = words[i];
      while (value.endsWith(",") && words[i + 1] && !words[i + 1].startsWith("-")) value += " " + words[++i];
      fields.set(word.toLowerCase(), { value, index });
      const hidden = /^-(?:Value|Body|Content|ArgumentList|ScriptBlock|Headers)$/i.test(word);
      const object = /^-(?:LiteralPath|Path|Uri|ClassName|TaskName|Name|Id|Destination|NewName)$/i.test(word);
      parts.push({ text: `${word} ${hidden ? "…" : value}`, priority: hidden ? 10 : object ? 20 : 85 });
    } else {
      if (!word.startsWith("-")) positional.push({ value: word, index: i });
      parts.push({ text: word, priority: word.startsWith("-") ? 75 : 20 });
    }
  }
  const key = ["-literalpath", "-path", "-uri", "-classname", "-taskname", "-name", "-id", "-computername"].find(name => fields.has(name));
  const operand = key ? fields.get(key) : positional[0];
  if (key && key !== "-name") for (const part of parts) if (/^-Name\s/i.test(part.text)) part.priority = 85;
  const subject = operand ? referenceTarget(unquoteWord(operand.value)) : verb;
  const isFile = /^(?:Get-Content|Set-Content|Add-Content|Copy-Item|Move-Item|Remove-Item|Rename-Item|Get-ChildItem|Test-Path|Resolve-Path)$/i.test(verb)
    && !!operand && !/Registry::|^HK(?:LM|CU|CR|U)|\$|[{}(),]/i.test(unquoteWord(operand.value));
  const targets = isFile ? pathSegments([operand!.value], true)
    : /^HK(?:LM|CU|CR|U|CC)(?::)?[\\/]/i.test(subject) ? [{ text: subject, reference: true }] : textSegments(subject);
  const destination = fields.get("-destination") ?? fields.get("-newname");
  if (destination) targets.push({ text: ", " }, ...pathSegments([destination.value], true));
  const simple = !operand && words.length === 1 && !match[1];
  return { title, detail: subject, path: false, segments: targets, preview: simple ? undefined : parts };
}

/** Elide known argument bodies, not operation names or execution history. */
function excerptPayload(source: string, opaque = false): string {
  const words = commandWords(source);
  let cursor = 0, result = "";
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    const start = source.indexOf(word, cursor);
    if (start < cursor) continue;
    result += source.slice(cursor, start);
    if (/^(?:--(?:data(?:-raw|-binary)?|form|header|password|token|body|content|message)=)/i.test(word)) {
      result += word.slice(0, word.indexOf("=") + 1) + "…";
    } else if (/^(?:--(?:data(?:-raw|-binary)?|form|header|password|token|body|content|message)|-(?:Value|Body|Content|ArgumentList|ScriptBlock|Headers|H|d|m|u))$/i.test(word)) {
      result += word;
      const value = words[index + 1];
      if (value) { const valueStart = source.indexOf(value, start + word.length); cursor = valueStart + value.length; result += " …"; index++; continue; }
    } else result += word;
    cursor = start + word.length;
  }
  result += source.slice(cursor);
  // Unknown inline code keeps its syntax, without dumping literal bodies.
  if (opaque) result = result.replace(/'[^'\n]*'|"[^"\n]*"/g, "…");
  return clean(result);
}

function knownProgram(title: string, source: string): Summary | undefined {
  const words = literalTokens(source);
  if (!words?.length) return;
  const program = programName(words[0]).toLowerCase();
  if (program === "git") {
    let offset = 1, repo = "";
    while (["-C", "-c", "--git-dir", "--work-tree"].includes(words[offset])) {
      if (!words[offset + 1]) return;
      if (words[offset] === "-C") repo = words[offset + 1];
      offset += 2;
    }
    const action = words[offset];
    if (!action || action.startsWith("-")) return primarySummary(title, clean(source));
    const args = words.slice(offset + 1);
    const dash = args.indexOf("--");
    const object = dash >= 0 ? args.slice(dash + 1) : [];
    if (repo || object.length) return { title, detail: "", path: false,
      segments: repo && object.length ? [...pathSegments([repo], false), { text: " :: " }, ...pathSegments(object, false)] : pathSegments(object.length ? object : [repo], false),
      preview: [{ text: `git ${action}`, priority: 100 }, ...optionParts(args).map(part => ({ ...part, priority: /^--(?:hard|force|delete)$|^-D$/.test(part.text) ? 95 : 60 }))] };
    const useful = args.filter((arg, index) => !["-m", "--message"].includes(arg) && !["-m", "--message"].includes(args[index - 1]));
    const detail = ["git", action, ...useful].join(" ");
    return visibleWidth(detail) <= 40 && useful.length <= 3 ? primarySummary(title, detail)
      : primarySummary(title, `git ${action}`, optionParts([`git ${action}`, ...useful]));
  }
  if (["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "dotnet", "cargo", "go", "pytest", "make", "cmake"].includes(program)) {
    const meaningful = words.slice(1).filter((word, i) => !["--prefix", "--cwd", "-C"].includes(word) && !["--prefix", "--cwd", "-C"].includes(words[i]));
    const location = words.findIndex(word => ["--prefix", "--cwd", "-C"].includes(word));
    if (location >= 0 && words[location + 1]) return { title, detail: "", path: false, segments: pathSegments([words[location + 1]], false), preview: [{ text: program, priority: 100 }, ...optionParts(meaningful).map(part => ({ ...part, priority: 70 }))] };
    const detail = [program, ...meaningful].join(" ");
    return visibleWidth(detail) <= 40 && meaningful.length <= 3 ? primarySummary(title, detail)
      : primarySummary(title, [program, meaningful[0]].filter(Boolean).join(" "), optionParts([program, ...meaningful]));
  }
  if (["curl", "wget"].includes(program)) {
    const url = words.find(word => /^['"]?https?:\/\//i.test(word));
    if (!url) return;
    const parts: PreviewPart[] = [{ text: program, priority: 100 }];
    for (let i = 1; i < words.length; i++) {
      if (/^--(?:data(?:-raw|-binary)?|form)=/.test(words[i])) { parts.push({ text: `${words[i].split("=")[0]} …`, priority: 85 }); continue; }
      if (/^(?:--(?:request|output|method)=|-(?:X|o).+)/.test(words[i])) { parts.push({ text: clean(words[i]), priority: 85 }); continue; }
      if (/^(?:-d|--data(?:-raw|-binary)?|-F|--form)$/.test(words[i])) { parts.push({ text: `${words[i]} …`, priority: 85 }); i++; continue; }
      if (/^(?:-H|--header|--user|-u)$/.test(words[i])) { i++; continue; }
      if (["-X", "--request", "-o", "--output", "-O", "-L", "--location", "--method", "-I", "--head", "-G", "--get"].includes(words[i])) {
        const flag = words[i], takesValue = ["-X", "--request", "-o", "--output", "--method"].includes(flag);
        parts.push({ text: takesValue && words[i + 1] ? `${flag} ${words[++i]}` : flag, priority: 85 });
      }
    }
    return { title, detail: "", path: false, segments: pathSegments([unquoteWord(url)], false), preview: parts };
  }
}
function stripEnvPrefix(source: string): string {
  const words = commandWords(source);
  let index = 0;
  while (index < words.length - 1 && /^[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|[^\s;|&#()]+)$/.test(words[index])) index++;
  if (!index) return source;
  let cursor = 0;
  for (let i = 0; i < index; i++) cursor = source.indexOf(words[i], cursor) + words[i].length;
  return source.slice(cursor).trim();
}
function stripScriptComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && quote) { i++; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}
function splitScriptStatements(source: string): string[] {
  const result: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripScriptComment(rawLine).trim();
    if (!line) continue;
    let start = 0, quote = "", depth = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && quote) { i++; continue; }
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
      else if (!depth && ch === ";") {
        const part = line.slice(start, i).trim();
        if (part) result.push(part);
        start = i + 1;
      }
    }
    const tail = line.slice(start).trim();
    if (tail) result.push(tail);
  }
  return result;
}
function classifyScriptLiteral(raw: string, inPathContext = false): { text: string; file: boolean; path: boolean } | undefined {
  const value = raw.trim().replace(/\\\\/g, "\\");
  if (!value || /[\x00-\x1f<>|{}]/.test(value) || /(?:---|===)/.test(value)) return;
  if (/^https?:\/\/[^\s'"<>|{}]+$/i.test(value)) return { text: value, file: false, path: true };
  if (/[*?]/.test(value)) return;
  if (/^(?:[A-Za-z]:[\\/]|\\\\[A-Za-z0-9_.-]+[\\/])[^\x00-\x1f"*?<>|{}]+$/.test(value)) return { text: value, file: true, path: true };
  if (/^~[\\/][^\x00-\x1f"*?<>|{}\s]+$/.test(value)) return { text: value, file: true, path: true };
  if (/^(?:\.\.?[\\/]|[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)$/.test(value)
    && !/^(?:Mozilla|application|text|image|audio|video|multipart)\//i.test(value)
    && (inPathContext || /\.(?:md|json|jsonl|js|mjs|cjs|ts|tsx|py|yaml|yml|toml|txt|html|css|sh|ps1|cmd|bat)$/i.test(value))) {
    return { text: value, file: true, path: true };
  }
}
/** Extract concrete file/directory/URL targets from inline scripts without executing code. */
function extractScriptTargets(body: string): SummarySegment[] {
  const cleanLines = body.split(/\r?\n/).map(stripScriptComment);
  const cleanBody = cleanLines.join("\n");
  const statements = splitScriptStatements(body);
  const pathVars = new Map<string, string>();
  const listVars = new Map<string, string[]>();
  for (const match of cleanBody.matchAll(/\b(?:for\s+([A-Za-z_]\w*)\s+in\s+|([A-Za-z_]\w*)\s*=\s*)\[([^\]]+)\]/g)) {
    const name = match[1] ?? match[2];
    const items = [...match[3].matchAll(/[rR]?(['"])([^'"\r\n]+)\1/g)].map(m => m[2].trim()).filter(Boolean);
    if (name && items.length) listVars.set(name, items);
  }
  for (const stmt of statements) {
    const assign = stmt.match(/^(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?[rR]?(['"])([^'"\r\n]+)\2\s*\)?$/);
    if (assign) {
      const classified = classifyScriptLiteral(assign[3], true);
      if (classified?.file) pathVars.set(assign[1], classified.text.replace(/[\\/]+$/, ""));
    }
  }
  const directVars = new Set<string>();
  for (const match of cleanBody.matchAll(/\b(?:listdir|walk|scandir|open|exists|isdir|isfile|read_text|write_text|glob|rglob)\s*\(\s*([A-Za-z_]\w*)\s*[,)]/g)) {
    if (pathVars.has(match[1])) directVars.add(match[1]);
  }
  const concreteJoinedVars = new Set<string>();
  for (const match of cleanBody.matchAll(/\b(?:os\.path\.join|posix\.join|win32\.join|path\.join|join)\s*\(\s*([A-Za-z_]\w*)\s*,\s*(?:[rR]?(['"])([^'"\r\n]+)\2|([A-Za-z_]\w*))\s*\)/g)) {
    if (pathVars.has(match[1]) && (match[3] || (match[4] && listVars.has(match[4])))) concreteJoinedVars.add(match[1]);
  }
  for (const match of cleanBody.matchAll(/\b([A-Za-z_]\w*)\s*\/\s*[rR]?(['"])([^'"\r\n]+)\2/g)) {
    if (pathVars.has(match[1])) concreteJoinedVars.add(match[1]);
  }
  const seen = new Set<string>();
  const collected: { text: string; file: boolean; path: boolean }[] = [];
  const push = (item?: { text: string; file: boolean; path: boolean }) => {
    if (!item) return;
    const key = item.text.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    collected.push(item);
  };
  const consumedLists = new Set<string>();
  for (const stmt of statements) {
    if (/^(?:import\s|from\s+\S+\s+import\b|sys\.std(?:out|err)\.reconfigure\s*\()/i.test(stmt)) continue;
    const assign = stmt.match(/^(?:(?:const|let|var)\s+)?([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?[rR]?(['"])([^'"\r\n]+)\2\s*\)?$/);
    if (assign && pathVars.has(assign[1])) {
      if (directVars.has(assign[1]) || !concreteJoinedVars.has(assign[1])) push({ text: pathVars.get(assign[1])!, file: true, path: true });
      continue;
    }
    const isPrint = /^(?:print|console\.(?:log|info|warn|error))\s*\(/.test(stmt);
    const scopes = isPrint
      ? [...stmt.matchAll(/\b(?:open|listdir|walk|scandir|Path|join|copy\w*|rmtree|get_\w+|urlopen|Request)\s*\(([^)]*)\)/g)].map(m => m[0])
      : [stmt];
    for (let scope of scopes) {
      scope = scope.replace(/\b(?:os\.path\.join|posix\.join|win32\.join|path\.join|join)\s*\(\s*([^,()]+?)\s*,\s*([^,()]+?)\s*\)/g, (full, rawBase, rawChild) => {
        const baseVar = rawBase.trim();
        const baseLit = rawBase.trim().match(/^[rR]?(['"])([^'"\r\n]+)\1$/)?.[2];
        const baseClassified = baseLit ? classifyScriptLiteral(baseLit, true) : undefined;
        const basePath = pathVars.get(baseVar) ?? (baseClassified?.file ? baseClassified.text.replace(/[\\/]+$/, "") : undefined);
        if (!basePath) return full;
        const childLit = rawChild.trim().match(/^[rR]?(['"])([^'"\r\n]+)\1$/)?.[2];
        const childVar = rawChild.trim();
        if (childLit) { push({ text: `${basePath}/${childLit.replace(/^[\\/]+/, "")}`, file: true, path: true }); return ""; }
        if (listVars.has(childVar)) {
          consumedLists.add(childVar);
          for (const item of listVars.get(childVar)!) push({ text: `${basePath}/${item.replace(/^[\\/]+/, "")}`, file: true, path: true });
          return "";
        }
        return full;
      });
      scope = scope.replace(/\b([A-Za-z_]\w*)\s*\/\s*[rR]?(['"])([^'"\r\n]+)\2/g, (full, baseVar, _q, childLit) => {
        const basePath = pathVars.get(baseVar);
        if (!basePath) return full;
        push({ text: `${basePath}/${childLit.replace(/^[\\/]+/, "")}`, file: true, path: true });
        return "";
      });
      const inPathCall = /\b(?:Path|open|listdir|walk|scandir|exists|isdir|isfile|copy\w*|rmtree|read_text|write_text|glob|rglob)\s*\(/.test(scope);
      for (const lit of scope.matchAll(/([fFrR]{0,2})(['"])([^'"\r\n]+)\2/g)) {
        const prefix = lit[1].toLowerCase(), rawVal = lit[3];
        if (prefix.includes("f") && /^https?:\/\/[^\s'"<>]+\{[A-Za-z_]\w*\}/i.test(rawVal)) {
          for (const [, items] of listVars) if (items.every(item => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item))) {
            for (const item of items) push({ text: item, file: false, path: false });
          }
          for (const call of cleanBody.matchAll(/\bget_[A-Za-z_]\w*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) {
            push({ text: rawVal.replace(/\{[A-Za-z_]\w*\}/, call[2]), file: false, path: true });
          }
          continue;
        }
        push(classifyScriptLiteral(rawVal, inPathCall));
      }
    }
  }
  for (const [name, items] of listVars) {
    if (consumedLists.has(name)) continue;
    for (const item of items) push(classifyScriptLiteral(item, true));
  }
  return collected.flatMap((item, index) => [...(index ? [{ text: ", " }] : []), { text: clean(item.text), file: item.file, path: item.path }]);
}
function scriptSummary(title: string, program: string, flag: string, body: string): Summary {
  const globs = [...body.matchAll(/^[ \t]*(?:for\s+[A-Za-z_]\w*\s+in\s+|[A-Za-z_]\w*\s*=\s*)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.glob\(\s*(['"])([^'"\n]+)\3\s*\)/gm)];
  if (globs.length === 1) {
    const glob = globs[0];
    const line = body.slice(glob.index!).split(/\r?\n/)[0];
    return { title, detail: "", path: false, segments: pathSegments([`${glob[2].replace(/[\\/]$/, "")}/${glob[4]}`], false), subline: `${program} ${flag} '… ${clean(line)} …'` };
  }
  const targets = extractScriptTargets(body);
  if (targets.length) {
    return { title, detail: "", path: false, fileTitle: targets.some(segment => segment.file), segments: targets };
  }
  return codeFallback(title, body, true);
}
function commandSummary(title: string, value: unknown, depth = 0): Summary {
  const rawSource = typeof value === "string" ? stripTerminalSequences(value).trim() : "";
  if (!rawSource) return primarySummary(title, "…");
  const source = stripEnvPrefix(rawSource);
  const heredoc = source.match(/^(python(?:3(?:\.\d+)?)?|py|node|nodejs|bash|sh|pwsh|powershell)\b[^\n]*<<-?\s*(['"]?)([A-Za-z_]\w*)\2[ \t]*\r?\n([\s\S]*?)(?:\r?\n\3[ \t]*$|$)/i);
  if (heredoc && depth < 3) {
    const [, runner, , , body] = heredoc;
    if (/^(?:bash|sh|pwsh|powershell)$/i.test(runner)) return commandSummary(title, body, depth + 1);
    return scriptSummary(title, programName(runner), "-c", body);
  }
  const words = commandWords(source);
  const program = programName(words[0] ?? "");
  const ps = parsedPowerShell(title, source);
  if (ps) return ps;
  const scan = scanCommand(source);
  if (scan.steps.length > 1) {
    const first = commandSummary(title, scan.steps[0], depth + 1);
    const separator = scan.operators[0] === "\n" ? "…" : `${scan.operators[0]} …`;
    const targets = scan.steps.map(step => commandSummary(title, step, depth + 1)).flatMap(summary => summary.segments ?? []).filter(segment => segment.text !== ", ");
    return { ...first, segments: targets.length ? targets.flatMap((segment, index) => [...(index ? [{ text: ", " }] : []), segment]) : first.segments,
      subline: first.subline ?? excerptPayload(scan.steps[0]), continuation: separator };
  }
  const encoded = /^(?:powershell|pwsh)$/i.test(program) && words.find(word => /^-(?:EncodedCommand|enc)$/i.test(word));
  if (encoded) return primarySummary(title, `${encoded} …`);
  const shell = /^(?:powershell|pwsh|cmd|bash|sh)$/i.test(program);
  const script = /^(?:python(?:3(?:\.\d+)?)?|py|node|nodejs)$/i.test(program);
  const flag = words.findIndex((word, index) => index > 0 && (shell ? /^(?:-Command|-c|-lc|\/c)$/i.test(word) : script && /^(?:-c|-e|--eval)$/.test(word)));
  if (flag > 0 && depth < 3) {
    let cursor = 0;
    for (let i = 0; i <= flag; i++) cursor = source.indexOf(words[i], cursor) + words[i].length;
    let body = source.slice(cursor).trim();
    if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) body = body.slice(1, -1);
    if (shell) return commandSummary(title, body, depth + 1);
    return scriptSummary(title, program, words[flag], body);
  }
  const known = knownProgram(title, source);
  if (known) return { ...known, preview: undefined, subline: known.preview ? excerptPayload(source) : undefined };
  const literal = literalCommandTarget(source);
  if (literal) {
    const simple = /^(?:cat|ls|type)$/i.test(program) && words.length === 2;
    const simpleScript = script && words.length === 2 && !words.includes("--test");
    return { title: simple ? `${program}  ${title}` : title, detail: "", path: false, segments: literal.segments,
      subline: simple || simpleScript ? undefined : excerptPayload(source) };
  }
  return codeFallback(title, source);
}

function codeFallback(title: string, source: string, opaque = false): Summary {
  const rawLines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const lines = opaque && rawLines.length === 1 && rawLines[0].includes(";") ? splitScriptStatements(source) : rawLines;
  const substantive = lines.filter(line => !/^(?:#|import\s|from\s|\$ErrorActionPreference\s*=|sys\.std(?:out|err)\.reconfigure\s*\(|os\.environ(?:\[|\.get\b).*=\s*)/i.test(line)
    && !/^print\s*\(\s*[rR]?(['"])[-=_*\s]{3,}.*\1\s*\)$/i.test(line)
    && !(opaque && lines.length > 1 && /^[A-Za-z_]\w*$/.test(line)));
  let first = substantive[0] ?? lines[0] ?? "…";
  if (opaque && substantive.length > 1 && /[[({:]$/.test(first)) {
    first = `${first} ${substantive[1]}`;
  }
  let cleanFirst = excerptPayload(first, opaque);
  if (opaque && substantive.length > 1 && visibleWidth(cleanFirst) < 24 && !/(\[[A-Za-z_.]+\]::[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?=\s*\())/.test(first)) {
    cleanFirst = `${cleanFirst}; ${excerptPayload(substantive[1], opaque)}`;
  }
  if (!substantive.length) return primarySummary(title, cleanFirst);
  const api = first.match(/(\[[A-Za-z_.]+\]::[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?=\s*\())/)?.[1];
  if (api) return { title, detail: api, path: false, subline: cleanFirst };
  // A literal loop header and its body are two excerpts of one call, not new calls.
  const loop = source.match(/^\s*((?:for|foreach|while)\s*\([^{}]*\)\s*\{)([\s\S]*)\}\s*$/i);
  if (loop) return { title, detail: `${clean(loop[1])} … }`, path: false, subline: excerptPayload(loop[2], opaque) };
  return primarySummary(title, cleanFirst);
}

function neutral(theme: Theme, text: string, bold = false): string {
  return theme.style(text, { fg: theme.appearance === "light" ? NEUTRAL_LIGHT : NEUTRAL_DARK, bold });
}
/** True only when the second line repeats the target or adds no new text. */
function excerptIsRedundant(targetText: string, excerptText: string, continuation = ""): boolean {
  const normalize = (value: string) => clean(value).replace(/["']/g, "").replace(/\s+/g, " ").trim();
  const target = normalize(targetText);
  const excerpt = normalize(`${excerptText}${continuation ? ` ${continuation}` : ""}`);
  if (!target || !excerpt) return false;
  if (excerpt === target) return true;
  if (!excerpt.startsWith(target)) return false;
  const rest = excerpt.slice(target.length).trim();
  // A pipe or meaningful arguments stay; only continuation markers are dropped.
  return rest === "" || /^(?:&&|;|…|\.{3})[\s…;|&.]*$/.test(rest);
}
/** C/H collapse trailing continuation ellipses; no source text changes. */
function tidyExcerpt(text: string): string {
  return text
    .replace(/\s*;\s*…\s*$/, " …")
    .replace(/(?:(?:\.{3}|…)\s*){2,}$/, "…");
}
/** Width is resolved during render, rather than limiting JavaScript character counts. */
class SummaryLine implements Component {
  private segments: (Omit<SummarySegment, "text"> & { text: () => string })[];
  constructor(private summary: Summary, private status: string, private theme: Theme, cwd = "", paths?: PathLabels,
    private sameTool: () => boolean = () => false, private diffCounts: () => DiffCounts | undefined = () => this.summary.diff) {
    this.segments = (summary.segments ?? [{ text: summary.detail, path: summary.path }]).map(segment => {
      const text = cleanDisplayToken(segment.text);
      const label = segment.path && paths ? paths.label(text, cwd) : () => text;
      return { ...segment, text: () => label() + (segment.suffix ?? "") };
    });
  }
  invalidate() {}
  render(width: number): string[] {
    // Box has already removed symmetric padding. Its left edge plus this limit
    // stays at or before the viewport midpoint, including labels and states.
    width = Math.max(0, Math.floor(width / 2));
    if (!width) return [];
    const { title, subline, preview, continuation = "" } = this.summary;
    const segments = this.segments.map(segment => ({ ...segment, text: segment.text() }));
    const suffix = this.status === "done" ? "" : truncateToWidth(` [${this.status}]`, width, "…");
    const errorState = ["error", "failed", "cancelled"].includes(this.status);
    const suffixStyled = !suffix ? "" : errorState
      ? this.theme.style(suffix, { fg: this.theme.appearance === "light" ? SOFT_ERROR_LIGHT : SOFT_ERROR_DARK })
      : this.theme.fg(this.status === "running" ? "warning" : "dim", suffix);
    const ditto = this.status === "done" && this.sameTool();
    const displayTitle = ditto ? "·" : title;
    const typeWidth = visibleWidth(displayTitle) + 2;
    // In narrow windows, give the target and explicit state priority over the type label.
    const targetFloor = Math.min(24, Math.max(8, ...segments.filter(segment => segment.path || segment.reference).map(segment => visibleWidth(segment.text.split(/[\\/]/).pop() ?? ""))));
    const showType = width - typeWidth - visibleWidth(suffix) >= targetFloor;
    const light = this.theme.appearance === "light";
    const sepColor = light ? SEP_LIGHT : SEP_DARK;
    const typeColor = ditto ? light ? RAIL_LIGHT : parseColor("#4C524D") : parseColor(light ? "#667377" : "#687478");
    const type = showType ? this.theme.style(`  ${displayTitle}`, { fg: typeColor }) : "";
    const meta = `${type}${suffixStyled}`;
    const metaWidth = visibleWidth(meta);
    const targetText = segments.map(segment => segment.text).join("");
    const rawAvailable = Math.max(0, width - metaWidth);
    const diff = this.diffCounts();
    const diffPlainParts: string[] = [];
    const diffStyledParts: string[] = [];
    if (diff) {
      if (diff.added > 0) {
        diffPlainParts.push(`+${diff.added}`);
        diffStyledParts.push(this.theme.style(`+${diff.added}`, { fg: light ? ADDED_LIGHT : ADDED_DARK, bold: false }));
      }
      if (diff.removed > 0) {
        diffPlainParts.push(`-${diff.removed}`);
        diffStyledParts.push(this.theme.style(`-${diff.removed}`, { fg: light ? SOFT_ERROR_LIGHT : SOFT_ERROR_DARK, bold: false }));
      }
    }
    const diffPlain = diffPlainParts.length ? `  ${diffPlainParts.join(" ")}` : "";
    const showDiff = Boolean(diffPlain) && rawAvailable >= targetFloor + visibleWidth(diffPlain);
    const diffStyled = showDiff ? `  ${diffStyledParts.join(" ")}` : "";
    const available = Math.max(0, rawAvailable - (showDiff ? visibleWidth(diffPlain) : 0));
    // H lays out complete logical items in plain text before G applies ANSI colors.
    const items: SummarySegment[][] = [[]];
    for (const segment of segments) {
      if (segment.text === ", ") items.push([]);
      else items[items.length - 1].push(segment);
    }
    const fitItem = (item: SummarySegment[], budget: number, multi: boolean): SummarySegment[] => {
      let remaining = budget;
      return item.map(segment => {
        const path = /[\\/]/.test(segment.text);
        const limit = Math.max(0, multi && path ? Math.min(46, remaining) : remaining);
        const text = path || segment.path || segment.reference ? middlePath(segment.text, limit) : truncateToWidth(segment.text, limit, "…");
        remaining = Math.max(0, remaining - visibleWidth(text));
        return { ...segment, text };
      });
    };
    const chosen: SummarySegment[][] = [];
    let usedWidth = 0;
    for (let index = 0; index < items.length; index++) {
      const reserve = index < items.length - 1 ? visibleWidth(`  +${items.length - index}`) : 0;
      const item = items.length === 1 ? fitItem(items[index], available, false)
        : items[index].map(segment => /[\\/]/.test(segment.text)
          ? { ...segment, text: middlePath(segment.text, Math.min(46, available)) } : segment);
      const itemWidth = item.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
      if (usedWidth + (chosen.length ? 2 : 0) + itemWidth + reserve > available) {
        if (!chosen.length) chosen.push(fitItem(items[0], Math.max(1, available - reserve), items.length > 1));
        break;
      }
      usedWidth += (chosen.length ? 2 : 0) + itemWidth;
      chosen.push(item);
    }
    const styleSegment = (segment: SummarySegment): string => {
      const file = segment.file || this.summary.fileTitle;
      const baseColor = file ? light ? parseColor("#756344") : FILE_COLOR : light ? NEUTRAL_LIGHT : NEUTRAL_DARK;
      const style = (text: string, fg: ReturnType<typeof parseColor>) => this.theme.style(text, { fg, bold: false });
      if (!(segment.path || segment.reference || /[\\/]/.test(segment.text))) return style(segment.text, baseColor);
      const range = segment.text.match(/:\d+(?:-\d+)?$/)?.[0] ?? "";
      const body = range ? segment.text.slice(0, -range.length) : segment.text;
      const index = Math.max(body.lastIndexOf("/"), body.lastIndexOf("\\"));
      const split = index >= 0 && index < body.length - 1 ? index + 1 : 0;
      return style(body.slice(0, split), file ? light ? DIR_FILE_LIGHT : DIR_FILE_DARK : light ? DIR_LIGHT : DIR_DARK)
        + style(body.slice(split), baseColor) + style(range, light ? RANGE_LIGHT : RANGE_DARK);
    };
    const target = chosen.map(item => item.map(styleSegment).join("")).join(this.theme.style(", ", { fg: sepColor }))
      + (chosen.length < items.length ? this.theme.style(`  +${items.length - chosen.length}`, { fg: sepColor }) : "")
      + diffStyled;
    // A puts the type and state on one right edge while short targets keep a gap.
    const align = visibleWidth(target) > 0 && metaWidth > 0;
    const padding = align ? " ".repeat(Math.max(0, width - metaWidth - visibleWidth(target))) : "";
    const row = truncateToWidth(`${target}${padding}${meta}`, width, "…");
    const lines = [row];
    const excerptSource = cleanDisplayToken(preview?.length ? previewText(preview, 10000) : subline ?? "");
    // F omits a second line that only repeats the target or its continuation.
    if (!excerptIsRedundant(targetText, excerptSource, continuation) && (subline || preview?.length) && width > 2) {
      const tail = truncateToWidth(continuation, width - 2, "…");
      const budget = Math.max(0, width - 2 - (tail ? visibleWidth(tail) + 1 : 0));
      const excerpt = preview?.length ? cleanDisplayToken(previewText(preview, budget)) : truncateToWidth(excerptSource, budget, "…");
      const text = tidyExcerpt(`${cleanDisplayToken(excerpt)}${tail ? ` ${tail}` : ""}`);
      const connector = this.theme.style("└ ", { fg: this.theme.appearance === "light" ? RAIL_LIGHT : RAIL_DARK });
      lines.push(connector + this.theme.style(text, { fg: parseColor(light ? "#5E6B6F" : "#7B878A") }));
    }
    return lines;
  }
}
function framed(component: Component, theme: Theme, context: ToolRenderContext, collapsed = false): Component {
  const box = new Box(context.outputPad, 0, collapsed ? undefined : text => theme.bg(background(context), text));
  box.addChild(component);
  return box;
}
class SafeNative implements Component {
  constructor(private native: Component, private fallback: Component) {}
  invalidate() { try { this.native.invalidate?.(); } catch { /* The fallback remains usable. */ } }
  render(width: number) { try { return this.native.render(width); } catch { return this.fallback.render(width); } }
  handleMouse(event: any) { try { return (this.native as any).handleMouse?.(event); } catch { return undefined; } }
}
function nativeContext(context: ToolRenderContext, slot: "call" | "result") {
  const cache = context.state[nativeSlot] ??= { state: {}, call: undefined, result: undefined };
  return { cache, context: { ...context, state: cache.state, lastComponent: cache[slot] } };
}
function originalComponent(original: ToolRenderers | undefined, slot: "call" | "result", args: any, result: any, options: any, theme: Theme, context: ToolRenderContext): Component | undefined {
  const { cache, context: forwarded } = nativeContext(context, slot);
  try {
    const component = slot === "call" ? original?.renderCall?.(args, theme, forwarded)
      : original?.renderResult?.(result, options, theme, forwarded);
    cache[slot] = component;
    return component;
  } catch { cache[slot] = undefined; return undefined; }
}
function summarize(toolName: string, args: any, original: Component | undefined, cwd: string, storedDiff?: DiffCounts): Summary {
  let nativeTitle = "";
  // Use only its first heading; no native result/body enters the collapsed row.
  try { nativeTitle = clean(original?.render(256).find(line => clean(line)) ?? ""); } catch { /* Generic heading below. */ }
  const rawPath = clean(args?.file_path ?? args?.path);
  if (["read", "edit", "write"].includes(toolName)) {
    const title = toolName === "read" ? nativeTitle.match(/^read(?:\s+(?:resource|skill|docs))?\b/)?.[0] ?? toolName : toolName;
    const start = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 1;
    const range = toolName === "read" && (args?.offset != null || args?.limit != null)
      ? `:${start}${Number.isInteger(args.limit) && args.limit > 0 ? `-${start + args.limit - 1}` : ""}` : "";
    const diff = (toolName === "edit" || toolName === "write") ? extractDiffCounts(toolName, args, storedDiff) : undefined;
    return fileSummary(title, rawPath || "…", "", range, diff);
  }
  if (["bash", "powershell"].includes(toolName)) {
    return commandSummary(toolName, args?.command);
  }
  if (["grep", "find"].includes(toolName)) return fileSummary(toolName, rawPath || clean(cwd), `${clean(args?.pattern) || "…"} `);
  if (toolName === "ls") return fileSummary(toolName, rawPath || clean(cwd));
  if (toolName === "codemode") return { title: toolName, detail: firstLine(args?.code) || "…", path: false };
  const found = target(args);
  const context = args && typeof args === "object" && (found.path || args.url || args.uri || args.resource_uri)
    ? ["method", "action", "operation", "query", "pattern", "recursive", "limit"].flatMap(key => {
      const value = args[key];
      return ["string", "number", "boolean"].includes(typeof value) ? [{ text: `${key}=${clean(String(value))}`, priority: 80 }] : [];
    }) : undefined;
  if (found.path && Array.isArray(args?.paths) && !args?.file_path && !args?.path) {
    const paths = args.paths.filter((value: unknown) => typeof value === "string");
    return { title: toolName, ...found, fileTitle: true, preview: context, segments: paths.flatMap((value: string, index: number) => [
      ...(index ? [{ text: ", " }] : []), { text: clean(value), file: true, path: true },
    ]) };
  }
  return found.path ? { ...fileSummary(toolName, found.detail), preview: context } : { title: toolName, ...found, preview: context };
}

interface GroupRow {
  id: string;
  call: Component;
  result: Component;
  context: ToolRenderContext;
  title?: string;
  status?: string;
}
interface SpacingMessage { message: any; }
interface ToolGroup { ids: string[]; rows: Map<string, GroupRow>; invalidating: boolean; before: SpacingMessage[]; following: SpacingMessage[]; }
/** Pi 1.3.0/1.4.0's ordinary assistant prefix, before its first visible text/tool.
 * Only add missing rows. Never erase native spacing or touch stored messages.
 * Unknown/interleaved/error layouts retain the native spacing instead of guessing.
 */
function missingStageRows(following: readonly SpacingMessage[], hiddenThinking: boolean, afterText = false): number {
  const targetGap = afterText ? INTRA_GAP : STAGE_GAP;
  let blanks = 0;
  let sawText = !afterText;
  const visible = (part: any) => (part.type === "text" && part.text?.trim()) || (part.type === "thinking" && part.thinking?.trim());
  for (const { message } of following) {
    if (!Array.isArray(message?.content) || ["error", "aborted", "length"].includes(message.stopReason)) return 0;
    const parts = message.content;
    const firstTool = parts.findIndex((part: any) => part.type === "toolCall");
    if (firstTool >= 0 && parts.slice(firstTool + 1).some(visible)) return 0;
    if (parts.some(visible)) blanks++; // Native assistant leading Spacer(1).
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      if (part.type === "text" && part.text?.trim()) {
        if (!afterText) return Math.max(0, targetGap - blanks);
        sawText = true;
        blanks = 0; // Measure only the gap after the latest visible explanation.
      }
      if (part.type === "toolCall") return sawText ? Math.max(0, targetGap - blanks - 1) : 0; // Native tool spacer.
      if (part.type !== "thinking") continue;
      let nonempty = false;
      for (; index < parts.length && parts[index].type === "thinking"; index++) nonempty ||= Boolean(parts[index].thinking?.trim());
      index--;
      if (!nonempty) continue;
      // An empty hidden label still has ANSI styling and renders one blank Text row.
      // With thinking expanded, our Markdown transformer returns zero rows instead.
      if (hiddenThinking) blanks++;
      if (parts.slice(index + 1).some(visible)) blanks++;
    }
  }
  return 0; // No visible successor yet: do not reserve a trailing blank area.
}
/** Collects tool calls only across responses whose original assistant slot has no visible-space content. */
class ToolGroups {
  private groups = new Map<string, ToolGroup>();
  private active?: ToolGroup;
  private spacingTail?: ToolGroup;
  private spacingMessage?: SpacingMessage;
  private spacingOwner?: ToolGroup;
  private beforeTool: SpacingMessage[] = [];
  private disposed = false;
  constructor(private hiddenThinking: () => boolean) {}
  clear() {
    this.disposed = true;
    for (const group of this.groups.values()) {
      group.before = [];
      group.following = [];
    }
    this.groups.clear(); this.active = undefined;
    this.spacingTail = undefined; this.spacingMessage = undefined; this.spacingOwner = undefined;
    this.beforeTool = [];
  }
  begin(message: any) {
    this.disposed = false;
    // Tool results sit between assistant responses and do not start a new stage.
    if (message?.role === "toolResult") return;
    this.spacingMessage = undefined;
    this.spacingOwner = undefined;
    if (message?.role !== "assistant") { this.active = undefined; this.spacingTail = undefined; this.beforeTool = []; return; }
    this.spacingMessage = { message };
    this.beforeTool.push(this.spacingMessage);
    this.spacingOwner = this.spacingTail;
    this.spacingOwner?.following.push(this.spacingMessage);
  }
  restore(entries: readonly any[]) {
    this.clear();
    this.disposed = false;
    for (const entry of entries) {
      if (entry.type !== "message") { this.begin(undefined); continue; }
      this.begin(entry.message);
      this.observe(entry.message, true);
    }
  }
  observe(message: any, complete = false) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
    let hasSpaceBeforeTool = false;
    let lastGroup: ToolGroup | undefined;
    for (const part of message.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) hasSpaceBeforeTool = true;
      if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) hasSpaceBeforeTool = true;
      if (part.type !== "toolCall" || typeof part.id !== "string") continue;
      if (!this.groups.has(part.id)) {
        if (hasSpaceBeforeTool || !this.active) this.active = { ids: [], rows: new Map(), invalidating: false, before: this.beforeTool.slice(), following: [] };
        this.active.ids.push(part.id);
        this.groups.set(part.id, this.active);
        this.refresh(this.active);
      }
      lastGroup = this.groups.get(part.id);
      hasSpaceBeforeTool = false;
    }
    if (hasSpaceBeforeTool || (complete && message.stopReason && message.stopReason !== "toolUse")) this.active = undefined;
    if (this.spacingMessage) {
      this.spacingMessage.message = message; // Replace snapshots; never append them as new responses.
      if (lastGroup === this.spacingOwner && lastGroup) lastGroup.following = []; // Pure-tool merge stays compact.
      if (this.spacingOwner) this.refresh(this.spacingOwner);
      if (lastGroup) { this.spacingTail = lastGroup; this.beforeTool = []; }
      else if (message.content.some((part: any) => part.type === "text" && part.text?.trim())
        || (complete && message.stopReason && message.stopReason !== "toolUse")) this.spacingTail = undefined;
    }
  }
  private refresh(group: ToolGroup, sender?: string) {
    if (group.invalidating) return;
    group.invalidating = true;
    try {
      for (const id of ENABLE_DITTO ? group.ids : new Set([group.ids[0], group.ids[group.ids.length - 1]])) {
        const row = group.rows.get(id);
        if (row && id !== sender) {
          try { row.context.invalidate(); } catch { /* A detached view needs no repaint. */ }
        }
      }
    } finally { group.invalidating = false; }
  }
  private spacingEnabled(group: ToolGroup): boolean {
    // This compensates a known host layout, not a public universal spacing contract.
    return SPACING_SUPPORTED && [...group.rows.values()].every(row => !row.context.expanded && !(row.context.showImages && row.context.state[imageSlot]));
  }
  private paddingAfter(group: ToolGroup): number {
    if (this.disposed || !this.spacingEnabled(group) || group.following.length === 0) return 0;
    return missingStageRows(group.following, this.hiddenThinking());
  }
  private paddingBefore(group: ToolGroup): number {
    if (this.disposed || !this.spacingEnabled(group) || group.before.length === 0) return 0;
    return missingStageRows(group.before, this.hiddenThinking(), true);
  }
  isSameToolAsPrevious(toolCallId: string, title: string, status: string): boolean {
    if (!ENABLE_DITTO || this.disposed || status !== "done") return false;
    const group = this.groups.get(toolCallId);
    const index = group?.ids.indexOf(toolCallId) ?? -1;
    if (!group || index <= 0) return false;
    const previous = group.rows.get(group.ids[index - 1]);
    return previous?.status === "done" && previous.title === title;
  }
  wrap(context: ToolRenderContext, slot: "call" | "result", component: Component, title?: string): Component {
    const group = this.groups.get(context.toolCallId);
    if (!group) return component;
    const row = group.rows.get(context.toolCallId) ?? { id: context.toolCallId, call: new Container(), result: new Container(), context };
    row.context = context;
    if (title !== undefined) row.title = title;
    row.status = stateOf(context);
    row[slot] = component;
    group.rows.set(row.id, row);
    this.refresh(group, row.id);
    return new GroupSlot(group, row, slot, () => this.paddingAfter(group),
      () => this.paddingBefore(group), () => this.spacingEnabled(group) ? INTRA_GAP : 0);
  }
}
/** Empty peer slots let Pi omit their shells; expansion keeps each native tool in place. */
class GroupSlot implements Component {
  constructor(private group: ToolGroup, private row: GroupRow, private slot: "call" | "result", private paddingAfter: () => number,
    private paddingBefore: () => number, private betweenRows: () => number) {}
  invalidate() { try { this.row[this.slot].invalidate?.(); } catch { /* Ignore detached view. */ } }
  render(width: number): string[] {
    try {
      const grouped = this.group.ids.length > 1 && this.group.ids.includes(this.row.id)
        && [...this.group.rows.values()].every(row => !row.context.expanded && !row.context.showImages);
      if (!grouped) {
        const lines = [...this.row[this.slot].render(width)];
        if (this.slot === "call" && lines.length) {
          const before = this.row.id === this.group.ids[0] ? this.paddingBefore() : Math.max(0, this.betweenRows() - 1);
          lines.unshift(...Array(before).fill("")); // Independent tool shells already provide one blank row.
        }
        return this.slot === "result" && this.row.id === this.group.ids[this.group.ids.length - 1]
          ? [...lines, ...Array(this.paddingAfter()).fill("")] : lines;
      }
      if (this.row.id !== this.group.ids[0] || this.slot !== "call") return [];
      const lines: string[] = [];
      for (const id of this.group.ids) {
        const row = this.group.rows.get(id);
        if (row) {
          const content = [...row.call.render(width), ...row.result.render(width)];
          if (content.length) {
            lines.push(...Array(lines.length ? this.betweenRows() : this.paddingBefore()).fill(""));
            lines.push(...content);
          }
        }
      }
      lines.push(...Array(this.paddingAfter()).fill(""));
      return lines;
    } catch {
      try { return [...this.row[this.slot].render(width)]; } catch { return []; }
    }
  }
  handleMouse(event: any) { return (this.row[this.slot] as any).handleMouse?.(event); }
}

/** Only rendering changes; execution, arguments and stored results stay with Pi. */
export function quietRenderers(toolName: string, original?: ToolRenderers, groups?: ToolGroups, paths = new PathLabels()): ToolRenderers {
  const wrap = (context: ToolRenderContext, slot: "call" | "result", component: Component, title?: string) => groups?.wrap(context, slot, component, title) ?? component;
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      // Avoid rendering large write bodies or scripts simply to find a title.
      const native = context.expanded || toolName === "read"
        ? originalComponent(original, "call", args, undefined, undefined, theme, context) : undefined;
      if (context.expanded) {
        const fallback = framed(new Text(`${theme.fg("toolTitle", toolName)}\n${formatArguments(args)}`, 0, 0), theme, context);
        if (!native) return wrap(context, "call", fallback);
        return wrap(context, "call", new SafeNative(original?.renderShell === "self" ? native : framed(native, theme, context), fallback));
      }
      const summary = summarize(toolName, args, native, context.cwd, context.state[diffSlot]);
      const status = stateOf(context);
      return wrap(context, "call", framed(new SummaryLine(summary, status, theme, context.cwd, paths,
        () => groups?.isSameToolAsPrevious(context.toolCallId, summary.title, status) ?? false,
        () => context.state[diffSlot] ?? summary.diff), theme, context, true), summary.title);
    },
    renderResult(result, options, theme, context) {
      context.state[imageSlot] = result.content.some(part => part.type === "image");
      if (toolName === "edit") {
        const counts = patchDiffCounts(result?.details);
        if (counts) context.state[diffSlot] = counts;
      }
      if (!options.expanded) {
        if (toolName !== "codemode" || !Array.isArray(result.details?.calls)) return wrap(context, "result", new Container());
        const rows = new Container();
        let prevTitle = "", prevStatus = "";
        for (const call of result.details.calls) {
          if (!call || typeof call.name !== "string") continue;
          const status = ({ running: "running", ok: "done", error: "failed", cancelled: "cancelled" } as Record<string, string>)[call.status] ?? "pending";
          const rowContext = { ...context, isPartial: call.status === "running", isError: call.status === "error" || call.status === "cancelled" };
          let args: any;
          try { args = typeof call.args === "string" ? JSON.parse(call.args) : call.args; } catch { /* Keep non-JSON native summaries below. */ }
          const summary = args && typeof args === "object" ? summarize(call.name, args, undefined, context.cwd, patchDiffCounts(call.details))
            : ["read", "edit", "write", "ls", "grep", "find"].includes(call.name) ? fileSummary(clean(call.name), clean(call.args))
            : { title: clean(call.name), detail: clean(call.args), path: false };
          const ditto = ENABLE_DITTO && status === "done" && prevStatus === "done" && summary.title === prevTitle;
          if (SPACING_SUPPORTED && !(context.showImages && context.state[imageSlot])) rows.addChild(new Spacer(INTRA_GAP));
          rows.addChild(framed(new SummaryLine(summary, status, theme, context.cwd, paths, () => ditto), theme, rowContext, true));
          prevTitle = summary.title; prevStatus = status;
        }
        return wrap(context, "result", rows);
      }
      const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const imageHint = result.content.some(part => part.type === "image") ? "图片显示由 Pi 原生设置控制，可在 /settings 中开启。" : "";
      const calls = toolName === "codemode" && result.details?.calls ? formatArguments(result.details.calls) : "";
      const fallback = framed(new Text([calls, text, imageHint].filter(Boolean).join("\n") || "没有文字输出。", 0, 0), theme, context);
      const native = originalComponent(original, "result", undefined, result, options, theme, context);
      if (!native) return wrap(context, "result", fallback);
      return wrap(context, "result", new SafeNative(original?.renderShell === "self" ? native : framed(native, theme, context), fallback));
    },
  };
}

function narrationParagraph(text: string, width: number, theme: Theme): string {
  const light = theme.appearance === "light";
  const leadColor = parseColor(light ? "#243135" : "#E8ECEA");
  const soloColor = parseColor(light ? "#344449" : "#D9DFDD");
  const restColor = parseColor(light ? "#5C696D" : "#8E999C");
  const idColor = parseColor(light ? "#756344" : "#D6CBB2");
  const markColor = parseColor(light ? "#766C55" : "#B3A785");
  const railColor = light ? RAIL_LIGHT : RAIL_DARK;
  const raw = stripTerminalSequences(text).replace(/`([^`]+)`/g, "$1");
  const hit = raw.search(/[，；]/), split = hit < 0 ? raw.length : hit + 1;
  const head = raw.slice(0, split), tail = raw.slice(split);
  const prefixWidth = width > 2 ? 2 : 0;
  const bodyWidth = Math.max(1, Math.min(68, width - prefixWidth));
  const style = (value: string, color: ReturnType<typeof parseColor>) => value.split(/([A-Za-z_][A-Za-z0-9_]*)/g)
    .map((part, index) => theme.style(part, { fg: index % 2 ? idColor : color, bold: false })).join("");
  const breakTail = head.endsWith("；") && visibleWidth(raw) > 56;
  const parts = breakTail ? [{ text: style(head, leadColor), indent: 0 }, { text: style(tail, restColor), indent: 2 }]
    : [{ text: style(head, hit < 0 ? soloColor : leadColor) + style(tail, restColor), indent: 0 }];
  const lines: string[] = [];
  for (const part of parts) {
    if (!stripTerminalSequences(part.text)) continue;
    const indent = Math.min(part.indent, bodyWidth - 1);
    for (const line of wrapTextWithAnsi(part.text, Math.max(1, bodyWidth - indent))) {
      const prefix = prefixWidth ? !lines.length ? theme.style("▎ ", { fg: markColor }) : theme.style("▎ ", { fg: railColor }) : "";
      // Escape Markdown punctuation after width-aware wrapping; source history is unchanged.
      lines.push(prefix + " ".repeat(indent) + line.replace(/([\\`*_])/g, "\\$1"));
    }
  }
  return lines.join("\n");
}

/** Recognize only standalone, single-line emphasis paragraphs, outside code blocks. */
export function styleNarration(markdown: string, context: MarkdownTransformContext, theme: Theme): string {
  // Display-only filtering; the original thinking remains in Pi's history and context.
  if (context.messageType === "assistant-thinking") return "";
  if (context.messageType !== "assistant") return markdown;
  const lines = markdown.split("\n");
  let fence: { char: string; length: number } | undefined;
  let htmlBlock = false;
  return lines.map((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      return line;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return line;
    if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) htmlBlock = true;
    if (htmlBlock) { if (line.includes("-->")) htmlBlock = false; return line; }
    const match = line.match(/^\*([^*\n]+)\*\s*$/);
    const before = index === 0 || lines[index - 1].trim() === "";
    const after = index === lines.length - 1 || lines[index + 1].trim() === "";
    if (!match || !before || !after || /[<>\[\]\\]/.test(match[1]) || !/^(?:[^`]|`[^`]+`)*$/.test(match[1])) return line;
    return narrationParagraph(match[1], Math.max(1, context.availableWidth), theme);
  }).join("\n");
}

export default function (pi: ExtensionAPI) {
  const supported = typeof pi.registerToolRenderer === "function";
  const markdownSupported = typeof pi.registerMarkdownTransformer === "function";
  let uiTheme: (() => Theme) | undefined;
  const safeGetSettings = () => {
    try { return pi.getSettings(); } catch { return undefined; }
  };
  const groups = new ToolGroups(() => safeGetSettings()?.hideThinkingBlock === true);
  const paths = new PathLabels();
  pi.registerCommand("progress", {
    description: "status：查看中文过程展示状态和详情入口",
    handler: async (args, ctx) => {
      if (args.trim() && args.trim() !== "status") { ctx.ui.notify("用法：/progress status", "info"); return; }
      const settings = safeGetSettings() ?? {};
      ctx.ui.notify([
        `中文过程展示 ${PLUGIN_VERSION}；当前 Pi ${VERSION}。间距适配 Pi ${TESTED_PI_VERSIONS.join(" / ")}；当前组合 G+H+I+J${INTRA_GAP === 1 ? "+K" : ""}${ENABLE_DITTO ? "+L" : ""}，保留半屏一至两行摘要、右缘元信息栏、C 目标优先与重复片段省略；实际观感待用户验收。`,
        supported ? "有文字或 thinking 的响应在原位置显示工具摘要；空白响应仍可集中。收起态先显示目标，再在右缘显示弱化的工具名和状态；简单操作一行，复杂命令第二行显示关键动作和条件；每行连同缩进、工具名和状态不超过可用宽度的一半，未知命令也受限。edit/write 单行显示绿色 +N 新增行与红色 -M 删除行；内联脚本跳过固定初始化并优先提取操作路径或 URL 单行展示。显示具体对象和真实代码片段，保留原有管道或分号，不新增类别标签或箭头链；未知脚本直接保留可读的原始片段。第二行只在包含新增对象、参数或条件时显示；仅重复目标或只剩 && …、; … 时省略，Ctrl+O 仍可查看完整命令。文件目标为 #C9BA9A，错误只在末尾标柔和红色；Ctrl+O 展开原有详情。" : "公开工具渲染接口不可用，工具摘要未启用。",
        "摘要路径：工作目录内使用相对路径，外部绝对路径优先保留末尾三级，重名时增加目录；目录与行号调暗、文件名突出，路径按目录边界折叠，多目标按整项显示并用 +N 标出省略数量。仅在收起显示层清理 shell 转义和边缘引号；Ctrl+O 查看原始详情。成功不显示 [done]，pending/running/error 与内部失败、取消状态仍显示。",
        ENABLE_DITTO ? "同组连续相同且均已完成的工具，从第二条起右栏显示暗色 ·；工具切换、未完成、错误及新节点首条仍显示工具名。" : "右栏逐条保留完整工具名，L 同上省略未启用。",
        markdownSupported ? "节点说明：首行和续行统一 ▎、两列悬挂、最长 68 列正文；中文与工具目标均不加粗，说明首分句提亮、后续较暗、无逗号或分号的单句使用中亮度，英文标识符独立配色；工具行降亮，摘录第二行使用 └ 连接；模型未遵守格式时保留正文显示。" : "公开 Markdown 接口不可用，节点说明保留正文显示。",
        "说明由当前主模型正常输出；插件不另发模型请求，不追加独立说明节点。",
        SPACING_SUPPORTED ? `间距补齐已启用：收起态说明到命令及同组命令间以 ${INTRA_GAP} 行空白为目标，跨节点保持 ${STAGE_GAP} 行；只补不足，原生超过目标的保留。展开或工具组实际含可显示图片时保留原生布局。` : "当前 Pi 版本未验证间距模型，自动停用补齐；原生留白保留。",
        "字体由终端决定；不修改 Pi 原生分隔、消息记录或 thinking。",
        `原生 thinking：${markdownSupported ? "插件仅在界面隐藏正文，原始记录保留" : settings.hideThinkingBlock ? "宿主设置隐藏" : "可见"}；工具图片：${settings.terminal?.showImages === false ? "已隐藏" : "允许显示"}。图片继续服从 Pi 原生开关。`,
        ctx.mode === "tui" ? "当前为终端界面。" : "当前不是终端界面，工具协议和原始结果仍正常输出。",
      ].join("\n"), supported ? "info" : "warning");
    },
  });
  if (!supported) return;
  pi.registerToolRenderer((toolName, next) => quietRenderers(toolName, next(), groups, paths));
  if (markdownSupported) pi.registerMarkdownTransformer((markdown, context) => context.messageType === "assistant-thinking" ? "" : uiTheme ? styleNarration(markdown, context, uiTheme()) : markdown);
  pi.on("message_start", event => groups.begin(event.message));
  pi.on("message_update", event => groups.observe(event.message));
  pi.on("message_end", event => groups.observe(event.message, true));
  pi.on("session_tree", (_event, ctx) => { paths.clear(); groups.restore(ctx.sessionManager.getBranch()); });
  pi.on("session_compact", (_event, ctx) => { paths.clear(); groups.restore(ctx.sessionManager.getBranch()); });
  pi.on("before_agent_start", event => {
    const guidelines = event.systemPromptOptions?.promptGuidelines;
    if (!Array.isArray(guidelines)) return;
    for (const rule of NARRATION_RULES) if (!guidelines.includes(rule)) guidelines.push(rule);
  });
  pi.on("session_start", (_event, ctx) => {
    paths.clear();
    groups.restore(ctx.sessionManager.getBranch());
    if (ctx.mode !== "tui") { uiTheme = undefined; return; }
    // Resolve the UI's current theme on every transform, including after /theme.
    uiTheme = () => ctx.ui.theme;
    ctx.ui.setToolsExpanded(false);
    ctx.ui.setHiddenThinkingLabel("");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    paths.clear();
    groups.clear();
    uiTheme = undefined;
    if (ctx.mode === "tui") ctx.ui.setHiddenThinkingLabel();
  });
}
