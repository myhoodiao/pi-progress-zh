import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

// ANSI must be exercised even in a pipe; this setting affects only this test process.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "3";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Both supported display combinations use this same behavioral suite.
const source = readFileSync(join(root, "index.ts"), "utf8");
const INTRA_GAP = Number(source.match(/const INTRA_GAP = (\d);/)[1]);
const ENABLE_DITTO = source.match(/const ENABLE_DITTO = (true|false);/)[1] === "true";
assert.ok([1, 2].includes(INTRA_GAP));
const install = join(homedir(), ".pi", "agent", "install");
const release = readFileSync(join(install, "current-version"), "utf8").trim();
const modules = join(install, "releases", release, "node_modules");
const agentRoot = join(modules, "@earendil-works", "pi-coding-agent");
const agent = await import(pathToFileURL(join(agentRoot, "dist", "index.js")));
const tui = await import(pathToFileURL(join(modules, "@earendil-works", "pi-tui", "dist", "index.js")));
const loader = await import(pathToFileURL(join(agentRoot, "dist", "core", "extensions", "loader.js")));
const loaded = await loader.loadExtensions([join(root, "index.ts")], root);
assert.deepEqual(loaded.errors, []);
let hiddenThinking = true;
loaded.runtime.getSettings = () => ({ hideThinkingBlock: hiddenThinking });
const extension = loaded.extensions[0];
const resolver = extension.toolRenderers[0];
agent.initTheme("dark", false);
const theme = (await import(pathToFileURL(join(agentRoot, "dist", "modes", "interactive", "theme", "theme.js")))).theme;
tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
const ui = { requestRender() {} };
const output = Array.from({ length: 120 }, (_, i) => `original-line-${i}`).join("\n");
const goodResult = () => ({ content: [{ type: "text", text: output }], details: { intact: true } });
function component(name = "external_tool", args = { path: "original-path" }, original, options = {}) {
  const { callId = "call-1", cwd = root, ...settings } = options;
  return new agent.ToolExecutionComponent(name, callId, args, { showImages: false, ...settings }, resolver(name, () => original), ui, cwd);
}
function lines(item, width = 120) { return item.render(width).map(tui.stripTerminalSequences).join("\n"); }
function native(name) { return agent[`create${({ ls: "Ls", bash: "Bash", powershell: "PowerShell", read: "Read", write: "Write", edit: "Edit", grep: "Grep", find: "Find" })[name]}ToolDefinition`](root); }
function assertBackground(item, token) {
  const prefix = theme.bg(token, "").split("\x1b[49m")[0];
  assert.ok(prefix.length > 0);
  assert.ok(item.render(120).some(line => line.includes(prefix)), token);
}
function assertNoBackground(item) {
  assert.ok(item.render(120).every(line => !line.includes("\x1b[48;")));
}
const fileColor = tui.parseColor("#C9BA9A");
function fileText(value) {
  const range = value.match(/:\d+(?:-\d+)?$/)?.[0] ?? "";
  const body = range ? value.slice(0, -range.length) : value;
  const split = Math.max(body.lastIndexOf("/"), body.lastIndexOf("\\")) + 1;
  return theme.style(body.slice(0, split), { fg: tui.parseColor("#8E846E"), bold: false })
    + theme.style(body.slice(split), { fg: fileColor, bold: false })
    + theme.style(range, { fg: tui.parseColor("#6E797C"), bold: false });
}
function softErrorText(value) { return theme.style(value, { fg: tui.parseColor("#D99083") }); }

test("pending, streaming and success keep one summary; output and arguments survive", () => {
  const args = { path: "original-path", content: "PRIVATE_WRITE_BODY" };
  const result = goodResult();
  const before = JSON.stringify({ args, result });
  const item = component("write", args);
  for (const width of [32, 80, 140]) {
    assert.equal(item.render(width).length, 2); // One native inter-tool spacer and one summary.
    assert.match(lines(item, width), width >= 80 ? /write/ : /pending/);
    assert.ok(item.render(width).every(line => tui.visibleWidth(line) <= width));
  }
  assert.match(lines(item), /pending/);
  assertNoBackground(item);
  item.markExecutionStarted();
  item.updateResult(result, true);
  assert.match(lines(item), /running/);
  assert.equal(item.render(80).length, 2);
  item.updateResult(result, false);
  assert.doesNotMatch(lines(item), /\[done\]|\[running\]|\[pending\]/);
  assertNoBackground(item);
  assert.doesNotMatch(lines(item), /PRIVATE_WRITE_BODY|original-line/);
  item.setExpanded(true);
  assert.match(lines(item), /PRIVATE_WRITE_BODY|original-line-119/);
  assert.match(lines(item), /original-line-119/);
  item.setExpanded(false);
  assert.equal(item.render(80).length, 2);
  assert.equal(JSON.stringify({ args, result }), before);
});

test("errors keep the operation and raw errors appear only on expansion", () => {
  const item = component("bash", { command: "first-command\nPRIVATE_SECOND_COMMAND" });
  item.updateResult({ content: [{ type: "text", text: "RAW_PRIVATE_ERROR" }], isError: true }, false);
  assert.match(lines(item), /first-command.*bash.*error/);
  assert.doesNotMatch(lines(item), /RAW_PRIVATE_ERROR|PRIVATE_SECOND_COMMAND/);
  assertNoBackground(item);
  assert.ok(item.render(120).join("\n").includes(softErrorText(" [error]")));
  assert.equal(item.render(120).length, 2);
  item.setExpanded(true);
  assert.match(lines(item), /RAW_PRIVATE_ERROR/);
  assert.match(lines(item), /PRIVATE_SECOND_COMMAND/);
});

