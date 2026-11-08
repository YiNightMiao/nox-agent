(function () {
  var SYSTEM = [
    "你是 Nox，跑在用户自己这台已经越狱的 iPhone 上的编码代理。默认用中文，短句，先说结论。",
    "工作区文件不写进系统提示。文件会变，写进来会毁掉前缀缓存。用工具读。",
    "先 list_files / read_file / search，再 propose_edit。propose_edit 只进入审查，用户接受后才写入。",
    "run_command 在请求批准模式下，非只读命令会停下来等用户点允许。被拒绝就换更小的办法。",
    "路径用相对路径，禁止 .. 和绝对路径。不要碰钥匙串、系统分区、越狱引导。",
    "不要建议修改更早的消息或这条系统提示。易变信息只放在工具结果里。",
    "做完就停。不要编造文件内容或命令输出。"
  ].join("\n");

  var TOOLS = [
    { type: "function", function: { name: "list_files", description: "列出工作区文件", parameters: { type: "object", additionalProperties: false, properties: { dir: { type: "string" } } } } },
    { type: "function", function: { name: "read_file", description: "读取文本文件", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } } } },
    { type: "function", function: { name: "search", description: "子串搜索", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string" } } } } },
    { type: "function", function: { name: "propose_edit", description: "提交整文件新内容供审查", parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } } } },
    { type: "function", function: { name: "run_command", description: "在工作区运行一条命令", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string" } } } } }
  ];

  var READONLY = /^(pwd|ls|cat|head|echo)(\s|$)/;
  var seq = 1;
  var waiters = {};
  var streams = {};
  var tree = new window.NoxRadix();
  var state = load();

  function load() {
    var base = {
      threads: [],
      active: "",
      pane: "home",
      tab: "review",
      mode: "ask",
      files: { "README.md": "# Nox\n\n工作区在这台 iPhone 上。先读再改。\n" },
      edits: [],
      entries: [],
      filter: "all",
      preview: "",
      settings: { base: "https://api.x.ai/v1", model: "grok-4.5", hasKey: false, root: "" },
      showSettings: false
    };
    try {
      var saved = JSON.parse(localStorage.getItem("nox-device") || "null");
      if (saved) {
        if (saved.threads) base.threads = saved.threads;
        if (saved.files) base.files = saved.files;
        if (saved.edits) base.edits = saved.edits;
        if (saved.entries) base.entries = saved.entries;
        if (saved.mode) base.mode = saved.mode;
        if (saved.active) base.active = saved.active;
        if (saved.settings) base.settings = Object.assign(base.settings, saved.settings);
      }
    } catch (e) {}
    base.pane = "home";
    base.showSettings = false;
    base.threads.forEach(function (t) {
      t.messages = t.messages || [];
      t.terminal = t.terminal || [];
      t.usage = t.usage || { prompt: 0, cached: 0, localHits: 0 };
      t.approved = {};
      t.rejected = {};
      t.status = "idle";
      t.draft = "";
      t.activity = "";
      t.error = "";
      t.budget = 4;
      t.mode = t.mode || base.mode;
    });
    return base;
  }

  function save() {
    var copy = {
      threads: state.threads.map(function (t) {
        return { id: t.id, title: t.title, messages: t.messages, terminal: t.terminal, usage: t.usage, mode: t.mode, status: "idle" };
      }),
      active: state.active,
      mode: state.mode,
      files: state.files,
      edits: state.edits,
      entries: state.entries.slice(-40),
      settings: { base: state.settings.base, model: state.settings.model, hasKey: state.settings.hasKey, root: state.settings.root }
    };
    try { localStorage.setItem("nox-device", JSON.stringify(copy)); } catch (e) {}
  }

  function uid() { return "t" + Date.now().toString(36) + (seq++); }

  function native(op, payload) {
    return new Promise(function (resolve, reject) {
      if (!window.webkit || !window.webkit.messageHandlers || !window.webkit.messageHandlers.nox) {
        reject(new Error("原生桥没接上"));
        return;
      }
      var id = uid();
      waiters[id] = { resolve: resolve, reject: reject };
      var msg = { id: id, op: op };
      Object.keys(payload || {}).forEach(function (key) { msg[key] = payload[key]; });
      window.webkit.messageHandlers.nox.postMessage(msg);
    });
  }

  window.__noxResult = function (id, ok, value) {
    if (streams[id] && ok && value && value.started) return;
    var waiter = waiters[id];
    if (!waiter) return;
    delete waiters[id];
    if (ok) waiter.resolve(value);
    else waiter.reject(new Error(typeof value === "string" ? value : "失败"));
  };
  window.__noxChunk = function (id, b64) {
    var stream = streams[id];
    if (!stream) return;
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var text = new TextDecoder().decode(bytes);
    stream.onChunk(text);
  };
  window.__noxDone = function (id) {
    var stream = streams[id];
    if (!stream) return;
    delete streams[id];
    stream.resolve();
  };
  window.__noxFail = function (id, message) {
    var stream = streams[id];
    if (!stream) return;
    delete streams[id];
    stream.reject(new Error(message || "模型错误"));
  };

  function el(html) {
    var node = document.createElement("div");
    node.innerHTML = html.trim();
    return node.firstChild;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      if (c === "&") return "&" + "amp;";
      if (c === "<") return "&" + "lt;";
      if (c === ">") return "&" + "gt;";
      if (c === '"') return "&" + "quot;";
      return "&" + "#39;";
    });
  }

  function thread() {
    for (var i = 0; i < state.threads.length; i++) if (state.threads[i].id === state.active) return state.threads[i];
    return null;
  }

  function render() {
    var root = document.getElementById("app");
    root.innerHTML = "";
    if (state.pane === "home") root.appendChild(renderHome());
    else if (state.pane === "tools") root.appendChild(renderTools(true));
    else root.appendChild(renderChat());
    if (state.showSettings) root.appendChild(renderSettings());
  }

  function renderHome() {
    var screen = el('<div class="screen safe-top"></div>');
    screen.appendChild(el('<div class="top"><button class="round" id="gear" aria-label="设置">设</button><span></span></div>'));
    screen.appendChild(el("<h1>Nox</h1>"));
    screen.appendChild(el('<p class="sub">这台 iPhone · ' + esc(state.settings.root || "工作区") + "</p>"));
    var filters = el('<div class="row"></div>');
    [["all", "全部"], ["live", "进行中"], ["done", "已完成"]].forEach(function (pair) {
      var b = el('<button class="chip' + (state.filter === pair[0] ? " on" : "") + '">' + pair[1] + "</button>");
      b.onclick = function () { state.filter = pair[0]; render(); };
      filters.appendChild(b);
    });
    screen.appendChild(filters);
    var actions = el('<div class="row"></div>');
    var newer = el('<button class="primary">新对话</button>');
    newer.onclick = function () { openNew(); };
    actions.appendChild(newer);
    screen.appendChild(actions);
    var list = el('<div class="list"></div>');
    list.appendChild(el('<div class="label">项目</div>'));
    list.appendChild(el('<button class="item on"><span class="grow">这台 iPhone</span></button>'));
    list.appendChild(el('<div class="label">对话</div>'));
    var any = false;
    state.threads.forEach(function (item) {
      var live = item.status && item.status !== "idle";
      if (state.filter === "live" && !live) return;
      if (state.filter === "done" && live) return;
      any = true;
      var row = el('<button class="item"><span class="dot' + (live ? " live" : "") + '"></span><span class="grow">' + esc(item.title) + "</span></button>");
      row.onclick = function () { state.active = item.id; state.pane = "chat"; render(); };
      list.appendChild(row);
    });
    if (!any) list.appendChild(el('<p class="sub">还没有对话。</p>'));
    screen.appendChild(list);
    screen.querySelector("#gear").onclick = function () { state.showSettings = true; render(); };
    return screen;
  }

  function rateOf(t) {
    if (!t || !t.usage.prompt) return "—";
    return Math.round((t.usage.cached / t.usage.prompt) * 100) + "%";
  }

  function renderChat() {
    var t = thread();
    var screen = el('<div class="screen"></div>');
    var bar = el('<div class="bar safe-top"></div>');
    var back = el('<button class="round" aria-label="返回">←</button>');
    back.onclick = function () { state.pane = "home"; render(); };
    var titles = el("<div class='grow'><p class='title'>" + esc(t ? t.title : "新对话") + "</p><p class='muted'>这台 iPhone</p></div>");
    var cache = el('<button class="chip">缓存 ' + rateOf(t) + "</button>");
    var tools = el('<button class="round" aria-label="工具">审</button>');
    tools.onclick = function () { state.pane = "tools"; render(); };
    bar.appendChild(back); bar.appendChild(titles); bar.appendChild(cache); bar.appendChild(tools);
    screen.appendChild(bar);
    var body = el('<div class="thread"></div>');
    if (!t || !t.messages.length) {
      var empty = el('<div class="empty"><p class="muted">这台 iPhone</p><h2>我们在这台机器上构建什么？</h2><div class="ideas"></div></div>');
      ["梳理工作区", "给 README 加一段用法", "列出这里能改的文件"].forEach(function (idea) {
        var b = el("<button>" + idea + "</button>");
        b.onclick = function () { send(idea); };
        empty.querySelector(".ideas").appendChild(b);
      });
      body.appendChild(empty);
    } else {
      t.messages.forEach(function (m) {
        if (m.role === "user") body.appendChild(el('<div class="bubble">' + esc(m.content) + "</div>"));
        else if (m.role === "tool") body.appendChild(el('<div class="tool">' + esc(m.name) + "\n" + esc(m.content) + "</div>"));
        else if (m.content) body.appendChild(el('<div class="plain">' + esc(m.content) + "</div>"));
      });
      if (t.draft) body.appendChild(el('<div class="plain">' + esc(t.draft) + "</div>"));
      if (t.status === "running") body.appendChild(el('<p class="muted"><span class="dot live"></span> ' + esc(t.activity || "正在工作") + "</p>"));
      if (t.error) body.appendChild(el('<p class="err">' + esc(t.error) + "</p>"));
      if (t.status === "approval") {
        var card = el('<div class="card"><p class="title">请求批准</p><pre>' + esc(t.pending || "") + '</pre><div class="row"></div></div>');
        var yes = el('<button class="primary">运行</button>');
        var no = el('<button class="chip">拒绝</button>');
        yes.onclick = function () { decide(true); };
        no.onclick = function () { decide(false); };
        card.querySelector(".row").appendChild(yes);
        card.querySelector(".row").appendChild(no);
        body.appendChild(card);
      }
    }
    screen.appendChild(body);
    var form = el('<form class="composer safe-bottom"><div class="box"><textarea placeholder="写下来"></textarea><div class="row"></div></div></form>');
    var area = form.querySelector("textarea");
    var modeName = (t && t.mode) || state.mode;
    var modeBtn = el('<button class="chip" type="button">' + (modeName === "ask" ? "请求批准" : "只读自动") + "</button>");
    modeBtn.onclick = function () {
      var next = modeName === "ask" ? "readonly" : "ask";
      state.mode = next;
      if (t) t.mode = next;
      save(); render();
    };
    var model = el('<span class="chip">' + esc(state.settings.model || "Grok") + "</span>");
    var sendBtn = el('<button class="round send" type="submit" aria-label="发送">↑</button>');
    form.querySelector(".row").appendChild(modeBtn);
    form.querySelector(".row").appendChild(model);
    form.querySelector(".row").appendChild(sendBtn);
    form.onsubmit = function (event) {
      event.preventDefault();
      send(area.value);
    };
    screen.appendChild(form);
    return screen;
  }

  function renderTools(full) {
    var screen = el('<div class="' + (full ? "screen" : "") + '"></div>');
    var bar = el('<div class="bar safe-top"><button class="round" id="close" aria-label="关闭">×</button><p class="title">工具</p></div>');
    screen.appendChild(bar);
    var tabs = el('<div class="tools"></div>');
    [["review", "审查"], ["terminal", "终端"], ["files", "文件"]].forEach(function (pair) {
      var b = el('<button class="' + (state.tab === pair[0] ? "on" : "") + '">' + pair[1] + "</button>");
      b.onclick = function () { state.tab = pair[0]; render(); };
      tabs.appendChild(b);
    });
    screen.appendChild(tabs);
    var body = el('<div class="list"></div>');
    var t = thread();
    if (state.tab === "review") {
      var open = state.edits.filter(function (e) { return e.status === "open"; });
      if (!open.length) body.appendChild(el('<p class="muted">还没有待审查的改动。</p>'));
      open.forEach(function (edit) {
        var card = el('<div class="card"><p class="title">' + esc(edit.path) + '</p><pre></pre><div class="row"></div></div>');
        card.querySelector("pre").textContent = diffText(edit.before, edit.after);
        var yes = el('<button class="primary">接受</button>');
        var no = el('<button class="chip">拒绝</button>');
        yes.onclick = function () { accept(edit.id); };
        no.onclick = function () { edit.status = "rejected"; save(); render(); };
        card.querySelector(".row").appendChild(yes);
        card.querySelector(".row").appendChild(no);
        body.appendChild(card);
      });
    } else if (state.tab === "terminal") {
      var lines = (t && t.terminal) || [];
      if (!lines.length) body.appendChild(el('<p class="muted">终端还是空的。</p>'));
      lines.forEach(function (line) {
        var block = el("<pre></pre>");
        block.textContent = "$ " + line.command + "\n" + line.output;
        body.appendChild(block);
      });
    } else {
      Object.keys(state.files).sort().forEach(function (path) {
        var b = el('<button class="item"><span class="grow">' + esc(path) + "</span></button>");
        b.onclick = function () {
          state.preview = path;
          render();
        };
        body.appendChild(b);
      });
      if (state.preview && state.files[state.preview] != null) {
        var pre = el("<pre></pre>");
        pre.textContent = state.files[state.preview];
        body.appendChild(pre);
      }
    }
    screen.appendChild(body);
    screen.querySelector("#close").onclick = function () { state.pane = "chat"; render(); };
    return screen;
  }

  function renderSettings() {
    var sheet = el('<div class="sheet safe-top"></div>');
    sheet.appendChild(el('<div class="bar"><button class="round" id="x" aria-label="关闭">×</button><p class="title">接口</p></div>'));
    sheet.appendChild(el('<label class="field">Base URL<input id="base" value="' + esc(state.settings.base) + '" /></label>'));
    sheet.appendChild(el('<label class="field">模型<input id="model" value="' + esc(state.settings.model) + '" /></label>'));
    sheet.appendChild(el('<label class="field">API key<input id="key" type="password" placeholder="' + (state.settings.hasKey ? "已保存，留空则不改" : "粘贴 key") + '" /></label>'));
    var saveBtn = el('<button class="primary" style="margin:12px 20px">保存</button>');
    sheet.appendChild(saveBtn);
    sheet.appendChild(el('<p class="sub">Key 只留在这台手机上，工作区限制在 Nox 目录。命中率靠冻结提示、x-grok-conv-id 和 Radix 完全命中。</p>'));
    sheet.querySelector("#x").onclick = function () { state.showSettings = false; render(); };
    saveBtn.onclick = function () {
      native("settings.set", {
        base: sheet.querySelector("#base").value.trim(),
        model: sheet.querySelector("#model").value.trim(),
        key: sheet.querySelector("#key").value
      }).then(function () {
        return native("settings.get");
      }).then(function (settings) {
        state.settings = settings;
        state.showSettings = false;
        save();
        render();
      }).catch(function (error) {
        alert(error.message);
      });
    };
    return sheet;
  }

  function diffText(before, after) {
    var a = before.split("\n"), b = after.split("\n"), out = [];
    var max = Math.max(a.length, b.length);
    for (var i = 0; i < max && out.length < 200; i++) {
      if (a[i] === b[i]) { if (a[i] != null) out.push("  " + a[i]); }
      else {
        if (a[i] != null) out.push("- " + a[i]);
        if (b[i] != null) out.push("+ " + b[i]);
      }
    }
    return out.join("\n");
  }

  function openNew() {
    var t = blank();
    state.threads.unshift(t);
    state.active = t.id;
    state.pane = "chat";
    save();
    render();
  }

  function blank() {
    return {
      id: uid(), title: "新对话", messages: [], draft: "", activity: "", error: "",
      status: "idle", budget: 4, mode: state.mode, terminal: [],
      usage: { prompt: 0, cached: 0, localHits: 0 }, pending: "", approved: {}, rejected: {}
    };
  }

  function clean(path) {
    var raw = String(path || "").trim().replace(/^\.\//, "");
    if (!raw || raw.indexOf("..") >= 0 || raw.charAt(0) === "/") return null;
    return raw;
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text) return;
    var t = thread();
    if (t && (t.status === "running" || t.status === "approval")) return;
    if (!t) { t = blank(); state.threads.unshift(t); state.active = t.id; }
    if (!t.messages.length) t.title = text.slice(0, 32);
    t.messages.push({ id: uid(), role: "user", content: text });
    t.error = "";
    t.budget = 4;
    t.status = "running";
    state.pane = "chat";
    save();
    render();
    pump(t.id);
  }

  function wire(messages) {
    var out = [{ role: "system", content: SYSTEM }];
    messages.forEach(function (m) {
      if (m.role === "user") out.push({ role: "user", content: m.content });
      else if (m.role === "tool") out.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name });
      else {
        var row = { role: "assistant", content: m.content || (m.toolCalls ? null : "") };
        if (m.reasoning) row.reasoning_content = m.reasoning;
        if (m.toolCalls) row.tool_calls = m.toolCalls.map(function (c) {
          return { id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } };
        });
        out.push(row);
      }
    });
    return out;
  }

  function unresolved(t) {
    var calls = [];
    for (var i = t.messages.length - 1; i >= 0; i--) {
      var m = t.messages[i];
      if (m.role === "assistant" && m.toolCalls) { calls = m.toolCalls; break; }
      if (m.role === "user") break;
    }
    var done = {};
    t.messages.forEach(function (m) { if (m.role === "tool") done[m.toolCallId] = true; });
    return calls.filter(function (c) { return !done[c.id]; });
  }

  function pump(id) {
    var guard = 0;
    function step() {
      var t = state.threads.filter(function (item) { return item.id === id; })[0];
      if (!t || guard++ > 6) return;
      var waiting = unresolved(t);
      if (waiting.length) {
        if (apply(t, waiting[0]) === "pause") { save(); render(); return; }
        save(); render();
        step();
        return;
      }
      var last = t.messages[t.messages.length - 1];
      if (!last || (last.role === "assistant" && !last.toolCalls)) {
        t.status = "idle"; t.activity = ""; save(); render(); return;
      }
      if (t.budget <= 0) { t.status = "idle"; t.error = "这一轮工具调用已达上限"; save(); render(); return; }
      complete(t).then(function (cont) {
        save(); render();
        if (cont) step();
      }).catch(function (error) {
        t.status = "idle"; t.activity = ""; t.draft = ""; t.error = error.message; save(); render();
      });
    }
    step();
  }

  function apply(t, call) {
    var args = {};
    try { args = JSON.parse(call.arguments || "{}"); } catch (e) {}
    if (call.name === "run_command") {
      var command = String(args.command || "");
      var readonly = READONLY.test(command.trim());
      if (t.mode === "readonly" && !readonly) {
        t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "只读自动：这条命令不会执行。" });
        return "go";
      }
      if (!readonly && !t.approved[call.id]) {
        if (t.rejected[call.id]) {
          t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "用户拒绝了这条命令" });
          return "go";
        }
        t.status = "approval";
        t.pending = command;
        t.pendingId = call.id;
        return "pause";
      }
      return runCmd(t, call, command);
    }
    if (call.name === "list_files") {
      var dir = String(args.dir || "");
      var rows = Object.keys(state.files).filter(function (p) { return !dir || p.indexOf(dir.replace(/\/$/, "") + "/") === 0; }).sort();
      t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: rows.join("\n") || "工作区是空的" });
      return "go";
    }
    if (call.name === "read_file") {
      var path = clean(args.path);
      t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: !path ? "路径不合法" : (state.files[path] != null ? state.files[path] : "找不到 " + path) });
      return "go";
    }
    if (call.name === "search") {
      var q = String(args.query || "");
      var hits = [];
      Object.keys(state.files).forEach(function (p) {
        state.files[p].split("\n").forEach(function (line, index) {
          if (q && line.indexOf(q) >= 0 && hits.length < 40) hits.push(p + ":" + (index + 1) + ": " + line.trim());
        });
      });
      t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: hits.join("\n") || "没有匹配" });
      return "go";
    }
    if (call.name === "propose_edit") {
      var editPath = clean(args.path);
      if (!editPath) {
        t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "路径不合法" });
        return "go";
      }
      state.edits.push({ id: uid(), path: editPath, before: state.files[editPath] || "", after: String(args.content || ""), status: "open" });
      t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "已放入审查：" + editPath });
      state.tab = "review";
      return "go";
    }
    t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "未知工具" });
    return "go";
  }

  function runCmd(t, call, command) {
    t.activity = command;
    if (window.__NOX_NATIVE__) {
      native("shell", { command: command }).then(function (output) {
        t.terminal.push({ command: command, output: String(output) });
        t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: String(output).slice(0, 12000) });
        t.status = "running";
        save(); render();
        pump(t.id);
      }).catch(function (error) {
        t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: error.message });
        t.status = "running";
        pump(t.id);
      });
      return "pause";
    }
    t.terminal.push({ command: command, output: "没有原生 shell" });
    t.messages.push({ id: uid(), role: "tool", name: call.name, toolCallId: call.id, content: "没有原生 shell" });
    return "go";
  }

  function decide(allow) {
    var t = thread();
    if (!t) return;
    var call = unresolved(t)[0];
    if (!call) return;
    if (allow) t.approved[call.id] = true;
    else t.rejected[call.id] = true;
    t.status = "running";
    save();
    render();
    pump(t.id);
  }

  function accept(id) {
    var edit = state.edits.filter(function (e) { return e.id === id; })[0];
    if (!edit) return;
    var write = function () {
      state.files[edit.path] = edit.after;
      edit.status = "accepted";
      save();
      render();
    };
    if (window.__NOX_NATIVE__) {
      native("fs.write", { path: edit.path, content: edit.after }).then(write).catch(function (error) { alert(error.message); });
    } else write();
  }

  function complete(t) {
    var messages = wire(t.messages);
    var key = JSON.stringify(messages);
    state.entries.forEach(function (entry) { tree.insert(entry.key, entry.value); });
    var hit = tree.match(key);
    if (hit.exact != null) {
      t.messages.push({ id: uid(), role: "assistant", content: hit.exact });
      t.usage.localHits += 1;
      var approx = Math.ceil(key.length / 4);
      t.usage.prompt += approx;
      t.usage.cached += approx;
      t.draft = "";
      return Promise.resolve(true);
    }
    var body = {
      model: state.settings.model || "grok-4.5",
      temperature: 0.2,
      max_tokens: 900,
      stream: true,
      stream_options: { include_usage: true },
      messages: messages,
      tools: TOOLS
    };
    t.activity = "正在写";
    t.draft = "";
    return new Promise(function (resolve, reject) {
      var id = uid();
      var content = "", reasoning = "", calls = [], prompt = 0, cached = 0, buffer = "";
      function take(line) {
        var trimmed = line.trim();
        if (trimmed.indexOf("data:") !== 0) return;
        var data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") return;
        var json;
        try { json = JSON.parse(data); } catch (e) { return; }
        if (json.error && json.error.message) throw new Error(json.error.message);
        var delta = (json.choices && json.choices[0] && (json.choices[0].delta || json.choices[0].message)) || {};
        if (delta.content) { content += delta.content; t.draft = content; render(); }
        if (delta.reasoning_content) reasoning += delta.reasoning_content;
        (delta.tool_calls || []).forEach(function (piece) {
          var index = piece.index || 0;
          while (calls.length <= index) calls.push({ id: "", name: "", arguments: "" });
          if (piece.id) calls[index].id = piece.id;
          if (piece.function && piece.function.name) calls[index].name += piece.function.name;
          if (piece.function && piece.function.arguments) calls[index].arguments += piece.function.arguments;
        });
        if (json.usage) {
          prompt = json.usage.prompt_tokens || prompt;
          cached = (json.usage.prompt_tokens_details && json.usage.prompt_tokens_details.cached_tokens) || cached;
        }
      }
      streams[id] = {
        onChunk: function (text) {
          buffer += text;
          var lines = buffer.split("\n");
          buffer = lines.pop();
          try { lines.forEach(take); } catch (error) { reject(error); }
        },
        resolve: function () {
          if (buffer.trim()) take(buffer);
          calls = calls.filter(function (c) { return c.name; }).map(function (c) { if (!c.id) c.id = uid(); return c; });
          var msg = { id: uid(), role: "assistant", content: content };
          if (reasoning) msg.reasoning = reasoning;
          if (calls.length) msg.toolCalls = calls;
          t.messages.push(msg);
          t.draft = "";
          t.activity = "";
          t.budget -= 1;
          t.usage.prompt += prompt;
          t.usage.cached += cached;
          if (!calls.length && content.trim()) {
            state.entries.push({ key: key, value: content });
            tree.insert(key, content);
          }
          resolve(true);
        },
        reject: reject
      };
      if (!window.__NOX_NATIVE__) {
        reject(new Error("请在 Dopamine 安装的 Nox 里配置 API key"));
        return;
      }
      window.webkit.messageHandlers.nox.postMessage({ id: id, op: "chat", threadId: t.id, json: JSON.stringify(body) });
    });
  }

  function refreshFiles() {
    if (!window.__NOX_NATIVE__) return Promise.resolve();
    return native("settings.get").then(function (settings) {
      state.settings = settings;
      return native("fs.list", { dir: "" });
    }).then(function (rows) {
      var jobs = [];
      (rows || []).forEach(function (row) {
        if (row.dir) return;
        jobs.push(native("fs.read", { path: row.name }).then(function (text) { state.files[row.name] = text; }));
      });
      if (!rows || !rows.length) {
        jobs.push(native("fs.write", { path: "README.md", content: state.files["README.md"] }));
      }
      return Promise.all(jobs);
    }).catch(function () {});
  }

  state.entries.forEach(function (entry) { tree.insert(entry.key, entry.value); });
  refreshFiles().then(function () { save(); render(); });
  render();
})();