test("all built-ins have compact targets and native details remain available", () => {
  const samples = {
    read: { path: "AGENTS.md", offset: 2, limit: 4 },
    edit: { path: "config.yaml", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" },
    write: { path: "report.md", content: "PRIVATE_CONTENT" },
    bash: { command: "rg -n proxy .\nPRIVATE_NEXT_COMMAND" },
    powershell: { command: "Get-Content config.yaml\nPRIVATE_NEXT_COMMAND" },
    grep: { pattern: "proxy", path: "src" },
    find: { pattern: "*.ts", path: "src" },
    ls: { path: "src" },
  };
  for (const [name, args] of Object.entries(samples)) {
    const item = component(name, args, native(name));
    const result = goodResult();
    if (name === "edit") result.details.diff = "-PRIVATE_OLD\n+PRIVATE_NEW";
    item.updateResult(result, false);
    assert.equal(item.render(120).length, ["bash", "powershell", "grep", "find"].includes(name) ? 3 : 2, name);
    assert.match(lines(item), new RegExp(name));
    assert.doesNotMatch(lines(item), /PRIVATE_|original-line/);
    item.setExpanded(true);
    assert.match(lines(item), name === "edit" ? /PRIVATE_NEW/ : name === "write" ? /PRIVATE_CONTENT/ : /original-line/, name);
  }
  const item = component("read", samples.read, native("read"));
  assert.match(lines(item), /AGENTS.md:2-5.*read resource/);
});

test("file targets use the selected color and the type label is muted", () => {
  const read = component("read", { path: "src/config/app.json" });
  read.updateResult(goodResult(), false);
  const readRow = read.render(120).join("\n");
  assert.ok(readRow.includes(fileText("src/config/app.json")));
  assert.ok(readRow.includes(theme.style("  read", { fg: tui.parseColor("#687478") })));
  assertNoBackground(read);
  const custom = component("mcp_file", { file_path: "other/file.txt", content: "PRIVATE_BODY" });
  assert.ok(custom.render(120).join("\n").includes(fileText("other/file.txt")));
  const direct = component("bash", { command: "cp src/input.txt dst/output.txt" });
  const directRow = direct.render(120).join("\n");
  assert.match(directRow, /cp src\/input.txt dst\/output.txt/);
  assert.ok(directRow.includes(fileText("src/input.txt")));
  assert.ok(directRow.includes(fileText("dst/output.txt")));
  assert.doesNotMatch(directRow, /PRIVATE_BODY/);
  for (const command of ["node scripts/check.js", "cp src/a dst/b && echo done", "python -c 'open(\"a\").read()'"]) {
    const item = component("bash", { command });
    assert.ok(!item.render(120).join("\n").includes(fileText("cp")));
    assertNoBackground(item);
  }
  const error = component("bash", { command: "node scripts/check.js" });
  error.updateResult({ content: [{ type: "text", text: "PRIVATE_ERROR" }], isError: true }, false);
  const errorRow = error.render(120).join("\n");
  assert.ok(errorRow.includes(softErrorText(" [error]")));
  assertNoBackground(error);
  assert.doesNotMatch(lines(error), /PRIVATE_ERROR/);
});

test("long primary summaries preserve filenames and count omitted whole targets", () => {
  const grep = component("grep", { pattern: "a".repeat(100), path: "src/final-target.md" });
  assert.match(lines(grep, 80), /final-target\.md/);
  const copy = component("bash", { command: `cp ${"long/".repeat(20)}source.md target.md` });
  assert.match(summaryRows(copy, 80)[0], /source\.md\s+\+1/);
  copy.setExpanded(true);
  assert.match(lines(copy, 240), /target\.md/);
  copy.setExpanded(false);
  assert.ok(copy.render(55).every(line => tui.visibleWidth(line) <= 55));
});

test("long paths preserve the filename; command heads truncate in one visual row", () => {
  const item = component("read", { path: `D:/很长的中文目录/${"子目录/".repeat(25)}target.md`, offset: 12, limit: 3 });
  item.updateResult(goodResult(), false);
  for (const width of [40, 80]) {
    assert.equal(item.render(width).length, 2);
    assert.match(lines(item, width), /….*target.md:12-14/);
    assert.ok(item.render(width).every(line => tui.visibleWidth(line) <= width));
  }
  const command = component("powershell", { command: `\n\nGet-Content ${"a".repeat(200)}\nSECRET_LATER_COMMAND` });
  assert.match(lines(command, 80), /Get-Content.*…/);
  assert.doesNotMatch(lines(command), /SECRET_LATER_COMMAND/);
  for (const width of [8, 16, 32]) assert.ok(command.render(width).every(line => tui.visibleWidth(line) <= width));
});

test("literal Python and PowerShell wrappers show one script line without inventing calls", () => {
  const python = component("bash", { command: 'python -c "\nfrom pathlib import Path\nPRIVATE_LATER_LINE\n"' });
  assert.match(lines(python), /from pathlib import Path.*bash/);
  assert.doesNotMatch(lines(python), /PRIVATE_LATER_LINE/);
  const powershell = component("bash", { command: "powershell -NoProfile -Command '\nGet-Process -Name pi\nPRIVATE_LATER_LINE\n'" });
  assert.match(lines(powershell), /pi.*bash[\s\S]*Get-Process/);
  assert.doesNotMatch(lines(powershell), /PRIVATE_LATER_LINE/);
});

test("summary targets lead at normal widths and narrow windows preserve target and state", () => {
  for (const outputPad of [0, 1, 3]) {
    const samples = [
      ["read", { path: "aligned.md" }, native("read")],
      ["edit", { path: "aligned.md" }],
      ["write", { path: "aligned.md" }],
      ["powershell", { command: "aligned.md" }],
      ["mcp_custom", { path: "aligned.md" }],
    ];
    const columns = samples.map(([name, args, original]) => {
      const item = component(name, args, original, { outputPad });
      item.updateResult(goodResult(), false);
      const row = item.render(80).map(tui.stripTerminalSequences).find(line => line.includes("aligned.md"));
      assert.match(row, /aligned\.md/);
      assert.doesNotMatch(row, /\[done\]/);
      return row.indexOf("aligned.md");
    });
    assert.deepEqual(columns, columns.map(() => outputPad));
  }
  const item = component("write", { path: "target.md" });
  item.updateResult(goodResult(), false);
  assert.match(lines(item, 24), /target\.md\s*$/);
  for (const width of [8, 16, 24, 40, 80]) {
    assert.equal(item.render(width).length, 2);
    assert.ok(item.render(width).every(line => tui.visibleWidth(line) <= width));
  }
});

test("project paths become relative while ranges and original expanded arguments survive", () => {
  for (const [cwd, path, expected] of [
    ["C:/work/demo", "C:/work/demo/src/config.json", "src/config.json:2-5"],
    ["C:\\work\\demo", "c:\\WORK\\demo\\src\\config.json", "src/config.json:2-5"],
    ["/work/demo", "/work/demo/src/config.json", "src/config.json:2-5"],
  ]) {
    const args = { path, offset: 2, limit: 4 };
    const before = JSON.stringify(args);
    const item = component("read", args, undefined, { cwd });
    item.updateResult(goodResult(), false);
    assert.ok(lines(item).includes(expected));
    assert.ok(!lines(item).includes(path));
    assert.doesNotMatch(lines(item), /\[done\]/);
    assert.ok(item.render(120).join("\n").includes(fileText(expected)));
    item.setExpanded(true);
    assert.ok(lines(item, 240).includes(JSON.stringify(path).slice(1, -1)));
    assert.match(lines(item), /original-line-119/);
    assert.equal(JSON.stringify(args), before);
  }
});

test("external paths keep three trailing components and disambiguate same-tail files", async () => {
  await transformerSetup();
  const a = component("read", { path: "D:/outside/alpha/src/config/app.json" }, undefined, { cwd: "C:/work" });
  assert.match(lines(a), /…\/src\/config\/app\.json/);
  const b = component("read", { path: "E:/outside/beta/src/config/app.json" }, undefined, { cwd: "C:/work" });
  assert.match(lines(a), /…\/alpha\/src\/config\/app\.json/);
  assert.match(lines(b), /…\/beta\/src\/config\/app\.json/);
  const c = component("read", { path: "E:/outside/alpha/src/config/app.json" }, undefined, { cwd: "C:/work" });
  assert.match(lines(a), /D:\/outside\/alpha\/src\/config\/app\.json/);
  assert.match(lines(c), /E:\/outside\/alpha\/src\/config\/app\.json/);
  const unc = component("read", { path: "\\\\server\\share\\folder\\nested\\file.md" }, undefined, { cwd: "C:/work" });
  assert.match(lines(unc), /…\/folder\/nested\/file\.md/);
  for (const width of [24, 40, 80]) assert.ok(a.render(width).every(row => tui.visibleWidth(row) <= width));
});

test("paths outside the cwd prefix, relative targets and URLs are not misidentified", () => {
  const outside = component("read", { path: "C:/work/demo-other/src/app.json" }, undefined, { cwd: "C:/work/demo" });
  assert.match(lines(outside), /…\/demo-other\/src\/app\.json/);
  for (const path of ["../shared/file.md", "https://example.test/one/two/three/file.md", "C:relative.md", "~/notes/file.md"]) {
    assert.ok(lines(component("read", { path }, undefined, { cwd: "C:/work" }), 160).includes(path));
  }
});

test("simple file command targets shorten without changing commands or their search patterns", () => {
  const command = 'cp "C:/work/demo/src/input file.md" "D:/external/archive/reports/output file.md"';
  const item = component("bash", { command }, undefined, { cwd: "C:/work/demo" });
  item.updateResult(goodResult(), false);
  const collapsed = lines(item, 220);
  assert.ok(collapsed.includes('src/input file.md, …/archive/reports/output file.md'));
  assert.ok(collapsed.includes(command));
  assert.doesNotMatch(collapsed, /\[done\]/);
  item.setExpanded(true);
  assert.ok(lines(item, 240).includes(JSON.stringify(command).slice(1, -1)));
  const grep = component("grep", { pattern: "/some/search/pattern", path: "C:/work/demo/src" }, undefined, { cwd: "C:/work/demo" });
  assert.match(lines(grep), /src\s+grep[\s\S]*\/some\/search\/pattern/);
  const complex = component("bash", { command: "cat C:/work/demo/a.md && echo done" }, undefined, { cwd: "C:/work/demo" });
  assert.match(lines(complex), /a\.md[\s\S]*&& …/);
  complex.setExpanded(true);
  assert.match(lines(complex, 240), /C:\/work\/demo\/a\.md && echo done/);
});

test("multiple structured paths shorten independently and errors remain explicit", () => {
  const args = { paths: ["C:/work/demo/src/a.md", "D:/external/docs/ref/b.md"] };
  const item = component("mcp_files", args, undefined, { cwd: "C:/work/demo" });
  assert.match(lines(item), /src\/a\.md, …\/docs\/ref\/b\.md.*pending/);
  item.markExecutionStarted();
  assert.match(lines(item), /\[running\]/);
  assert.ok(item.render(120).join("\n").includes(theme.fg("warning", " [running]")));
  item.updateResult({ content: [{ type: "text", text: "ORIGINAL_ERROR" }], isError: true }, false);
  assert.match(lines(item), /\[error\]/);
  assert.ok(item.render(120).join("\n").includes(softErrorText(" [error]")));
  item.setExpanded(true);
  assert.match(lines(item), /C:\/work\/demo\/src\/a\.md/);
  assert.match(lines(item), /ORIGINAL_ERROR/);
});

test("partial arguments and absent targets do not fail or invent a file", () => {
  const item = component("read", {});
  assert.match(lines(item), /…\s+read.*pending/);
  item.updateArgs({ path: "half" });
  assert.match(lines(item), /half/);
  item.updateArgs({ path: "complete.md" });
  assert.match(lines(item), /complete.md/);
  assert.doesNotMatch(lines(item), /half/);
});

test("MCP and unknown tools use target priority without dumping content", () => {
  for (const [args, expected] of [
    [{ url: "https://example.test/docs", content: "PRIVATE_CONTENT" }, /https:\/\/example.test\/docs/],
    [{ uri: "resource://config" }, /resource:\/\/config/],
    [{ query: "proxy issue" }, /proxy issue/],
    [{ count: 3, content: "PRIVATE_CONTENT" }, /count=3/],
    [{ content: "PRIVATE_CONTENT" }, /mcp_custom/],
  ]) {
    const item = component("mcp_custom", args);
    assert.match(lines(item), expected);
    assert.equal(item.render(120).length, 2);
    assert.doesNotMatch(lines(item), /PRIVATE_CONTENT/);
  }
  const original = { renderCall: () => new tui.Text("mcp_custom PRIVATE_CONTENT", 0, 0) };
  assert.doesNotMatch(lines(component("mcp_custom", { content: "PRIVATE_CONTENT" }, original)), /PRIVATE_CONTENT/);
});

test("expanded delegates preserve native state and lastComponent across toggles", () => {
  const args = { path: "native.md" };
  const nativeCall = new tui.Text("read CUSTOM native.md", 0, 0);
  const nativeResult = new tui.Text("NATIVE-RESULT", 0, 0);
  let firstCall = true;
  let firstResult = true;
  const original = {
    renderCall(received, _theme, context) {
      assert.equal(received, args);
      if (!firstCall) assert.equal(context.lastComponent, nativeCall);
      firstCall = false;
      context.state.original = true;
      return nativeCall;
    },
    renderResult(result, options, _theme, context) {
      assert.equal(options.expanded, true);
      assert.equal(context.state.original, true);
      if (!firstResult) assert.equal(context.lastComponent, nativeResult);
      firstResult = false;
      assert.equal(result.details.intact, true);
      return nativeResult;
    },
  };
  const item = component("read", args, original);
  item.updateResult(goodResult(), false);
  assert.equal(firstResult, true);
  for (let i = 0; i < 2; i++) {
    item.setExpanded(true);
    assert.match(lines(item), /CUSTOM native.md/);
    assert.match(lines(item), /NATIVE-RESULT/);
    assertBackground(item, "toolSuccessBg");
    item.setExpanded(false);
  }
});

test("self-framing native expanded renderers are not boxed twice", () => {
  const original = {
    renderShell: "self",
    renderCall: () => new tui.Text("SELF-CALL", 0, 0),
    renderResult: () => new tui.Text("SELF-RESULT", 0, 0),
  };
  const item = component("custom", {}, original);
  item.updateResult(goodResult(), false);
  assertNoBackground(item);
  item.setExpanded(true);
  assert.deepEqual(item.render(80).map(line => line.trimEnd()), ["", "SELF-CALL", "SELF-RESULT"]);
  assert.ok(item.render(80).every(line => !line.includes("\x1b[48;")));
});

test("failed native renderers fall back to raw arguments and text", () => {
  const fail = () => { throw new Error("bad renderer"); };
  const item = component("mcp_example", { command: "original-command" }, { renderCall: fail, renderResult: fail });
  item.updateResult(goodResult(), false);
  assert.match(lines(item), /original-command/);
  item.setExpanded(true);
  assert.match(lines(item), /original-command/);
  assert.match(lines(item), /original-line-119/);
});

test("native component render failures also fall back without crashing the transcript", () => {
  const bad = { render() { throw new Error("component failure"); }, invalidate() {} };
  const item = component("broken", { path: "raw.md" }, { renderCall: () => bad, renderResult: () => bad });
  item.updateResult(goodResult(), false);
  item.setExpanded(true);
  assert.match(lines(item), /raw.md/);
  assert.match(lines(item), /original-line-119/);
});

test("codemode nested snapshots replace rows, retain all calls and hide script output", () => {
  const item = component("codemode", { code: "await tools.read({path:'sample.md'});\nPRIVATE_SCRIPT_BODY" });
  const first = { name: "read", args: '{"path":"sample.md"}', status: "running" };
  item.updateResult({ content: [], details: { calls: [first] } }, true);
  assert.equal(item.render(120).length, 3 + INTRA_GAP);
  assert.match(lines(item), /sample.md.*running/);
  const calls = [{ ...first, status: "ok" }, { name: "bash", args: '{"command":"echo demo"}', status: "error", error: "PRIVATE_NESTED_ERROR" }, { name: "mcp_custom", args: "resource://demo", status: "cancelled" }];
  item.updateResult({ content: [{ type: "text", text: "PRIVATE_SCRIPT_OUTPUT" }], details: { calls } }, false);
  const collapsed = lines(item);
  assert.equal(item.render(120).length, 2 + 3 * (INTRA_GAP + 1));
  assert.equal(collapsed.split("\n").filter(line => /^\s*sample.md .*read/.test(line)).length, 1);
  assert.doesNotMatch(collapsed, /\[done\]/);
  assert.match(collapsed, /bash.*failed/);
  assert.match(collapsed, /mcp_custom.*cancelled/);
  assert.doesNotMatch(collapsed, /PRIVATE_SCRIPT_BODY|PRIVATE_SCRIPT_OUTPUT|PRIVATE_NESTED_ERROR/);
  item.setExpanded(true);
  assert.match(lines(item), /PRIVATE_SCRIPT_BODY/);
  assert.match(lines(item), /PRIVATE_SCRIPT_OUTPUT/);
  assert.match(lines(item), /PRIVATE_NESTED_ERROR/);
  item.setExpanded(false);
  assert.equal(item.render(120).length, 2 + 3 * (INTRA_GAP + 1));
});

test("200 tools add only their summary and native spacer, without output accumulation", () => {
  const items = Array.from({ length: 200 }, (_, i) => {
    const item = component("read", { path: `file-${i}.md` });
    item.updateResult(goodResult(), false);
    return item;
  });
  const rows = items.flatMap(item => item.render(80));
  assert.equal(rows.length, 400);
  assert.equal(rows.filter(row => tui.stripTerminalSequences(row).trim()).length, 200);
  assert.doesNotMatch(rows.join("\n"), /original-line/);
});

test("images obey the native display setting and never dump encoded data", () => {
  const item = component("read", { path: "image.png" });
  item.updateResult({ content: [{ type: "image", mimeType: "image/png", data: "PNG_TEST_SENTINEL" }] }, false);
  assert.equal(item.render(80).length, 2);
  item.setExpanded(true);
  assert.match(lines(item), /图片显示由 Pi 原生设置控制/);
  assert.doesNotMatch(lines(item), /PNG_TEST_SENTINEL/);
});

async function transformerSetup() {
  await extension.handlers.get("session_start")[0]({}, { mode: "tui", sessionManager: { getBranch: () => [] }, ui: { theme, setToolsExpanded() {}, setHiddenThinkingLabel() {} } });
  assert.equal(typeof extension.markdownTransformer, "function");
  return extension.markdownTransformer;
}

function assistantCalls(ids) {
  return { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "read", arguments: { path: `${id}.md` } })) };
}
async function observe(message, type = "message_update") {
  await extension.handlers.get(type)[0]({ message }, {});
}
async function resetGroups() {
  await extension.handlers.get("session_tree")[0]({}, { sessionManager: { getBranch: () => [] } });
}
function transcript(items, width = 80) {
  return items.flatMap(item => item.render(width));
}
test("same-response tools use the configured gap; streaming and expansion stay intact", async () => {
  await resetGroups();
  const message = assistantCalls(["group-a", "group-b", "group-c"]);
  const before = JSON.stringify(message);
  await observe(assistantCalls(["group-a"]));
  const first = component("read", { path: "group-a.md" }, native("read"), { callId: "group-a" });
  await observe(message);
  const second = component("read", { path: "group-b.md" }, native("read"), { callId: "group-b" });
  const third = component("read", { path: "group-c.md" }, native("read"), { callId: "group-c" });
  const items = [first, second, third];
  const pending = transcript(items).map(tui.stripTerminalSequences).join("\n");
  assert.equal(transcript(items).length, 4 + 2 * INTRA_GAP);
  assert.equal(second.render(80).length, 0);
  assert.match(pending, /group-a\.md.*pending/);
  second.markExecutionStarted();
  assert.match(lines(first), /group-b\.md.*running/);
  first.updateResult(goodResult(), false);
  second.updateResult({ content: [{ type: "text", text: "GROUP_PRIVATE_ERROR" }], isError: true }, false);
  third.updateResult(goodResult(), false);
  const collapsed = transcript(items).map(tui.stripTerminalSequences).join("\n");
  assert.match(collapsed, /group-a\.md/);
  assert.doesNotMatch(collapsed, /\[done\]/);
  assert.match(collapsed, /group-b\.md.*error/);
  assertNoBackground(first);
  assert.doesNotMatch(collapsed, /GROUP_PRIVATE_ERROR|original-line/);
  for (const width of [32, 80, 140]) {
    assert.equal(transcript(items, width).length, 4 + 2 * INTRA_GAP);
    assert.ok(transcript(items, width).every(line => tui.visibleWidth(line) <= width));
  }
  for (const item of items) item.setExpanded(true);
  const expanded = transcript(items).map(tui.stripTerminalSequences).join("\n");
  assert.equal(expanded.split("original-line-119").length - 1, 2);
  assert.match(expanded, /GROUP_PRIVATE_ERROR/);
  for (const item of items) item.setExpanded(false);
  assert.equal(transcript(items).map(tui.stripTerminalSequences).join("\n"), collapsed);
  // A mouse expansion of one native record temporarily leaves the others visible.
  second.setExpanded(true);
  assert.match(transcript(items).map(tui.stripTerminalSequences).join("\n"), /GROUP_PRIVATE_ERROR/);
  assert.match(lines(first), /group-a\.md/);
  assert.match(lines(third), /group-c\.md/);
  second.setExpanded(false);
  assert.equal(transcript(items).length, 4 + 2 * INTRA_GAP);
  assert.equal(JSON.stringify(message), before);
});

test("tool-only responses share a stage; visible text and user input start a new one", async () => {
  await resetGroups();
  await observe({ role: "user", content: "检查配置" }, "message_start");
  await observe({ role: "assistant", content: [{ type: "text", text: "*检查配置。*" }, ...assistantCalls(["cross-a"]).content] });
  const first = component("read", { path: "cross-a.md" }, undefined, { callId: "cross-a" });
  await observe({ role: "toolResult", toolCallId: "cross-a" }, "message_start");
  await observe(assistantCalls(["cross-b"]));
  const second = component("read", { path: "cross-b.md" }, undefined, { callId: "cross-b" });
  assert.equal(transcript([first, second]).length, 3 + INTRA_GAP);
  assert.match(lines(first), /cross-b\.md/);
  assert.equal(second.render(80).length, 0);
  await observe({ role: "assistant", content: [{ type: "text", text: "*进入下一阶段。*" }] });
  await observe(assistantCalls(["cross-c"]));
  const third = component("read", { path: "cross-c.md" }, undefined, { callId: "cross-c" });
  assert.equal(transcript([first, second, third]).length, 5 + INTRA_GAP);
  assert.doesNotMatch(lines(first), /cross-c\.md/);
  await observe({ role: "user", content: "继续" }, "message_start");
  await observe(assistantCalls(["cross-d"]));
  const fourth = component("read", { path: "cross-d.md" }, undefined, { callId: "cross-d" });
  assert.equal(transcript([first, second, third, fourth]).length, 7 + INTRA_GAP);
});

test("thinking before each tool keeps Gemini-style rows near their original slot", async () => {
  await resetGroups();
  const transform = await transformerSetup();
  const items = [];
  const messages = [];
  for (let index = 0; index < 12; index++) {
    const id = `thinking-${index}`;
    const message = {
      role: "assistant", stopReason: "toolUse",
      content: [{ type: "thinking", thinking: `Step ${index}` }, { type: "toolCall", id, name: "read", arguments: { path: `${id}.md` } }],
    };
    messages.push(message);
    await observe(message, "message_end");
    const assistant = new agent.AssistantMessageComponent(message, false, agent.getMarkdownTheme(), "", 1, [transform]);
    const tool = component("read", { path: `${id}.md` }, undefined, { callId: id });
    tool.updateResult(goodResult(), false);
    assert.match(lines(tool), new RegExp(`${id}\\.md`));
    assert.equal(tool.render(80).length, 2);
    items.push(assistant, tool);
  }
  const rows = transcript(items).map(tui.stripTerminalSequences);
  const filenames = rows.flatMap(line => line.match(/thinking-\d+\.md/g) ?? []);
  assert.deepEqual(filenames, messages.map((_, index) => `thinking-${index}.md`));
  let longestBlankRun = 0;
  let current = 0;
  for (const row of rows) {
    current = row.trim() ? 0 : current + 1;
    longestBlankRun = Math.max(longestBlankRun, current);
  }
  assert.ok(longestBlankRun <= 3, `longest blank run: ${longestBlankRun}`);
  assert.ok(rows.length <= 12 * 5, `total lines: ${rows.length}`);
  assert.deepEqual(messages.map(message => message.content[0].thinking), messages.map((_, index) => `Step ${index}`));
});

test("resume, tree and compaction restore cross-response stages", async () => {
  const branch = [
    { type: "message", message: { role: "user", content: "检查配置" } },
    { type: "message", message: assistantCalls(["restore-a", "restore-b"]) },
    { type: "message", message: { role: "toolResult", toolCallId: "restore-b" } },
    { type: "message", message: assistantCalls(["restore-c"]) },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "*进入下一阶段。*" }] } },
    { type: "message", message: assistantCalls(["restore-d"]) },
  ];
  const before = JSON.stringify(branch);
  const context = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { theme, setToolsExpanded() {}, setHiddenThinkingLabel() {} } };
  for (const event of ["session_start", "session_tree", "session_compact"]) {
    await extension.handlers.get(event)[0]({}, context);
    const items = ["restore-a", "restore-b", "restore-c", "restore-d"].map(id => component("read", { path: `${id}.md` }, undefined, { callId: id }));
    for (const item of items) item.updateResult(goodResult(), false);
    assert.equal(transcript(items).length, 6 + 3 * INTRA_GAP); // Three intra-node gaps and the cross-node top-up.
    assert.match(lines(items[0]), /restore-c/);
    assert.doesNotMatch(lines(items[0]), /restore-d/);
    assert.match(lines(items[3]), /restore-d/);
  }
  await extension.handlers.get("session_shutdown")[0]({}, context);
  assert.equal(component("read", { path: "reset.md" }, undefined, { callId: "restore-b" }).render(80).length, 2);
  assert.equal(JSON.stringify(branch), before);
});

test("grouped codemode lists update once and enabling images keeps native slots", async () => {
  await resetGroups();
  await observe(assistantCalls(["nested-a", "nested-b"]), "message_end");
  const first = component("codemode", { code: "await tools.read();" }, undefined, { callId: "nested-a" });
  const second = component("mcp_custom", { path: "second.md" }, undefined, { callId: "nested-b" });
  for (const status of ["running", "ok"]) first.updateResult({ content: [], details: { calls: [{ name: "read", args: "nested.md", status }] } }, status === "running");
  second.updateResult(goodResult(), false);
  const text = transcript([first, second]).map(tui.stripTerminalSequences).join("\n");
  assert.equal(transcript([first, second]).length, 4 + 2 * INTRA_GAP);
  assert.equal(text.split("nested.md").length - 1, 1);
  await resetGroups();
  await observe(assistantCalls(["images-a", "images-b"]));
  const images = ["images-a", "images-b"].map(id => component("read", { path: "image.png" }, undefined, { callId: id, showImages: true }));
  assert.equal(transcript(images).length, 3 + INTRA_GAP); // Separate native slots retain their own spacer.
  assert.deepEqual(visibleGaps(images), [INTRA_GAP]);
});

test("200 calls retain all ordered summaries with the configured internal gap", async () => {
  await resetGroups();
  const ids = Array.from({ length: 200 }, (_, i) => `batch-${i}`);
  await observe(assistantCalls(ids));
  const items = ids.map(id => component("read", { path: `${id}.md` }, undefined, { callId: id }));
  for (const item of items) item.updateResult(goodResult(), false);
  const rows = transcript(items).map(tui.stripTerminalSequences);
  assert.equal(rows.length, 201 + 199 * INTRA_GAP);
  assert.deepEqual(rows.filter(line => line.trim()).map(line => line.match(/batch-\d+\.md/)[0]), ids.map(id => `${id}.md`));
  assert.deepEqual(visibleGaps(items), Array(199).fill(INTRA_GAP));
});

// Exercise actual message_start/update/end ordering, including native assistant spacers.
async function stage(content, { stopReason = "toolUse", showImages = false } = {}) {
  const message = { role: "assistant", content, stopReason };
  await observe({ role: "assistant", content: [] }, "message_start");
  await observe(message);
  await observe(message, "message_end");
  const assistant = new agent.AssistantMessageComponent(message, hiddenThinking, agent.getMarkdownTheme(), "", 1, [extension.markdownTransformer]);
  const tools = content.filter(part => part.type === "toolCall").map(call => {
    const item = component(call.name, call.arguments, undefined, { callId: call.id, showImages });
    item.updateResult(goodResult(), false);
    return item;
  });
  return { message, assistant, tools, items: [assistant, ...tools] };
}
function visibleGaps(items, width = 80) {
  const rows = transcript(items, width).map(tui.stripTerminalSequences);
  const positions = rows.flatMap((row, index) => row.trim() ? [index] : []);
  return positions.slice(1).map((position, index) => position - positions[index] - 1);
}
const narration = text => ({ type: "text", text: `*${text}*` });
const thought = { type: "thinking", thinking: "SYNTHETIC_THINKING" };

test("normal stages distinguish intra-node and stage gaps while larger native gaps remain", async () => {
  for (const hidden of [true, false]) {
    hiddenThinking = hidden;
    await transformerSetup();
    const stages = [];
    for (let index = 0; index < 12; index++) {
      stages.push(await stage([
        ...(index % 2 ? [thought] : []), narration(`阶段${index}`), ...assistantCalls([`uniform-${index}`]).content,
      ]));
    }
    const before = JSON.stringify(stages.map(s => s.message));
    for (const width of [32, 80, 140]) {
      const items = stages.flatMap(s => s.items);
      assert.deepEqual(visibleGaps(items, width), Array.from({ length: 23 }, (_, i) => i % 2 === 0 ? INTRA_GAP : hidden && i % 4 === 1 ? 3 : 2));
      assert.equal(transcript(items, width).length, (hidden ? 53 : 47) + 12 * INTRA_GAP); // Same 24 visible lines; native three-row prefixes are retained.
      assert.ok(transcript(items, width).every(row => tui.visibleWidth(row) <= width));
    }
    assert.equal(JSON.stringify(stages.map(s => s.message)), before);
  }
  hiddenThinking = true;
});

test("thinking-only stages and merged pure-tool batches target two rows, including final prose", async () => {
  hiddenThinking = false;
  await transformerSetup();
  const a = await stage(assistantCalls(["compact-a", "compact-b"]).content);
  await observe({ role: "toolResult", toolCallId: "compact-b" }, "message_start");
  const b = await stage(assistantCalls(["compact-c"]).content);
  const c = await stage([thought, ...assistantCalls(["compact-d"]).content]);
  const final = await stage([{ type: "text", text: "最终结论正常显示。" }], { stopReason: "stop" });
  const items = [...a.items, ...b.items, ...c.items, ...final.items];
  assert.deepEqual(visibleGaps(items), [INTRA_GAP, INTRA_GAP, 2, 2]);
  assert.equal(items.flatMap(item => item.render(80)).map(tui.stripTerminalSequences).filter(row => /compact-/.test(row)).length, 4);
  hiddenThinking = true;
});

test("streaming snapshots update padding without accumulating rows or reserving an empty tail", async () => {
  await transformerSetup();
  const a = await stage(assistantCalls(["stream-gap"]).content);
  assert.equal(a.tools[0].render(80).length, 2);
  await observe({ role: "assistant", content: [] }, "message_start");
  const next = { role: "assistant", content: [narration("下一阶段")], stopReason: "toolUse" };
  for (let i = 0; i < 10; i++) await observe(next);
  assert.equal(a.tools[0].render(80).length, 3);
  const withThinking = { ...next, content: [thought, thought, ...next.content] };
  for (let i = 0; i < 10; i++) await observe(withThinking);
  assert.equal(a.tools[0].render(80).length, 2); // Native three rows: no compensation.
  await observe(withThinking, "message_end");
  assert.equal(a.tools[0].render(80).length, 2);
});

test("expansion, errors and image permission retain native details without compensation", async () => {
  await transformerSetup();
  const a = await stage(assistantCalls(["expand-gap-a", "expand-gap-b"]).content);
  const b = await stage([narration("下一阶段"), ...assistantCalls(["expand-gap-c"]).content]);
  a.tools[1].updateResult({ content: [{ type: "text", text: "ORIGINAL_FAILURE" }], isError: true }, false);
  const original = transcript([...a.items, ...b.items]).map(tui.stripTerminalSequences).join("\n");
  assert.match(original, /expand-gap-b.*error/);
  assert.deepEqual(visibleGaps([...a.items, ...b.items]), [INTRA_GAP, 2, INTRA_GAP]);
  a.tools[1].setExpanded(true);
  assert.match(lines(a.tools[1]), /ORIGINAL_FAILURE/);
  assert.equal(a.tools[0].render(80).length, 2);
  a.tools[1].setExpanded(false);
  assert.equal(transcript([...a.items, ...b.items]).map(tui.stripTerminalSequences).join("\n"), original);
  a.tools.forEach(item => item.setShowImages(true));
  assert.equal(transcript(a.tools).length, 4 + INTRA_GAP); // Permission alone does not disable text spacing.
  a.tools.forEach(item => item.setShowImages(false));
  assert.equal(transcript([...a.items, ...b.items]).map(tui.stripTerminalSequences).join("\n"), original);
});

test("large native gaps are not inflated globally and user boundaries stop compensation", async () => {
  await transformerSetup();
  const a = await stage(assistantCalls(["large-gap-a"]).content);
  const empty = await stage([thought]);
  const b = await stage([thought, narration("已有大间距"), ...assistantCalls(["large-gap-b"]).content]);
  const c = await stage([narration("普通间距"), ...assistantCalls(["large-gap-c"]).content]);
  assert.deepEqual(visibleGaps([...a.items, ...empty.items, ...b.items, ...c.items]), [5, INTRA_GAP, 2, INTRA_GAP]);
  await observe({ role: "user", content: "新任务" }, "message_start");
  const d = await stage([narration("新任务说明"), ...assistantCalls(["large-gap-d"]).content]);
  assert.equal(c.tools[0].render(80).length, 1 + INTRA_GAP); // Only its explanation-to-tool top-up remains.
  assert.equal(d.tools[0].render(80).length, 1 + INTRA_GAP);
});

test("unsupported interleaving and assistant errors keep native gaps", async () => {
  for (const stopReason of ["error", "aborted", "length", "toolUse"]) {
    await transformerSetup();
    const a = await stage(assistantCalls([`unsupported-${stopReason}`]).content);
    await stage([...assistantCalls([`later-${stopReason}`]).content, narration("工具之后的文字")], { stopReason });
    const rows = a.tools[0].render(80).map(tui.stripTerminalSequences);
    assert.equal(rows.filter(row => !row.trim()).length, 1 + INTRA_GAP); // Native leading spacer + internal gap, no boundary top-up.
    assert.equal(rows.filter(row => row.trim()).length, 2); // Existing pure-tool merge keeps both real calls.
    if (stopReason !== "toolUse") {
      await transformerSetup();
      const first = await stage(assistantCalls([`error-prefix-${stopReason}`]).content);
      await stage([narration("异常结束")], { stopReason });
      assert.equal(first.tools[0].render(80).length, 2);
    }
  }
});

test("spacing survives session restore, tree and compaction without changing branch records", async () => {
  await transformerSetup();
  const a = await stage([narration("开始"), ...assistantCalls(["saved-gap-a"]).content]);
  const b = await stage([narration("继续"), ...assistantCalls(["saved-gap-b"]).content]);
  const branch = [a, b].map(s => ({ type: "message", message: s.message }));
  const before = JSON.stringify(branch);
  for (const event of ["session_start", "session_tree", "session_compact"]) {
    const ctx = { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { theme, setToolsExpanded() {}, setHiddenThinkingLabel() {} } };
    await extension.handlers.get(event)[0]({}, ctx);
    const items = [a, b].flatMap(s => {
      const call = s.message.content.find(p => p.type === "toolCall");
      const tool = component("read", call.arguments, undefined, { callId: call.id });
      tool.updateResult(goodResult(), false);
      return [s.assistant, tool];
    });
    assert.deepEqual(visibleGaps(items), [INTRA_GAP, 2, INTRA_GAP]);
  }
  assert.equal(JSON.stringify(branch), before);
});

test("codemode nested rows also have two blank rows without losing calls or status", async () => {
  await transformerSetup();
  const a = await stage([{ type: "toolCall", id: "gap-codemode", name: "codemode", arguments: { code: "synthetic" } }]);
  a.tools[0].updateResult({ content: [], details: { calls: [
    { name: "read", args: "nested-one.md", status: "ok" },
    { name: "bash", args: "synthetic", status: "cancelled" },
  ] } }, false);
  const b = await stage([narration("核对结果"), ...assistantCalls(["gap-after-codemode"]).content]);
  assert.deepEqual(visibleGaps([...a.items, ...b.items]), [INTRA_GAP, INTRA_GAP, 2, INTRA_GAP]);
  assert.match(lines(a.tools[0]), /cancelled/);
});

test("one explanation with several commands uses intra-node gaps with images allowed or disabled", async () => {
  for (const showImages of [true, false]) {
    await transformerSetup();
    const sample = await stage([narration("检查配置"), ...assistantCalls(["two-a", "two-b", "two-c"]).content], { showImages });
    const before = JSON.stringify(sample.message);
    for (const width of [32, 80, 140]) {
      assert.deepEqual(visibleGaps(sample.items, width), [INTRA_GAP, INTRA_GAP, INTRA_GAP]);
      assert.equal(transcript(sample.items, width).length, 5 + 3 * INTRA_GAP);
      assert.ok(transcript(sample.items, width).every(row => tui.visibleWidth(row) <= width));
    }
    for (const tool of sample.tools) tool.setExpanded(true);
    assert.equal(transcript(sample.items).map(tui.stripTerminalSequences).join("\n").split("original-line-119").length - 1, 3);
    for (const tool of sample.tools) tool.setExpanded(false);
    assert.deepEqual(visibleGaps(sample.items), [INTRA_GAP, INTRA_GAP, INTRA_GAP]);
    assert.equal(JSON.stringify(sample.message), before);
  }
});

test("separate explanation responses and thinking after text account for existing blank rows", async () => {
  for (const hidden of [true, false]) {
    hiddenThinking = hidden;
    await transformerSetup();
    const explanation = await stage([narration("开始检查")]);
    const calls = await stage(assistantCalls(["separate-explanation"]).content);
    assert.deepEqual(visibleGaps([...explanation.items, ...calls.items]), [INTRA_GAP]);
    await transformerSetup();
    const sample = await stage([narration("继续检查"), thought, ...assistantCalls(["trailing-thought"]).content]);
    assert.deepEqual(visibleGaps(sample.items), [Math.max(INTRA_GAP, hidden ? 2 : 1)]); // Never remove native hidden-thinking space.
  }
  hiddenThinking = true;
});

test("streaming explanation-to-tool padding is stable through repeated tool snapshots", async () => {
  await transformerSetup();
  await observe({ role: "assistant", content: [] }, "message_start");
  const message = { role: "assistant", content: [narration("流式说明"), ...assistantCalls(["stream-two"]).content], stopReason: "toolUse" };
  await observe(message);
  const tool = component("read", { path: "stream-two.md" }, undefined, { callId: "stream-two" });
  const assistant = new agent.AssistantMessageComponent(message, true, agent.getMarkdownTheme(), "", 1, [extension.markdownTransformer]);
  for (let index = 0; index < 20; index++) await observe(structuredClone(message));
  assert.deepEqual(visibleGaps([assistant, tool]), [INTRA_GAP]);
  tool.updateResult(goodResult(), false);
  await observe(message, "message_end");
  assert.deepEqual(visibleGaps([assistant, tool]), [INTRA_GAP]);
  assert.equal(tool.render(80).length, 1 + INTRA_GAP); // Native spacer + any top-up + summary; no empty tail.
});

test("actual image results disable group compensation without disabling text-only permission", async () => {
  await transformerSetup();
  const sample = await stage([narration("读取图片"), ...assistantCalls(["real-image-a", "real-image-b"]).content], { showImages: true });
  assert.deepEqual(visibleGaps(sample.items), [INTRA_GAP, INTRA_GAP]);
  // Empty image data avoids terminal protocol output here; the image block still marks an image-bearing result.
  sample.tools[0].updateResult({ content: [{ type: "image", mimeType: "image/png", data: "" }] }, false);
  assert.deepEqual(visibleGaps(sample.items), [1, 1]);
  sample.tools[0].setShowImages(false);
  assert.deepEqual(visibleGaps(sample.items), [INTRA_GAP, INTRA_GAP]);
});

test("two-line spacing survives restore and a subsequent live response with image permission", async () => {
  await transformerSetup();
  const first = await stage([narration("第一步"), ...assistantCalls(["live-after-restore-a", "live-after-restore-b"]).content], { showImages: true });
  const branch = [{ type: "message", message: first.message }];
  await extension.handlers.get("session_tree")[0]({}, { sessionManager: { getBranch: () => branch } });
  const oldTools = first.message.content.filter(part => part.type === "toolCall").map(call => {
    const tool = component("read", call.arguments, undefined, { callId: call.id, showImages: true });
    tool.updateResult(goodResult(), false);
    return tool;
  });
  const next = await stage([narration("下一步"), ...assistantCalls(["live-after-restore-c"]).content], { showImages: true });
  assert.deepEqual(visibleGaps([first.assistant, ...oldTools, ...next.items]), [INTRA_GAP, INTRA_GAP, 2, INTRA_GAP]);
});

test("codemode text results retain two-line nested gaps with image permission enabled", async () => {
  await transformerSetup();
  const sample = await stage([{ type: "toolCall", id: "nested-permission", name: "codemode", arguments: { code: "synthetic" } }], { showImages: true });
  sample.tools[0].updateResult({ content: [], details: { calls: [
    { name: "read", args: "sample.md", status: "ok" }, { name: "bash", args: "synthetic", status: "error" },
  ] } }, false);
  assert.deepEqual(visibleGaps(sample.items), [INTRA_GAP, INTRA_GAP]);
  assert.match(lines(sample.tools[0]), /failed/);
});

test("status identifies the trial version and its limits", async () => {
  const notices = [];
  await extension.commands.get("progress").handler("status", { mode: "tui", ui: { notify: text => notices.push(text) } });
  assert.match(notices.join("\n"), /0\.10\.0/);
  assert.match(notices.join("\n"), /成功不显示/);
  assert.match(notices.join("\n"), /相对路径/);
  assert.match(notices.join("\n"), /2 行/);
  assert.ok(notices[0].includes(`G+H+I+J${INTRA_GAP === 1 ? "+K" : ""}${ENABLE_DITTO ? "+L" : ""}`));
  assert.ok(notices.join("\n").includes(`以 ${INTRA_GAP} 行空白`));
  assert.match(notices.join("\n"), /中文与工具目标均不加粗/);
  assert.match(notices.join("\n"), /宽度的一半/);
  assert.match(notices.join("\n"), /右缘元信息栏/);
  assert.match(notices.join("\n"), /重复片段省略/);
  assert.match(notices.join("\n"), /实际观感待用户验收/);
});

test("visible thinking is filtered through the public transformer without altering history", async () => {
  const transform = await transformerSetup();
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "Current profile TEST is in use. NATIVE_ENGLISH_SENTINEL" },
    { type: "text", text: "*正在读取演示文件。*" },
  ], stopReason: "stop" };
  const before = JSON.stringify(message);
  for (const hidden of [false, true]) {
    const item = new agent.AssistantMessageComponent(message, hidden, agent.getMarkdownTheme(), "", 1, [transform]);
    const rows = item.render(80);
    assert.doesNotMatch(rows.map(tui.stripTerminalSequences).join("\n"), /Current profile|NATIVE_ENGLISH_SENTINEL/);
    assert.match(rows.map(tui.stripTerminalSequences).join("\n"), /正在读取演示文件/);
    assert.ok(rows.some(line => line.includes("▎")));
  }
  assert.equal(JSON.stringify(message), before);
});
test("narration uses a guide and clause contrast while final prose stays unchanged", async () => {
  const transform = await transformerSetup();
  const context = { messageType: "assistant", isStreaming: false, availableWidth: 80 };
  const source = "*先读取项目规则，确认修改位置。*\n\n最终结论正常显示。";
  const styled = transform(source, context);
  assert.equal(tui.stripTerminalSequences(styled), "▎ 先读取项目规则，确认修改位置。\n\n最终结论正常显示。");
  assert.ok(styled.includes("\x1b[38;2;232;236;234m"));
  assert.ok(styled.includes("\x1b[38;2;142;153;156m"));
  for (const width of [32, 80]) {
    const rendered = new tui.Markdown(styled, 1, 0, agent.getMarkdownTheme()).render(width);
    assert.ok(rendered.some(line => line.includes("▎")));
    assert.ok(rendered.filter(line => line.includes("最终结论")).every(line => !line.includes("\x1b[3m")));
    assert.ok(rendered.every(line => tui.visibleWidth(line) <= width));
  }
});

test("narration excludes other message types, code, inline emphasis and incomplete streaming", async () => {
  const transform = await transformerSetup();
  for (const messageType of ["user"]) {
    const source = "*不要修改这一段。*";
    assert.equal(transform(source, { messageType, isStreaming: false, availableWidth: 80 }), source);
  }
  const context = { messageType: "assistant", isStreaming: true, availableWidth: 80 };
  for (const source of ["普通结论。", "句中的 *强调* 保留。", "*未完成的说明", "```md\n\n*代码块中的说明。*\n\n```", "~~~\n\n*代码块中的说明。*\n\n~~~", "    *缩进代码。*", "<!--\n\n*注释内容。*\n\n-->", "*第一行*\n第二行", "*包含 [链接](url) 的段落*"]) {
    assert.equal(transform(source, context), source);
  }
  assert.ok(transform("*流式已完整的说明。*", context).includes("▎"));
  assert.equal(transform("ENGLISH_NATIVE_THINKING", { ...context, messageType: "assistant-thinking" }), "");
});

test("guidelines deduplicate, leave system content intact, and add no tools or history records", async () => {
  const hook = extension.handlers.get("before_agent_start")[0];
  const event = { systemPrompt: "ORIGINAL", systemPromptOptions: { promptGuidelines: ["existing rule"], sections: { existing: "intact" } } };
  await hook(event, { mode: "tui" });
  const once = [...event.systemPromptOptions.promptGuidelines];
  await hook(event, { mode: "tui" });
  assert.deepEqual(event.systemPromptOptions.promptGuidelines, once);
  assert.equal(once.length, 4);
  assert.match(once.join("\n"), /最终答复正常排版/);
  assert.equal(event.systemPrompt, "ORIGINAL");
  assert.deepEqual(event.systemPromptOptions.sections, { existing: "intact" });
  assert.equal(extension.tools.size, 0);
  assert.deepEqual([...extension.commands.keys()], ["progress"]);
  assert.deepEqual([...extension.handlers.keys()].sort(), ["before_agent_start", "message_end", "message_start", "message_update", "session_compact", "session_shutdown", "session_start", "session_tree"]);
});

test("session setup is terminal-only and shutdown restores the thinking label", async () => {
  const actions = [];
  const ctx = { mode: "tui", sessionManager: { getBranch: () => [] }, ui: { theme, setToolsExpanded: value => actions.push(["expanded", value]), setHiddenThinkingLabel: value => actions.push(["thinking", value]), notify: value => actions.push(["status", value]) } };
  await extension.handlers.get("session_start")[0]({}, ctx);
  await extension.handlers.get("session_shutdown")[0]({}, ctx);
  assert.deepEqual(actions, [["expanded", false], ["thinking", ""], ["thinking", undefined]]);
  await extension.handlers.get("session_start")[0]({}, { mode: "rpc", sessionManager: { getBranch: () => [] } });
});

test("C layout shows the six HTML sample targets in order without changing arguments", async () => {
  const script = 'import json\nfrom pathlib import Path\nfor p in Path("sessions").glob("*.jsonl"):\n    print(p.name)';
  const examples = [
    ["read", { path: "docs/reference/session-management-guide.md", offset: 1, limit: 120 }, "docs/reference/session-management-guide.md:1-120", 1],
    ["bash", { command: 'rg -n "sessionName|displayName" src/interactive/session-management/session.ts' }, "src/interactive/session-management/session.ts", 2],
    ["write", { path: "scratch/analyze.py", content: "PRIVATE_BODY" }, "scratch/analyze.py", 1],
    ["bash", { command: `python -c '${script}'` }, "sessions/*.jsonl", 2],
    ["read", { path: "scratch/digest.txt", offset: 1, limit: 100 }, "scratch/digest.txt:1-100", 1],
    ["bash", { command: "node --test test/render.test.mjs" }, "test/render.test.mjs", 2],
  ];
  for (const [name, args, target, height] of examples) {
    const before = JSON.stringify(args);
    const item = component(name, args);
    item.updateResult(goodResult(), false);
    const rows = item.render(180).map(tui.stripTerminalSequences).filter(line => line.trim());
    assert.equal(rows.length, height, name + ":" + target);
    assert.ok(rows[0].trimStart().startsWith(target));
    assert.ok(rows[0].trimEnd().endsWith(name));
    if (height === 2) assert.ok(rows[1].trimStart().startsWith("└ "));
    assert.doesNotMatch(rows.join("\n"), /PRIVATE_BODY|original-line/);
    item.setExpanded(true);
    assert.ok(lines(item, 240).includes(name));
    item.setExpanded(false);
    assert.equal(JSON.stringify(args), before);
  }
});

test("literal target extraction consumes option values and rejects ambiguous commands", () => {
  const known = component("powershell", { command: 'Get-Content -LiteralPath "docs/a.md" -TotalCount 20' });
  const knownRows = lines(known).split("\n").filter(line => line.trim());
  assert.match(knownRows[0], /docs\/a\.md.*powershell/);
  assert.doesNotMatch(knownRows[0], /20|TotalCount/);
  for (const command of ['rg -n -g "*.ts" -e "a|b" src', 'grep -n "a|b" src/a.ts']) {
    const row = lines(component("bash", { command })).split("\n").filter(line => line.trim())[0];
    assert.ok(row.trimStart().startsWith("src"));
    assert.doesNotMatch(row, /\*\.ts/);
  }
  for (const command of ['rg --unknown value pattern src', 'cat a.md && cat b.md', 'Get-Content $env:PRIVATE', 'node -e "read(\"a.md\")"', 'python -c "files = compute_paths()"']) {
    const item = component("bash", { command });
    assert.ok(item.render(160).filter(line => tui.stripTerminalSequences(line).trim()).length <= 2, command);
    assert.doesNotMatch(lines(item, 160), /多步|内联脚本|→/);
    assert.ok(item.render(160).every(row => tui.visibleWidth(tui.stripTerminalSequences(row).trimEnd()) <= 80));
  }
});

test("two-line commands retain explicit states, narrow widths and native details", () => {
  const args = { command: 'rg -n "demo|test" src/very/long/folder/file.ts' };
  const result = { content: [{ type: "text", text: "PRIVATE_RESULT" }], isError: true };
  const before = JSON.stringify({ args, result });
  const item = component("bash", args);
  for (const state of ["pending", "running", "error"]) {
    if (state === "running") item.markExecutionStarted();
    if (state === "error") item.updateResult(result, false);
    for (const width of [16, 32, 80, 180]) {
      assert.ok(item.render(width).every(row => tui.visibleWidth(row) <= width));
      if (width >= 24) assert.match(lines(item, width), new RegExp(`\\[${state}\\]`));
      assert.doesNotMatch(lines(item, width), /PRIVATE_RESULT/);
    }
  }
  item.setExpanded(true);
  assert.match(lines(item), /PRIVATE_RESULT/);
  item.setExpanded(false);
  assert.equal(JSON.stringify({ args, result }), before);
});

test("commented glob examples are not targets and test commands retain multiple operands", () => {
  for (const command of [`python -c '# Path("private").glob("*.jsonl")'`, `python -c 'cat imaginary.md'`]) {
    const rows = component("bash", { command }).render(160).map(tui.stripTerminalSequences).filter(row => row.trim());
    assert.equal(rows.length, 1);
    assert.doesNotMatch(rows[0], /内联脚本/);
    assert.doesNotMatch(rows[0], /private/);
    assert.ok(!component("bash", { command }).render(160).join("\n").includes(fileText("imaginary.md")));
  }
  const item = component("bash", { command: "node --test test/one.mjs test/two.mjs" });
  const row = lines(item).split("\n").filter(line => line.trim())[0];
  assert.match(row, /test\/one.mjs, test\/two.mjs\s+bash/);
  const args = { command: "cat src/\x1b[2Jfile.md" };
  const controlled = component("bash", args);
  assert.ok(controlled.render(120).every(row => !row.includes("\x1b[2J")));
  assert.match(lines(controlled), /src\/file.md/);
  assert.equal(args.command, "cat src/\x1b[2Jfile.md");
});

test("S1+S2 wraps at the available width with hanging continuation and no source loss", async () => {
  const transform = await transformerSetup();
  const raw = "先检查 sessionName 与 displayName；再核对来源和很长的目录标识，确认这些字段只影响显示，并继续检查返回结果以及最终说明。";
  for (const width of [16, 32, 80, 180]) {
    const context = { messageType: "assistant", isStreaming: false, availableWidth: width - 2 };
    const source = `*${raw}*`;
    const item = new tui.Markdown(source, 1, 0, agent.getMarkdownTheme(), undefined, { transform: value => transform(value, context) });
    const rows = item.render(width).map(tui.stripTerminalSequences).filter(line => line.trim());
    assert.equal(rows.filter(line => line.includes("▎")).length, rows.length);
    assert.ok(rows[0].trimStart().startsWith("▎ "));
    assert.ok(rows.slice(1).every(line => line.trimStart().startsWith("▎ ")));
    assert.ok(rows.every(line => tui.visibleWidth(line.trimEnd()) <= Math.min(width, 72)));
    assert.equal(rows.join("").replace(/[\s▎│]/g, ""), raw.replace(/\s/g, ""));
    assert.equal(source, `*${raw}*`);
  }
});

test("S1+S2 handles inline identifiers and theme changes without styling final prose", async () => {
  const transform = await transformerSetup();
  for (const name of ["dark", "light"]) {
    agent.initTheme(name, false);
    const source = "*先检查 `session_name`，再核对结果。*\n\n**最终结论**：保留普通格式。";
    const item = new tui.Markdown(source, 1, 0, agent.getMarkdownTheme(), undefined, { transform: value => transform(value, { messageType: "assistant", availableWidth: 78, isStreaming: false }) });
    const rows = item.render(80);
    const plain = rows.map(tui.stripTerminalSequences).join("\n");
    assert.match(plain, /▎ 先检查 session_name，再核对结果。/);
    assert.doesNotMatch(plain, /\\_|`/);
    assert.match(plain, /最终结论：保留普通格式。/);
    assert.ok(rows.filter(row => row.includes("最终结论")).every(row => !row.includes("▎") && !row.includes("38;2;232;236;234")));
  }
  agent.initTheme("dark", false);
});

test("two-line commands keep configured gaps between calls in long and restored stages", async () => {
  await resetGroups();
  const ids = Array.from({ length: 30 }, (_, i) => `two-row-${i}`);
  const message = { role: "assistant", content: ids.map(id => ({ type: "toolCall", id, name: "bash", arguments: { command: `node --test test/${id}.mjs` } })) };
  const before = JSON.stringify(message);
  for (const restored of [false, true]) {
    if (restored) await extension.handlers.get("session_tree")[0]({}, { sessionManager: { getBranch: () => [{ type: "message", message }] } });
    else await extension.handlers.get("message_end")[0]({ message });
    const tools = ids.map(id => component("bash", { command: `node --test test/${id}.mjs` }, undefined, { callId: id }));
    const rows = transcript(tools, 80).map(tui.stripTerminalSequences);
    assert.equal(rows.filter(row => row.trim()).length, 60);
    assert.equal(rows.length, 61 + 29 * INTRA_GAP);
    assert.deepEqual(rows.filter(row => /mjs\s+bash/.test(row)).map(row => row.match(/two-row-\d+/)[0]), ids);
    let run = 0, maximum = 0;
    for (const row of rows) { run = row.trim() ? 0 : run + 1; maximum = Math.max(maximum, run); }
    assert.equal(maximum, INTRA_GAP);
  }
  assert.equal(JSON.stringify(message), before);
});

function summaryRows(item, width) {
  return item.render(width).map(tui.stripTerminalSequences).map(row => row.trimEnd()).filter(Boolean);
}
function assertHalf(item, width) {
  for (const row of summaryRows(item, width)) assert.ok(tui.visibleWidth(row) <= Math.floor(width / 2), `${width}: ${row}`);
}
const systemCommands = [
  ["scheduled", `powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'Start PowerShell On Logon', '*SoftLanding*' | Select-Object TaskName, @{N='Action';E={$_.Actions.Execute}} | Format-List"`, /Start PowerShell On Logon/, /Get-ScheduledTask/],
  ["foreach", `Get-ScheduledTask -TaskName '*SoftLanding*' | ForEach-Object { $_.Actions | Select-Object Execute }`, /SoftLanding/, /ForEach-Object/],
  ["member", `(Get-ScheduledTask -TaskName 'SoftLandingCreativeManagementTask').Actions | Format-List`, /SoftLandingCreativeManagementTask/, /Get-ScheduledTask/],
  ["registry", `Get-ItemProperty -Path 'Registry::HKEY_CLASSES_ROOT\\CLSID\\{F576B2F9-7850-4226-ADB0-E5993FED4F02}\\InProcServer32' -ErrorAction SilentlyContinue | Format-List`, /HKCR.*InProcServer32/, /Get-ItemProperty/],
  ["registry-filter", `Get-ChildItem -Path 'Registry::HKEY_CLASSES_ROOT\\CLSID' -Recurse -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -eq '{DEMO-GUID}' } | ForEach-Object { $_.Name }`, /HKCR.*CLSID/, /Get-ChildItem.*Recurse/],
  ["environment", `Get-ChildItem -Path $env:LOCALAPPDATA, $env:APPDATA -Filter '*SoftLanding*' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object FullName`, /LOCALAPPDATA.*APPDATA/, /Get-ChildItem.*SoftLanding.*Recurse.*Depth 2/],
  ["memory", `Get-CimInstance Win32_PhysicalMemory | Select-Object DeviceLocator, Manufacturer, PartNumber, Capacity, @{N='SizeGB';E={$_.Capacity/1GB}}, Speed, ConfiguredClockSpeed | Format-Table`, /Win32_PhysicalMemory/, /Get-CimInstance/],
  ["battery", `Get-CimInstance -Namespace root\\wmi -ClassName BatteryStaticData -ErrorAction SilentlyContinue | Select-Object DesignedCapacity | Format-List`, /BatteryStaticData/, /Get-CimInstance.*Namespace root\\wmi/],
];

test("collapsed content stays before the midpoint at every pad, width and state", () => {
  const samples = [
    ["read", { path: "src/目录/😀/特别长的文件名.ts", offset: 3, limit: 20 }],
    ["edit", { path: "src/config.ts", oldText: "PRIVATE_OLD", newText: "PRIVATE_NEW" }],
    ["grep", { path: "src/a.ts", pattern: "something|".repeat(30) }],
    ["bash", { command: 'rg -n "sessionName|displayName" src/interactive/session-management/session.ts' }],
    ["powershell", { command: systemCommands[5][1] }],
    ["bash", { command: `unknown-tool --option ${"long-value".repeat(60)}` }],
    ["mcp_resource", { url: `https://example.test/${"long/".repeat(40)}`, query: "查询".repeat(100) }],
  ];
  for (const outputPad of [0, 1, 3]) for (const [name, args] of samples) {
    const item = component(name, args, undefined, { outputPad });
    const original = JSON.stringify(args);
    for (const state of ["pending", "running", "done", "error"]) {
      if (state === "running") item.markExecutionStarted();
      if (["done", "error"].includes(state)) item.updateResult({ content: [{ type: "text", text: "PRIVATE_RESULT" }], isError: state === "error" }, false);
      for (const width of [16, 24, 32, 55, 80, 131, 132, 200, 320]) {
        assertHalf(item, width);
        assert.ok(summaryRows(item, width).length <= 2);
        if (width >= 32 && state !== "done") assert.match(lines(item, width), new RegExp(`\\[${state}\\]`));
        assert.doesNotMatch(lines(item, width), /PRIVATE_/);
      }
    }
    assert.equal(JSON.stringify(args), original);
  }
});

test("simple files and routine short commands use one content row", () => {
  for (const [name, args] of [
    ["read", { path: "README.md" }], ["edit", { path: "index.ts" }], ["write", { path: "report.md" }], ["ls", { path: "src" }],
    ...["git status --short", "npm test", "cat README.md", "ls src", "python scripts/check.py", "Get-Process"].map(command => ["bash", { command }]),
  ]) {
    const item = component(name, args);
    item.updateResult(goodResult(), false);
    assert.equal(summaryRows(item, 132).length, 1, JSON.stringify(args));
    assertHalf(item, 132);
  }
});

test("search separates the scope from its expression and important options", () => {
  const command = 'rg -n -g "*.ts" -e "sessionName|displayName" src';
  const item = component("bash", { command });
  item.updateResult(goodResult(), false);
  const rows = summaryRows(item, 132);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /src.*bash/);
  assert.match(rows[1], /rg.*-n.*\*\.ts.*sessionName\|displayName/);
  assertHalf(item, 132);
});

test("the screenshot's system queries expose objects and operations without full pipelines", () => {
  for (const [id, command, targetPattern, operationPattern] of systemCommands) {
    const item = component("powershell", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 240);
    assert.equal(rows.length, 2, id);
    assert.match(rows[0], targetPattern, id);
    assert.match(rows[1], operationPattern, id);
    assert.doesNotMatch(rows.join("\n"), /SilentlyContinue|Format-List|Format-Table|N='SizeGB'|N='Action'/);
    if (id === "registry") assert.match(summaryRows(item, 132)[0], /InProcServer32/);
    if (id === "registry-filter") assert.match(summaryRows(item, 132)[1], /PSChildName -eq '\{DEMO-GUID\}'/);
    for (const width of [80, 132, 200, 240]) assertHalf(item, width);
  }
});

test("recursive and force switches remain visible after a long duplicated target is omitted", () => {
  const command = `Copy-Item -LiteralPath '${"long/".repeat(15)}source.txt' -Destination 'archive/output.txt' -Recurse -Force:$false`;
  const item = component("powershell", { command });
  item.updateResult(goodResult(), false);
  const rows = summaryRows(item, 132);
  assert.match(rows[0], /source.txt\s+\+1/);
  item.setExpanded(true);
  assert.match(lines(item, 320), /archive\/output.txt/);
  item.setExpanded(false);
  assert.match(rows[1], /Copy-Item.*-Recurse.*-Force:\$false/);
  assert.doesNotMatch(rows[1], /long\/long/);
  assertHalf(item, 132);
});

test("write bodies, network payloads, authentication values and encoded scripts stay hidden", () => {
  for (const command of [
    `Set-Content -Path 'report.txt' -Value 'PRIVATE_WRITE_BODY' -Force`,
    `curl -X POST -H 'Authorization: PRIVATE_TOKEN' -d 'PRIVATE_BODY' https://example.test/api`,
    `pwsh -EncodedCommand PRIVATE_ENCODED_SCRIPT`,
    `node -e 'const hidden = "PRIVATE_SCRIPT_BODY";'`,
    `python -c 'print("PRIVATE_SCRIPT_BODY")'`,
    `curl --data=PRIVATE_BODY --request=POST https://example.test/api`,
  ]) {
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    assert.doesNotMatch(lines(item, 200), /PRIVATE_/);
    item.setExpanded(true);
    assert.match(lines(item, 240), /PRIVATE_/);
    item.setExpanded(false);
    assertHalf(item, 80);
  }
});

test("compound commands keep meaningful later actions and may collapse redundant continuations", () => {
  for (const command of [
    "cat a.md && cat b.md",
    "Get-Process -Name demo | Stop-Process -Force",
    "Get-Content a.md; Remove-Item b.md -Force",
    "git status --short && git reset --hard",
    "mystery --first foo; PRIVATE_LATER_LINE",
    "python -c 'print(1)' && rm temporary.txt",
    "pwsh -Command 'Get-Process -Name demo' && git status --short",
  ]) {
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 200);
    assert.ok(rows.length === 1 || rows.length === 2, command);
    assert.doesNotMatch(rows.join("\n"), /多步|内联脚本|→/);
    assert.doesNotMatch(rows.join("\n"), /PRIVATE_LATER_LINE/);
    if (rows.length === 2) {
      assert.ok(rows[1].trimStart().startsWith("└ "), command);
      assert.match(rows[1], /…$|Stop-Process -Force/, command);
    }
    if (/Stop-Process/.test(command)) assert.match(rows[1], /Stop-Process -Force/);
    if (/cat b/.test(command)) assert.match(rows[0], /a.md, b.md/);
    if (/git reset/.test(command)) {
      assert.equal(rows.length, 1, command);
      item.setExpanded(true);
      assert.match(lines(item, 240), /git reset --hard/);
      item.setExpanded(false);
    }
    if (/mystery/.test(command)) assert.equal(rows.length, 1, command);
    if (/python -c/.test(command) && rows[1]) assert.match(rows[1], /&& …/);
    assertHalf(item, 80);
  }
});

test("Git, package, build and network commands retain useful context", () => {
  for (const [command, primary, secondary] of [
    ["git -C projects/demo diff -- src/app.ts", /src\/app.ts/, /git.*diff/],
    ["git reset --hard", /git reset --hard/, undefined],
    ["npm --prefix projects/demo run build -- --verbose", /projects\/demo/, /npm.*run.*build/],
    ["npm install alpha-package beta-package gamma-package --global", /npm install/, /npm.*--global/],
    ["curl -L --request GET --output report.json https://example.test/api", /https:\/\/example.test\/api/, /curl.*GET.*report.json/],
  ]) {
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 200);
    assert.match(rows[0], primary);
    if (secondary) assert.match(rows[1], secondary);
    assertHalf(item, 132);
  }
});

test("unknown commands and incomplete streaming arguments remain bounded and keep native details", () => {
  const item = component("bash", {});
  for (const command of ["", 'unknown --query "', 'unknown --query "unfinished', 'unknown --query "finished" --output result.txt', "python -c 'for x in files:", "Get-ChildItem -Path @("]) {
    item.updateArgs({ command });
    assertHalf(item, 32);
    assertHalf(item, 132);
    assert.ok(summaryRows(item, 132).length <= 2);
  }
  item.setExpanded(true);
  assert.match(lines(item), /Get-ChildItem/);
});

test("quoted separators, nested expressions and comments do not invent additional calls", () => {
  for (const command of [
    `Get-Process -Name 'a;b|c'`,
    `Get-ChildItem -Path 'src' | Where-Object { $_.Name -eq 'a;b' } | Select-Object Name`,
    `node -e 'console.log("a;b|c")'`,
  ]) {
    const item = component("bash", { command });
    assert.doesNotMatch(summaryRows(item, 200)[0], /多步/);
    assertHalf(item, 80);
  }
});

test("structured extension calls separate their resource from method and query", () => {
  const args = { url: "https://example.test/items", method: "GET", query: "state=open", body: "PRIVATE_BODY" };
  const before = JSON.stringify(args);
  const item = component("mcp_api", args);
  item.updateResult(goodResult(), false);
  const rows = summaryRows(item, 132);
  assert.equal(rows.length, 2);
  assert.match(rows[0], /example.test\/items/);
  assert.match(rows[1], /method=GET.*query=state=open/);
  assert.doesNotMatch(rows.join("\n"), /PRIVATE_BODY/);
  assert.equal(JSON.stringify(args), before);
  assertHalf(item, 80);
});

test("codemode preserves each real nested call and applies the half-width limit to its summaries", () => {
  const args = { code: "await tools.batch();\nPRIVATE_CODE" };
  const calls = [
    { name: "powershell", args: JSON.stringify({ command: systemCommands[5][1] }), status: "ok" },
    { name: "read", args: JSON.stringify({ path: "src/目录/data.txt" }), status: "error", error: "PRIVATE_ERROR" },
    { name: "mcp_demo", args: JSON.stringify({ url: "https://example.test/one", query: "test" }), status: "cancelled" },
  ];
  const result = { content: [{ type: "text", text: "PRIVATE_RESULT" }], details: { calls } };
  const before = JSON.stringify({ args, result });
  const item = component("codemode", args);
  item.updateResult(result, false);
  assert.match(lines(item, 200), /LOCALAPPDATA/);
  assert.match(lines(item, 200), /data.txt.*failed/);
  assert.match(lines(item, 200), /example.test.*cancelled/);
  for (const width of [32, 80, 132, 200]) assertHalf(item, width);
  assert.doesNotMatch(lines(item, 200), /PRIVATE_/);
  item.setExpanded(true);
  assert.match(lines(item, 240), /PRIVATE_CODE/);
  assert.equal(JSON.stringify({ args, result }), before);
});

const nativeExcerptCases = [
  ['hardware', 'powershell -NoProfile -Command "Get-CimInstance Win32_Processor | Select-Object Name, NumberOfCores; Get-CimInstance Win32_PhysicalMemory | Select-Object Capacity, Speed; Get-CimInstance Win32_LogicalDisk; Get-CimInstance Win32_VideoController"', /Win32_Processor, Win32_PhysicalMemory/, /Get-CimInstance.*…$/],
  ['process', 'powershell -Command "$procs = Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10; $procs | Select-Object Id, ProcessName, WorkingSet64"', /Get-Process/, /\$procs = Get-Process/],
  ['registry-assignment', `powershell -Command "$key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'; Get-ItemProperty -Path $key -Name HwSchMode"`, /HKLM.*GraphicsDrivers/, /Get-ItemProperty.*HwSchMode/],
  ['startup', 'powershell -Command "$ErrorActionPreference = \'SilentlyContinue\'; Get-CimInstance Win32_StartupCommand | Select-Object Name, Command"', /Win32_StartupCommand/, /Get-CimInstance/],
  ['services', 'pwsh -c "$items = Get-Service -Name demo-service; $items | Select-Object Name, Status"', /demo-service/, /\$items = Get-Service/],
  ['display', 'powershell -Command "Get-CimInstance Win32_VideoController | Select-Object Name, CurrentRefreshRate"', /Win32_VideoController/, /Get-CimInstance/],
  ['uptime', 'powershell -Command "$t = [Environment]::TickCount64; [TimeSpan]::FromMilliseconds($t) | Select-Object Days, Hours, Minutes"', /\[Environment\]::TickCount64/, /\$t = \[Environment\]::TickCount64/],
  ['loop', 'powershell -Command "for ($i=0; $i -lt 5; $i++) { Start-Sleep -Milliseconds 200; Write-Output $i }"', /for \(\$i=0/, /Start-Sleep -Milliseconds 200/],
];

test('system-scan wrappers expose literal objects and code instead of category labels', () => {
  for (const [id, command, target, excerpt] of nativeExcerptCases) {
    const args={command}; const before=JSON.stringify(args);
    const item=component('bash',args); item.updateResult(goodResult(),false);
    const rows=summaryRows(item,200);
    assert.equal(rows.length,2,id); assert.match(rows[0],target,id); assert.match(rows[1],excerpt,id);
    assert.doesNotMatch(rows.join('\n'),/多步|内联脚本|编码脚本|→|powershell -Command|pwsh -c|ErrorActionPreference/);
    if (id === 'process') assert.match(summaryRows(item,132)[1],/Sort-Object WorkingSet64 -Descending/);
    for (const width of [32,80,132,200]) assertHalf(item,width);
    item.setExpanded(true); assert.match(lines(item,240),/powershell|pwsh/);
    assert.equal(JSON.stringify(args),before);
  }
});

test('multiple query targets retain order and native statement punctuation in one tool', () => {
  const item=component('bash',{command:nativeExcerptCases[0][1]}); item.updateResult(goodResult(),false);
  const wide=summaryRows(item,240);
  assert.match(wide[0],/Win32_Processor, Win32_PhysicalMemory, Win32_LogicalDisk/);
  assert.match(wide[1],/\| Select-Object/); assert.match(wide[1],/…$/); assert.doesNotMatch(wide[1],/;\s*…$/);
  assert.equal((wide[1].match(/Get-CimInstance/g)||[]).length,1);
  assertHalf(item,80); assert.equal(summaryRows(item,80).length,2);
});

test('unknown inline scripts use actual code and keep body literals elided', () => {
  for (const command of [
    `python -c 'answer = compute_metrics("PRIVATE_BODY"); print(answer)'`,
    `node -e 'const result = customQuery("PRIVATE_BODY"); result.send()'`,
    `powershell -Command "$sample = [Math]::Sqrt(144); $sample"`,
    `pwsh -EncodedCommand PRIVATE_ENCODED`,
  ]) {
    const item=component('bash',{command}); item.updateResult(goodResult(),false);
    assert.doesNotMatch(lines(item,200),/PRIVATE_|内联脚本|多步|编码脚本|→/);
    assertHalf(item,80); assertHalf(item,132);
    item.setExpanded(true); assert.match(lines(item,240),/compute_metrics|customQuery|Sqrt|PRIVATE_ENCODED/);
  }
});

test('same real calls may have the same summary and original Chinese remains visible', () => {
  const command='Get-Process -Name demo';
  const first=component('bash',{command});const second=component('bash',{command});
  first.updateResult(goodResult(),false);second.updateResult(goodResult(),false);
  assert.deepEqual(summaryRows(first,132),summaryRows(second,132));
  const search=component('bash',{command:'rg -n "显示名称" src'});search.updateResult(goodResult(),false);
  assert.match(lines(search,132),/显示名称/);assertHalf(search,80);
});

test('red-box command layout retains a complete useful excerpt when it fits', () => {
  const command='rg -n "sessionName|displayName" src/session.ts';
  const item=component('bash',{command});item.updateResult(goodResult(),false);
  const rows=summaryRows(item,132);
  assert.match(rows[0],/src\/session.ts\s+bash/);
  assert.equal(rows[1].trimStart(),"└ " + command);
  assert.ok(item.render(132).some(row=>row.includes(theme.style(command,{fg:tui.parseColor('#7B878A')}))));
  assertHalf(item,80);
});

test('nested wrappers are bounded and shell separators are not reinterpreted', () => {
  const command=`cmd /c "powershell -Command 'Get-Process -Name demo'"`;
  const item=component('bash',{command});item.updateResult(goodResult(),false);
  assert.match(lines(item,132),/demo[\s\S]*Get-Process/);
  assert.doesNotMatch(lines(item,132),/内联脚本|多步|→/);
  const conditional=component('bash',{command:'git status --short && git reset --hard'});conditional.updateResult(goodResult(),false);
  assert.match(lines(conditional,132),/git status --short/);
  assert.doesNotMatch(lines(conditional,132),/; …/);
  conditional.setExpanded(true);
  assert.match(lines(conditional,240),/git reset --hard/);
});

test('literal variable hints expire at intervening code and newlines stay honest', () => {
  const command=`$key = 'HKLM:\\Demo\\Original'; updateDynamicValues; Get-ItemProperty -Path $key -Name Demo`;
  const item=component('powershell',{command});item.updateResult(goodResult(),false);
  assert.doesNotMatch(summaryRows(item,132)[0],/Original/);
  assert.match(summaryRows(item,132)[0],/\$key/);
  const newline=component('powershell',{command:'Get-Process -Name demo\nGet-Service -Name service'});newline.updateResult(goodResult(),false);
  assert.doesNotMatch(lines(newline,132),/; …|→/);
  const comment=component('powershell',{command:'Get-Process # unrelated annotation'});comment.updateResult(goodResult(),false);
  assert.match(summaryRows(comment,132)[0],/Get-Process/);
  assert.doesNotMatch(summaryRows(comment,132)[0],/#|annotation/);
});
test("A aligns the type and state on one right edge for short and long targets", () => {
  for (const width of [80, 132]) {
    const short = component("read", { path: "a.md" });
    short.updateResult(goodResult(), false);
    const long = component("bash", { command: 'rg -n "demo|test" src/very/long/folder/file.ts' });
    long.updateResult(goodResult(), false);
    const shortRows = summaryRows(short, width);
    const longRows = summaryRows(long, width);
    assert.equal(shortRows.length, 1);
    assert.equal(longRows.length, 2);
    assert.equal(tui.visibleWidth(shortRows[0]), Math.floor(width / 2));
    assert.equal(tui.visibleWidth(longRows[0]), Math.floor(width / 2));
    assert.match(shortRows[0], /a\.md.*read$/);
    assert.match(longRows[0], /file\.ts.*bash$/);
  }
  const pending = component("write", { path: "draft.md" });
  assert.match(summaryRows(pending, 132)[0], /draft\.md.*write.*\[pending\]$/);
});

test("C and I use the same rail glyph, no bold, a connector and one trailing ellipsis", async () => {
  const transform = await transformerSetup();
  const raw = "先检查 sessionName 与 displayName；再核对来源和很长的目录标识，确认这些字段只影响显示，并继续检查返回结果以及最终说明。";
  const styled = transform(`*${raw}*`, { messageType: "assistant", availableWidth: 78, isStreaming: false });
  assert.ok(!styled.includes("\x1b[1m"));
  const rows = new tui.Markdown(styled, 1, 0, agent.getMarkdownTheme()).render(80).map(tui.stripTerminalSequences).filter(line => line.trim());
  assert.ok(rows[0].includes("▎"));
  assert.ok(rows.slice(1).every(line => line.trimStart().startsWith("▎ ")));
  const command = component("bash", { command: "Get-Content a.md; Remove-Item b.md -Force" });
  command.updateResult(goodResult(), false);
  const summary = summaryRows(command, 132);
  assert.equal(summary.length, 2);
  assert.ok(summary[1].trimStart().startsWith("└ "));
  assert.match(summary[1], /…$/);
  assert.doesNotMatch(summary[1], /;\s*…$/);
});

test("F omits only redundant second lines and keeps meaningful excerpts", () => {
  for (const command of ['cd "C:/demo" && dir', "where magick 2>/dev/null ; echo ok"]) {
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 132);
    assert.equal(rows.length, 1, command);
    assert.doesNotMatch(rows[0], /└/);
    item.setExpanded(true);
    assert.match(lines(item, 240), /dir|echo ok/, command);
    item.setExpanded(false);
  }
  for (const command of ['powershell -Command "Get-Content report.txt; Get-Process"', 'cd "C:/demo" && rg -n "demo" index.ts']) {
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 200);
    assert.equal(rows.length, 2, command);
    assert.ok(rows[1].trimStart().startsWith("└ "), command);
  }
});

test("G and J layer directory, filename, range and separators without bold or width drift", async () => {
  await resetGroups();
  for (const [name, dir, file, range, sep, meta] of [
    ["dark", "#8E846E", "#C9BA9A", "#6E797C", "#5F696C", "#687478"],
    ["light", "#8C826E", "#756344", "#687377", "#788286", "#667377"],
  ]) {
    agent.initTheme(name, false);
    const item = component("read", { path: "src/config/app.json", offset: 2, limit: 4 });
    item.updateResult(goodResult(), false);
    const row = item.render(132).find(row => row.includes("app.json"));
    for (const [text, color] of [["src/config/", dir], ["app.json", file], [":2-5", range], ["  read", meta]]) {
      assert.ok(row.includes(theme.style(text, { fg: tui.parseColor(color), bold: false })), `${name}: ${text}`);
    }
    assert.equal(tui.stripTerminalSequences(row).trim(), "src/config/app.json:2-5" + " ".repeat(38) + "read");
    assert.equal(tui.visibleWidth(row.trimEnd()), 66);
    assert.doesNotMatch(row, /\x1b\[1m/);
    const multi = component("mcp_files", { paths: ["a.md", "b.md"] });
    multi.updateResult(goodResult(), false);
    assert.ok(multi.render(132).join("\n").includes(theme.style(", ", { fg: tui.parseColor(sep) })));
  }
  agent.initTheme("dark", false);
});

test("H packs whole target items in order with an accurate +N and no partial later item", async () => {
  await resetGroups();
  const targets = ["Win32_Processor", "Win32_PhysicalMemory", "Win32_LogicalDisk", "Win32_VideoController"];
  const args = { command: targets.map(target => `Get-CimInstance ${target}`).join("; ") };
  const before = JSON.stringify(args);
  const item = component("powershell", args);
  item.updateResult(goodResult(), false);
  for (const width of [80, 132, 200, 320]) {
    const row = summaryRows(item, width)[0];
    const shown = targets.filter(target => row.includes(target));
    assert.deepEqual(shown, targets.slice(0, shown.length));
    assert.ok(shown.length >= 1);
    if (shown.length < targets.length) assert.match(row, new RegExp(`  \\+${targets.length - shown.length}\\s+powershell$`));
    else assert.doesNotMatch(row, /\+\d/);
    assert.doesNotMatch(row, /…ivers|insta…|Win32_[A-Za-z]*…/);
    assertHalf(item, width);
  }
  const expression = "([Environment]::GetFolderPath('CommonStartup'))";
  const ordinary = component("mcp_files", { paths: [expression, "second.md"] });
  ordinary.updateResult(goodResult(), false);
  assert.ok(summaryRows(ordinary, 240)[0].includes(expression));
  assert.equal(JSON.stringify(args), before);
  item.setExpanded(true);
  assert.ok(lines(item, 600).includes(JSON.stringify(args.command).slice(1, -1)));
});

test("H folds long paths only at directory boundaries while preserving complete filenames and ranges", () => {
  const path = ".pi/agent/install/releases/1.3.0/node_modules/vendor/dist/core/agent-session.js";
  const item = component("read", { path, offset: 1, limit: 200 });
  item.updateResult(goodResult(), false);
  for (const width of [80, 132, 160]) {
    const row = summaryRows(item, width)[0];
    assert.match(row, /…\/.*agent-session\.js:1-200/);
    assert.doesNotMatch(row, /insta…|…ndor|…ssion/);
    assertHalf(item, width);
  }
  item.setExpanded(true);
  assert.ok(lines(item, 320).includes(path));
});

test("H unescapes only collapsed shell tokens and preserves Windows paths, regexps and native arguments", () => {
  for (const command of [String.raw`Get-ChildItem -Path \$env:TEMP`, String.raw`Get-ChildItem -Path \"$env:APPDATA\"`]) {
    const args = { command };
    const before = JSON.stringify(args);
    const item = component("powershell", args);
    item.updateResult(goodResult(), false);
    assert.match(summaryRows(item, 240)[0], /\$env:(?:TEMP|APPDATA)/);
    assert.doesNotMatch(lines(item, 240), /\\[$"]/);
    assert.doesNotMatch(summaryRows(item, 240)[0], /\$env:APPDATA"/);
    item.setExpanded(true);
    assert.ok(lines(item, 600).includes(JSON.stringify(command).slice(1, -1)));
    assert.equal(JSON.stringify(args), before);
  }
  for (const value of [String.raw`C:\Users\demo\regex\d.txt`, String.raw`\d+\s+\Users`]) {
    const item = component("mcp_query", { query: value });
    item.updateResult(goodResult(), false);
    assert.ok(lines(item, 240).includes(value));
  }
  for (const [raw, expected] of [["'orphan", "orphan"], ["orphan'", "orphan"], ['"paired"', "paired"], ["can't", "can't"]]) {
    const item = component("mcp_query", { query: raw });
    item.updateResult(goodResult(), false);
    assert.equal(summaryRows(item, 132)[0].trim().split(/\s{2,}/)[0], expected);
  }
});

test("H collapses mixed ASCII and Unicode trailing ellipses only in excerpts", () => {
  for (const tail of ["… …", "... …", "… ...", "... ..."]) {
    const command = `custom.method() ${tail}`;
    const item = component("bash", { command });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 200);
    assert.equal(rows.length, 2);
    assert.match(rows[1], /method\(\) …$/);
    assert.doesNotMatch(rows[1], /(?:(?:\.{3}|…)\s*){2,}$/);
    item.setExpanded(true);
    assert.ok(lines(item, 320).includes(command));
  }
});

test("I and J use normal weight, three narration brightness levels and identical rail glyphs in both themes", async () => {
  const transform = await transformerSetup();
  for (const [name, lead, solo, rest, id, head, rail] of [
    ["dark", "#E8ECEA", "#D9DFDD", "#8E999C", "#D6CBB2", "#B3A785", "#4F5550"],
    ["light", "#243135", "#344449", "#5C696D", "#756344", "#766C55", "#8C8574"],
  ]) {
    agent.initTheme(name, false);
    const ctx = { messageType: "assistant", availableWidth: 30, isStreaming: false };
    const paired = transform("*先检查字段，继续核对很长的中文说明与 sessionName 并确认结果。*", ctx);
    assert.ok(paired.includes(theme.style("先检查字段，", { fg: tui.parseColor(lead), bold: false })));
    assert.ok(paired.includes(theme.style("sessionName", { fg: tui.parseColor(id), bold: false })));
    assert.ok(paired.includes(theme.style("▎ ", { fg: tui.parseColor(head) })));
    assert.ok(paired.includes(theme.style("▎ ", { fg: tui.parseColor(rail) })));
    assert.ok(paired.includes(theme.style("继续核对很长的中文说明与 ", { fg: tui.parseColor(rest), bold: false }).slice(0, 19)));
    assert.doesNotMatch(paired, /\x1b\[1m|│/);
    const one = transform("*正在检查配置。*", ctx);
    assert.ok(one.includes(theme.style("正在检查配置。", { fg: tui.parseColor(solo), bold: false })));
    assert.doesNotMatch(one, /\x1b\[1m/);
    assert.equal(transform("**最终答复保持粗体。**", ctx), "**最终答复保持粗体。**");
    const tool = component("read", { path: "normal.md" });
    assert.doesNotMatch(tool.render(132).join("\n"), /\x1b\[1m/);
  }
  agent.initTheme("dark", false);
});

test("K keeps two rows before a separate narration and the configured intra gap after it", async () => {
  await transformerSetup();
  const a = await stage(assistantCalls(["boundary-a"]).content);
  const explanation = await stage([narration("下一步")]);
  const b = await stage(assistantCalls(["boundary-b"]).content);
  const before = JSON.stringify([a.message, explanation.message, b.message]);
  assert.deepEqual(visibleGaps([...a.items, ...explanation.items, ...b.items]), [2, INTRA_GAP]);
  assert.equal(JSON.stringify([a.message, explanation.message, b.message]), before);
});

test("L repeats only consecutive done tools and invalidates cached peer rows on status changes", async () => {
  await transformerSetup();
  const sample = await stage([narration("检查文件"), ...assistantCalls(["ditto-a", "ditto-b", "ditto-c"]).content]);
  const names = () => summaryRows(sample.tools[0], 132).map(row => row.trim().split(/\s+/).at(-1));
  assert.deepEqual(names(), ["read", ENABLE_DITTO ? "·" : "read", ENABLE_DITTO ? "·" : "read"]);
  sample.tools[0].updateResult(goodResult(), true);
  assert.deepEqual(names(), ["[pending]", "read", ENABLE_DITTO ? "·" : "read"]);
  sample.tools[0].markExecutionStarted();
  assert.deepEqual(names(), ["[running]", "read", ENABLE_DITTO ? "·" : "read"]);
  sample.tools[0].updateResult({ content: [], isError: true }, false);
  assert.deepEqual(names(), ["[error]", "read", ENABLE_DITTO ? "·" : "read"]);
  sample.tools[0].updateResult(goodResult(), false);
  assert.deepEqual(names(), ["read", ENABLE_DITTO ? "·" : "read", ENABLE_DITTO ? "·" : "read"]);
  sample.tools[1].updateResult(goodResult(), true);
  assert.deepEqual(names(), ["read", "[pending]", "read"]);
  sample.tools[1].updateResult(goodResult(), false);
  const next = await stage([narration("新节点"), ...assistantCalls(["ditto-new"]).content]);
  assert.match(summaryRows(next.tools[0], 132)[0], /read$/);
  for (const tool of sample.tools) tool.setExpanded(true);
  assert.equal(transcript(sample.tools).map(tui.stripTerminalSequences).join("\n").split("original-line-119").length - 1, 3);
  for (const tool of sample.tools) tool.setExpanded(false);
  assert.deepEqual(names(), ["read", ENABLE_DITTO ? "·" : "read", ENABLE_DITTO ? "·" : "read"]);
});

test("L resets on a tool switch and restores ditto metadata from the active branch", async () => {
  await transformerSetup();
  const content = assistantCalls(["switch-read-a", "switch-bash", "switch-read-b", "switch-read-c"]).content;
  content[1] = { ...content[1], name: "bash", arguments: { command: "git status --short" } };
  const sample = await stage([narration("检查切换"), ...content]);
  const branch = [{ type: "message", message: sample.message }];
  const before = JSON.stringify(branch);
  for (const event of ["session_start", "session_tree", "session_compact"]) {
    await extension.handlers.get(event)[0]({}, { mode: "tui", sessionManager: { getBranch: () => branch }, ui: { theme, setToolsExpanded() {}, setHiddenThinkingLabel() {} } });
    const tools = content.map(call => { const tool = component(call.name, call.arguments, undefined, { callId: call.id }); tool.updateResult(goodResult(), false); return tool; });
    assert.deepEqual(summaryRows(tools[0], 132).map(row => row.trim().split(/\s+/).at(-1)), ["read", "bash", "read", ENABLE_DITTO ? "·" : "read"]);
  }
  assert.equal(JSON.stringify(branch), before);
});

test("L applies to real codemode records without hiding calls, states, parameters or details", async () => {
  await transformerSetup();
  const calls = ["a", "b", "c"].map(id => ({ name: "read", args: JSON.stringify({ path: `nested-${id}.md` }), status: "ok" }));
  const result = { content: [{ type: "text", text: "NESTED_RAW_RESULT" }], details: { calls } };
  const before = JSON.stringify(result);
  const item = component("codemode", { code: "await tools.read();" });
  item.updateResult(result, false);
  const names = () => summaryRows(item, 132).slice(1).map(row => row.trim().split(/\s+/).at(-1));
  assert.deepEqual(names(), ["read", ENABLE_DITTO ? "·" : "read", ENABLE_DITTO ? "·" : "read"]);
  const changed = structuredClone(result); changed.details.calls[1].status = "error";
  item.updateResult(changed, false);
  assert.deepEqual(names(), ["read", "[failed]", "read"]);
  item.updateResult(result, false);
  item.setExpanded(true);
  assert.match(lines(item, 320), /nested-a.md[\s\S]*nested-b.md[\s\S]*nested-c.md/);
  assert.match(lines(item), /NESTED_RAW_RESULT/);
  item.setExpanded(false);
  assert.deepEqual(names(), ["read", ENABLE_DITTO ? "·" : "read", ENABLE_DITTO ? "·" : "read"]);
  assert.equal(JSON.stringify(result), before);
});

test("session teardown, stale runtime invalidation and subsequent restore keep rendering safe", async () => {
  await resetGroups();
  const context = { mode: "tui", sessionManager: { getBranch: () => [] }, ui: { theme, setToolsExpanded() {}, setHiddenThinkingLabel() {}, notify() {} } };
  await extension.handlers.get("session_start")[0]({}, context);

  const id = "stale-safe";
  const message = {
    role: "assistant", stopReason: "toolUse",
    content: [{ type: "text", text: "*执行检查。*" }, { type: "toolCall", id, name: "read", arguments: { path: "stale-safe.md" } }],
  };
  await observe({ role: "assistant", content: [] }, "message_start");
  await observe(message);
  await observe(message, "message_end");
  const item = component("read", { path: "stale-safe.md" }, undefined, { callId: id });
  item.updateResult(goodResult(), false);

  assert.equal(item.render(80).length, 1 + INTRA_GAP);
  assert.match(lines(item), /stale-safe\.md/);

  // 1. Session shutdown fires upon switchSession / newSession / reload
  await extension.handlers.get("session_shutdown")[0]({ reason: "switch" }, context);

  // 2. Mark runtime stale as host does on session disposal
  const staleMarker = "This extension ctx is stale after session replacement or reload.";
  loaded.runtime.invalidate(staleMarker);
  assert.throws(() => loaded.runtime.assertActive(), new RegExp(staleMarker));

  // 3. Old component redraw must not throw even if rendered after invalidation
  assert.doesNotThrow(() => {
    const rows = item.render(80);
    assert.ok(rows.length >= 1);
    assert.match(rows.map(tui.stripTerminalSequences).join("\n"), /stale-safe\.md/);
  });

  // 4. Progress command must also safely handle stale settings without crashing
  const progressCmd = extension.commands.get("progress");
  assert.ok(progressCmd);
  let notified = false;
  await assert.doesNotReject(async () => {
    await progressCmd.handler("status", { ui: { notify: () => { notified = true; } }, mode: "tui" });
  });
  assert.ok(notified);

  // 5. Subsequent session_start / tree restores normal operation for new session
  const newBranch = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "fresh-call", name: "read", arguments: { path: "fresh.md" } }] } },
  ];
  await extension.handlers.get("session_start")[0]({}, { ...context, sessionManager: { getBranch: () => newBranch } });
  const freshItem = component("read", { path: "fresh.md" }, undefined, { callId: "fresh-call" });
  freshItem.updateResult(goodResult(), false);
  assert.match(lines(freshItem), /fresh\.md/);
});

test("edit and write show single-line green +N and red -M line counts within the half-width budget", async () => {
  await resetGroups();
  for (const [name, addedColor, removedColor] of [
    ["dark", "#8FB58D", "#D99083"],
    ["light", "#4A7A4C", "#A65B52"],
  ]) {
    agent.initTheme(name, false);
    const editArgs = {
      path: "src/PROJECT.md",
      oldText: "keep-head\nPRIVATE_OLD_1\nPRIVATE_OLD_2\nkeep-tail",
      newText: "keep-head\nPRIVATE_NEW_1\nPRIVATE_NEW_2\nPRIVATE_NEW_3\nkeep-tail",
    };
    const editBefore = JSON.stringify(editArgs);
    const editItem = component("edit", editArgs);
    editItem.updateResult(goodResult(), false);
    const editRendered = editItem.render(132).find(row => row.includes("PROJECT.md"));
    assert.equal(summaryRows(editItem, 132).length, 1);
    assert.match(summaryRows(editItem, 132)[0], /src\/PROJECT\.md  \+3 -2\s+edit$/);
    assert.ok(editRendered.includes(theme.style("+3", { fg: tui.parseColor(addedColor), bold: false })));
    assert.ok(editRendered.includes(theme.style("-2", { fg: tui.parseColor(removedColor), bold: false })));
    assert.doesNotMatch(lines(editItem, 132), /PRIVATE_/);
    assert.equal(JSON.stringify(editArgs), editBefore);

    const writeArgs = { path: "docs/LOCAL-UPDATE.md", content: "line-1\nline-2\nPRIVATE_WRITE_LINE_3\n" };
    const writeBefore = JSON.stringify(writeArgs);
    const writeItem = component("write", writeArgs);
    writeItem.updateResult(goodResult(), false);
    const writeRendered = writeItem.render(132).find(row => row.includes("LOCAL-UPDATE.md"));
    assert.equal(summaryRows(writeItem, 132).length, 1);
    assert.match(summaryRows(writeItem, 132)[0], /docs\/LOCAL-UPDATE\.md  \+3\s+write$/);
    assert.ok(writeRendered.includes(theme.style("+3", { fg: tui.parseColor(addedColor), bold: false })));
    assert.doesNotMatch(summaryRows(writeItem, 132)[0], /-\d/);
    assert.doesNotMatch(lines(writeItem, 132), /PRIVATE_/);
    assert.equal(JSON.stringify(writeArgs), writeBefore);

    for (const width of [16, 24, 32, 80, 132, 200]) {
      assertHalf(editItem, width);
      assertHalf(writeItem, width);
      assert.equal(summaryRows(editItem, width).length, 1);
      assert.equal(summaryRows(writeItem, width).length, 1);
    }
  }
  agent.initTheme("dark", false);

  const multiEdit = component("edit", {
    path: "CHANGELOG.md",
    edits: [
      { oldText: "same\n", newText: "same\nadded-a\nadded-b\n" },
      { oldText: "remove-only\n", newText: "" },
    ],
  });
  multiEdit.updateResult(goodResult(), false);
  assert.match(summaryRows(multiEdit, 132)[0], /CHANGELOG\.md  \+2 -1\s+edit$/);
});

test("inline scripts skip setup boilerplate and extract distinct single-line path or URL targets", async () => {
  await resetGroups();
  const rawAssignScript = [
    'python -c "',
    "import os, json",
    "pi_dir = r'C:\\Users\\demo\\.pi\\agent'",
    "for sub in ['extensions', 'skills', 'settings.json']:",
    "    p = os.path.join(pi_dir, sub)",
    "    print(p, os.path.exists(p))",
    '"',
  ].join("\n");
  const assignItem = component("bash", { command: rawAssignScript }, undefined, { cwd: "C:\\Windows\\System32" });
  assignItem.updateResult(goodResult(), false);
  const assignRows = summaryRows(assignItem, 160);
  assert.equal(assignRows.length, 1);
  assert.match(assignRows[0], /\.pi\/agent\/extensions, .*\.pi\/agent\/skills/);
  assert.doesNotMatch(assignRows[0], /pi_dir\s*=\s*r/);
  assertHalf(assignItem, 80);
  assertHalf(assignItem, 160);

  const reconfigureCommands = [
    "python -c \"\nimport sys, urllib.request, json\nsys.stdout.reconfigure(encoding='utf-8')\nurl = 'https://api.github.com/repos/QingYunA/answer-me-with-html/releases/tags/v0.5.6'\n\"",
    "python -c \"\nimport sys, os\nsys.stdout.reconfigure(encoding='utf-8')\nbase = r'C:\\Users\\demo\\.pi\\agent\\skills\\antigravity-quota'\nfor root, dirs, files in os.walk(base):\n    pass\n\"",
    "python -c \"\nimport sys, os\nsys.stdout.reconfigure(encoding='utf-8')\nbase = r'C:\\Users\\demo\\.pi\\agent\\skills\\noct-image'\nfor root, dirs, files in os.walk(base):\n    pass\n\"",
    "python -c \"\nimport sys, os\nsys.stdout.reconfigure(encoding='utf-8')\nbase = r'C:\\Users\\demo\\.pi\\agent\\extensions\\auto-session-title'\nfor f in os.listdir(base):\n    pass\n\"",
  ];
  const rendered = reconfigureCommands.map(command => {
    const item = component("bash", { command }, undefined, { cwd: "C:\\Windows\\System32" });
    item.updateResult(goodResult(), false);
    const rows = summaryRows(item, 160);
    assert.equal(rows.length, 1, command);
    assert.doesNotMatch(rows[0], /sys\.stdout\.reconfigure/);
    assertHalf(item, 80);
    return rows[0];
  });
  assert.equal(new Set(rendered).size, 4);
  assert.match(rendered[0], /answer-me-with-html\/releases\/tags\/v0\.5\.6/);
  assert.match(rendered[1], /skills\/antigravity-quota/);
  assert.match(rendered[2], /skills\/noct-image/);
  assert.match(rendered[3], /extensions\/auto-session-title/);
});
