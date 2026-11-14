/**
 * research-dispatch v2.0.0 — DSH 设置面板（浏览器端 bundle）。
 *
 * 注册 settings.section 槽位，在 DSH 设置左栏提供「科研派工」独立设置页：
 *   - 评审（reviewVotes）：支持 codex / claude / dsh / gemini / api 自由增删，支持同一工具排多票对比不同模型，
 *     也允许不同工具使用同一模型（如实记录票源，不强行毁票）；
 *   - 发散（divergeCommand / divergeModel）：解锁全部有效执行者（默认 / codex / claude / dsh / gemini / api / kimi），
 *     联动对应执行者的模型选择器。
 */
window.__ModuleLoader__.load({
  id: "research-dispatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const NS = "research-dispatch";

    // ── 样式（规范见 docs/CARD-STYLE.md）─────────────────────────────────────
    const CSS = [
      ".rdp{max-width:720px;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}",
      ".rdp-head{display:flex;flex-direction:column;gap:4px}",
      ".rdp-title{margin:0;font-size:18px;font-weight:600;letter-spacing:.005em}",
      ".rdp-lead{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65;max-width:72ch}",
      ".rdp-state{margin-top:16px;padding:12px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65}",
      ".rdp-group{display:flex;flex-direction:column;margin-top:24px;padding-top:20px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-group-t{margin:0;font-size:15px;font-weight:600;letter-spacing:.005em}",
      ".rdp-group-d{margin:4px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65;max-width:66ch}",
      ".rdp-items{display:flex;flex-direction:column;margin-top:8px}",
      ".rdp-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-items .rdp-item:first-child{border-top:0}",
      ".rdp-item-full{grid-template-columns:minmax(0,1fr)}",
      ".rdp-item-main{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".rdp-label{font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px;min-width:0}",
      ".rdp-sub{display:flex;align-items:baseline;gap:4px;font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      ".rdp-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
      ".rdp code{font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;padding:0}",
      ".rdp-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-grid2{display:grid;grid-template-columns:132px 208px;gap:8px}",
      ".rdp-ctl-ghost{width:28px;height:28px;flex:0 0 auto}",
      ".rdp-in{font:inherit;font-size:12.5px;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);box-sizing:border-box;width:100%;transition:border-color .12s ease,box-shadow .12s ease}",
      ".rdp-in:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
      ".rdp-in:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-in:disabled{opacity:.55;cursor:default}",
      ".rdp-pick{position:relative;min-width:0}",
      ".rdp-pick-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease}",
      ".rdp-pick-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
      ".rdp-pick-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-pick-btn:disabled{opacity:.55;cursor:default}",
      ".rdp-pick-btn.is-open{border-color:var(--dsw-alias-brand-primary)}",
      ".rdp-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-pick-caret{flex:0 0 auto;font-size:9px;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-menu{position:absolute;z-index:40;top:calc(100% + 4px);right:0;width:max(268px,100%);max-height:326px;overflow:auto;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 28px rgba(0,0,0,.16)}",
      ".rdp-menu-search{display:block;width:100%;height:28px;margin:0 0 8px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;box-sizing:border-box}",
      ".rdp-menu-search:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".rdp-menu-empty{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-menu-sec+.rdp-menu-sec{margin-top:4px}",
      ".rdp-menu-cap{display:inline-flex;align-items:center;height:20px;margin:4px 8px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base,#fff);font-size:11px;font-weight:600;letter-spacing:.01em}",
      ".rdp-menu-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}",
      ".rdp-menu-item:hover,.rdp-menu-item.is-hi{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}",
      ".rdp-menu-item.is-sel{color:var(--dsw-alias-brand-primary);font-weight:500}",
      ".rdp-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-menu-tick{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-brand-primary)}",
      ".rdp-btn{font:inherit;font-size:12.5px;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:0 0 auto;transition:background-color .12s ease,color .12s ease,border-color .12s ease}",
      ".rdp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary)}",
      ".rdp-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-btn:disabled{opacity:.45;cursor:default}",
      ".rdp-btn-danger{height:28px;padding:0 8px;border-color:transparent;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-danger-fg,#d0554a);background:color-mix(in srgb,var(--dsw-alias-state-danger-fg,#d0554a) 9%,transparent)}",
      ".rdp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-button-primary-text,#fff)}",
      ".rdp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}",
      ".rdp-add-wrap{margin-top:8px}",
      ".rdp-add{width:100%;height:34px;border-style:dashed;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:transparent}",
      ".rdp-note{margin:8px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65}",
      ".rdp-empty{padding:8px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
      ".rdp-badge{font-size:10.5px;font-weight:500;padding:0 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}",
      ".rdp-foot{display:flex;align-items:center;gap:12px;margin-top:24px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-foot-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-right:auto}",
      ".rdp-foot-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-ok{color:var(--dsw-alias-state-success-fg,#4f9d6b)}",
      ".rdp-bad{color:var(--dsw-alias-state-danger-fg,#d0554a)}",
      ".rdp{container-type:inline-size}",
      "@container (max-width:560px){.rdp-item{grid-template-columns:minmax(0,1fr)}.rdp-item-full{grid-template-columns:minmax(0,1fr)}.rdp-ctl{justify-content:flex-start;width:100%}.rdp-grid2{grid-template-columns:1fr 1fr;width:100%}.rdp-ctl-ghost{display:none}}",
      "@media (max-width:560px){.rdp-item{grid-template-columns:minmax(0,1fr)}.rdp-ctl{justify-content:flex-start;width:100%}.rdp-grid2{grid-template-columns:1fr 1fr;width:100%}}",
      "@media (prefers-reduced-motion:reduce){.rdp *{transition:none!important}}",
    ].join("");

    let STYLE_TAG = null;
    function ensureStyleTag() {
      try {
        if (typeof document === "undefined" || !document || typeof document.querySelector !== "function") return;
        const existing = document.querySelector('style[data-plugin-css="research-dispatch"]');
        if (existing) {
          STYLE_TAG = existing;
          return;
        }
        if (document.head && typeof document.createElement === "function") {
          const tag = document.createElement("style");
          tag.dataset.plugin = "research-dispatch";
          tag.dataset.pluginCss = "research-dispatch";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          STYLE_TAG = tag;
        }
      } catch { /* 样式挂载失败不影响功能 */ }
    }
    ensureStyleTag();

    const diag = (typeof window !== "undefined")
      ? (window.__researchDispatch = window.__researchDispatch || { steps: [] })
      : { steps: [] };
    const STEP_CAP = 50;
    function pushStep(step) {
      diag.steps.push(step);
      if (diag.steps.length > STEP_CAP) diag.steps.splice(0, diag.steps.length - STEP_CAP);
    }
    pushStep("evaluated@" + Date.now());

    // ── 设置服务解析：可选子光纤 + 多路反射兜底，绝不阻塞插件启动 ────────
    let GATEWAY = null;
    const watchers = new Set();
    function notifyWatchers() {
      for (const fn of watchers) {
        try { fn(); } catch { /* 单个订阅者异常不影响其余监听器 */ }
      }
    }
    function setGateway(gw) {
      GATEWAY = gw;
      notifyWatchers();
    }

    function resolveSettings(remote, ctx) {
      const tries = [];
      try {
        const s1 = ctx && ctx.get ? ctx.get("remote.settings") : null;
        if (s1 && typeof s1.describe === "function") { diag.resolveVia = 'ctx.get("remote.settings")'; return s1; }
        tries.push("ctx.get(\"remote.settings\") → " + (s1 ? "不是设置 API" : "空"));
      } catch (e) { tries.push("ctx.get(\"remote.settings\"): " + e.message); }

      try {
        const ns = remote && remote.namespaces;
        const s2 = ns ? (ns.settings || (typeof ns.get === "function" ? ns.get("settings") : null)) : null;
        if (s2 && typeof s2.describe === "function") { diag.resolveVia = "remote.namespaces.settings"; return s2; }
        tries.push("remote.namespaces → " + (ns ? "存在但没有 settings" : "无"));
      } catch (e) { tries.push("remote.namespaces: " + e.message); }

      const cands = [
        ["remote.settings", () => remote.settings],
        ["remote.settingsController", () => remote.settingsController],
        ["remote 本身", () => remote],
      ];
      for (const [name, get] of cands) {
        try {
          const c = get();
          if (c && typeof c.describe === "function") { diag.resolveVia = name; return c; }
          tries.push(name + " → 无 describe");
        } catch (e) { tries.push(name + ": " + e.message); }
      }
      if (!diag.resolveTries) diag.resolveTries = tries;
      return null;
    }

    function gateway(ctx) {
      if (GATEWAY) return GATEWAY;
      try {
        const direct = ctx && ctx.remote && ctx.remote.settings;
        if (direct && typeof direct.describe === "function") {
          if (!diag.resolveVia) diag.resolveVia = "ctx.remote.settings（已声明）";
          return direct;
        }
        const svc = (ctx && ctx.remote) || (ctx && ctx.get ? ctx.get("remote") : null);
        const resolved = resolveSettings(svc, ctx);
        if (svc && !resolved && !diag.remoteKeys) {
          try { diag.remoteKeys = Object.keys(svc).slice(0, 40); } catch { diag.remoteKeys = "无法枚举"; }
        }
        if (svc && !diag.remoteType) {
          try { diag.remoteType = typeof svc + ":" + (svc.constructor && svc.constructor.name); } catch { /* 忽略 */ }
        }
        return resolved;
      } catch (e) { diag.gatewayError = String((e && e.message) || e); return null; }
    }

    async function unwrap(res, what) {
      if (res && typeof res === "object" && Object.prototype.hasOwnProperty.call(res, "ok")) {
        if (!res.ok) throw new Error(what + " 失败：" + ((res.error && res.error.message) || "未知错误"));
        return res.value;
      }
      return res;
    }

    async function readDescriptor(ctx) {
      const gw = gateway(ctx);
      if (!gw || typeof gw.describe !== "function") return null;
      const res = await gw.describe();
      if (res && typeof res === "object" && !Array.isArray(res) && !diag.describeShape) {
        try { diag.describeShape = Object.keys(res).slice(0, 12); } catch { /* 忽略 */ }
      }
      const value = await unwrap(res, "settings.describe");
      const list = Array.isArray(value) ? value
        : (value && Array.isArray(value.namespaces)) ? value.namespaces
        : (value && value.view && Array.isArray(value.view.namespaces)) ? value.view.namespaces
        : [];
      if (!diag.describeCount) diag.describeCount = list.length;
      const found = list.find((d) => d && d.ns === NS) || null;
      if (!found) {
        const err = new Error("设置服务已连通，但未找到 " + NS + " 配置项");
        err.code = "NS_MISSING";
        throw err;
      }
      return found;
    }

    async function writePatch(ctx, patch, revision) {
      const gw = gateway(ctx);
      if (!gw) throw new Error("当前连不上设置服务，无法保存");
      if (typeof gw.update === "function") return unwrap(await gw.update(NS, patch, revision), "settings.update");
      if (typeof gw.mutate === "function") {
        const ops = Object.keys(patch).map((k) => ({ op: "set", path: [k], value: patch[k] }));
        return unwrap(await gw.mutate(NS, ops, revision), "settings.mutate");
      }
      throw new Error("当前连不上设置服务，无法保存");
    }

    let USED_REFS = false;
    function propsFromSchema(schema) {
      if (!schema || typeof schema !== "object") return null;
      const refs = Array.isArray(schema.refs) ? null : schema.refs;
      if (refs && typeof refs === "object" && schema.uid !== undefined) {
        USED_REFS = true;
        const root = refs[String(schema.uid)] || refs[schema.uid];
        const dict = root && typeof root.dict === "object" ? root.dict : null;
        if (!dict) return null;
        const out = {};
        for (const key of Object.keys(dict)) {
          const sub = (refs[String(dict[key])] || refs[dict[key]]) || {};
          out[key] = sub.meta || {};
        }
        return out;
      }
      if (schema.properties && typeof schema.properties === "object") return schema.properties;
      return null;
    }

    const KNOWN_KEYS = [
      "repoRoot",
      "seatsFile",
      "otherStages",
      "stageOpinions",
      "reviewVotes",
      "executorCatalog",
      "divergeCommand",
      "divergeModel",
    ];

    const LABELS = {
      reviewVotes: "评审票",
      repoRoot: "工作流仓库根",
      seatsFile: "座位表路径",
      divergeCommand: "发散执行方式",
      divergeModel: "发散模型",
    };

    function fieldsOf(desc) {
      const props = propsFromSchema(desc && desc.schema);
      let keys;
      if (props) {
        keys = Object.keys(props);
      } else {
        const valKeys = Object.keys((desc && desc.value) || {});
        const seen = new Set();
        keys = [];
        for (const k of KNOWN_KEYS.concat(valKeys)) {
          if (k && !seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
      if (!diag.fieldKeys) diag.fieldKeys = keys.slice(0, 10);
      if (!diag.fieldSource) diag.fieldSource = props ? (USED_REFS ? "schema.refs" : "schema.properties") : "value+known keys";
      return keys.map((k) => {
        const meta = (props && props[k]) || {};
        return {
          key: k,
          title: meta.title || LABELS[k] || k,
          description: meta.description || "",
          default: meta.default,
        };
      });
    }

    const FALLBACK_FIELDS = [
      { key: "reviewVotes", title: "评审票", description: "几票对应几位评审员", default: "" },
      { key: "divergeCommand", title: "发散执行方式", description: "发散工具命令", default: "" },
      { key: "divergeModel", title: "发散模型", description: "发散工具模型", default: "" },
    ];

    const SEATS_HINT = "进阶：本页配置仅在当前桌面端内生效；若想固定某位评审员的默认设置或跨工具共享阵容，请在项目配置文件里单独指定。";
    const REVIEW_SEATS = ["codex", "claude", "dsh", "gemini", "api"];
    const DIVERGE_SEATS = ["codex", "claude", "dsh", "gemini", "api", "kimi"];

    let EXTRA_MODELS = null;
    function readModelDirectories(ctx) {
      if (EXTRA_MODELS !== null && Object.keys(EXTRA_MODELS).length > 0) return EXTRA_MODELS;
      try {
        const svc = ctx && ctx.get ? ctx.get("modelDirectories") : null;
        if (!svc) { EXTRA_MODELS = {}; return EXTRA_MODELS; }
        const snap = typeof svc.getSnapshot === "function" ? svc.getSnapshot() : svc;
        const out = {};
        const push = (exec, model) => {
          if (!exec || !model) return;
          out[exec] = out[exec] || [];
          if (!out[exec].includes(model)) out[exec].push(model);
        };
        const walk = (node, depth) => {
          if (!node || depth > 4) return;
          if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
          if (typeof node !== "object") return;
          const prov = node.provider || node.providerId || node.id;
          if (prov && Array.isArray(node.models)) {
            node.models.forEach((m) => push(String(prov), String(m.id || m.model || m.name || "")));
          }
          Object.values(node).forEach((v) => { if (v && typeof v === "object") walk(v, depth + 1); });
        };
        walk(snap, 0);
        EXTRA_MODELS = out;
        try { diag.modelDirsKeys = Object.keys(out).slice(0, 10); } catch { /* 忽略 */ }
        return out;
      } catch (e) {
        try { diag.modelDirsError = String((e && e.message) || e); } catch { /* 忽略 */ }
        EXTRA_MODELS = {};
        return EXTRA_MODELS;
      }
    }

    function catalogOf(value) {
      const raw = String((value && value.executorCatalog) || "");
      return raw.split(";").map((row) => {
        const i = row.indexOf(":");
        if (i < 0) return null;
        const exec = row.slice(0, i).trim();
        const models = row.slice(i + 1).split("|").map((x) => x.trim()).filter(Boolean);
        return exec ? { exec, models } : null;
      }).filter(Boolean);
    }

    function mergeCatalog(base, extra) {
      if (!extra) return base;
      const byExec = new Map(base.map((c) => [c.exec, { exec: c.exec, models: c.models.slice() }]));
      for (const [exec, models] of Object.entries(extra)) {
        const row = byExec.get(exec);
        if (!row) { byExec.set(exec, { exec, models: models.slice() }); continue; }
        for (const m of models) if (!row.models.includes(m)) row.models.push(m);
      }
      return [...byExec.values()];
    }

    let LIVE_GROUPS = null;
    let LIVE_CATALOG = null;

    function groupsToCatalog(groups) {
      const ids = [];
      for (const g of groups || []) {
        const prov = String((g && (g.id || g.name)) || "").trim();
        const ms = (g && Array.isArray(g.models)) ? g.models : [];
        for (const m of ms) {
          const mid = String((m && (m.id || m.name)) || "").trim();
          if (!prov || !mid) continue;
          const full = prov + "/" + mid;
          if (!ids.includes(full)) ids.push(full);
        }
      }
      return ids;
    }

    function setLiveGroups(groups) {
      LIVE_GROUPS = groups;
      const ids = groupsToCatalog(groups);
      LIVE_CATALOG = ids.length ? { dsh: ids.slice() } : null;
      notifyWatchers();
    }

    function panelCatalog(value, ctx) {
      const base = mergeCatalog(catalogOf(value), readModelDirectories(ctx))
        .filter((c) => c.exec !== "subagent");
      if (!LIVE_CATALOG) return base;
      const out = base.filter((c) => !Object.prototype.hasOwnProperty.call(LIVE_CATALOG, c.exec));
      for (const [exec, models] of Object.entries(LIVE_CATALOG)) {
        if (models.length) out.push({ exec, models: models.slice() });
      }
      return out;
    }

    function parseVoteRows(raw) {
      const text = String(raw || "").trim();
      if (!text) return [];
      return text.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const i = t.indexOf(":");
        return i < 0 ? { executor: t, model: "" } : { executor: t.slice(0, i).trim(), model: t.slice(i + 1).trim() };
      }).filter((r) => Boolean(r.executor));
    }

    function voteRows(value) {
      return parseVoteRows(value && value.reviewVotes);
    }

    function voteString(rows) {
      if (!rows || rows.length === 0) return "";
      return rows.map((r) => r.executor + ":" + (r.model || "")).join(",");
    }

    function groupedModels(exec, cat) {
      if (!exec) return [{ label: "", items: [] }];
      const flat = (cat.find((c) => c.exec === exec) || { models: [] }).models;
      if (LIVE_GROUPS && exec === "dsh") {
        const out = [];
        for (const g of LIVE_GROUPS) {
          const prov = String((g && (g.id || g.name)) || "").trim();
          const label = String((g && g.name) || prov).trim();
          const ms = (g && Array.isArray(g.models)) ? g.models : [];
          const items = ms.map((m) => ({
            value: prov + "/" + String((m && (m.id || m.name)) || ""),
            label: String((m && m.name) || (m && m.id) || "").trim(),
          })).filter((x) => x.value && x.label && x.label !== "undefined");
          if (prov && items.length) out.push({ label, items });
        }
        if (out.length) return out;
      }
      return [{ label: "", items: flat.map((m) => ({ value: m, label: m })) }];
    }

    function defaultModelLabel(exec, cat, fallback) {
      if (!exec) return fallback;
      for (const g of groupedModels(exec, cat)) {
        for (const it of g.items) {
          if (/kimi-k3/i.test(it.label)) return fallback;
          return "默认（" + it.label + "）";
        }
      }
      return fallback;
    }

    function flattenGroups(groups) {
      const items = [];
      for (const g of groups) for (const it of g.items) items.push(it);
      return items;
    }

    function modelMatch(it, needle) {
      const q = String(needle || "").trim().toLowerCase();
      if (!q) return true;
      const hay = (String(it.label || "") + " " + String(it.value || "")).toLowerCase();
      let i = 0;
      for (const ch of hay) {
        if (ch === q[i]) i += 1;
        if (i >= q.length) return true;
      }
      return false;
    }

    function filteredGroups(groups, q) {
      if (!String(q || "").trim()) return groups;
      const out = [];
      for (const g of groups) {
        const items = g.items.filter((it) => modelMatch(it, q));
        if (items.length) out.push({ label: g.label, items });
      }
      return out;
    }

    function menuProps(state, key, groups, value, onPick) {
      const { menu, setMenu } = state;
      const open = menu.key === key;
      const q = open ? String(menu.q || "") : "";
      const items = flattenGroups(filteredGroups(groups, q));
      const idxOf = (v) => {
        for (let i = 0; i < items.length; i++) if (items[i].value === v) return i;
        return -1;
      };
      const hi0 = Math.max(0, idxOf(value));
      return {
        open,
        q,
        showSearch: flattenGroups(groups).length > 4,
        hi: open ? Math.min(Math.max(0, menu.hi || 0), Math.max(0, items.length - 1)) : hi0,
        onOpen: () => setMenu({ key, hi: hi0, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key, hi: i, q }),
        onQuery: (v) => {
          const next = flattenGroups(filteredGroups(groups, v));
          const at = next.findIndex((it) => it.value === value);
          setMenu({ key, q: v, hi: at >= 0 ? at : 0 });
        },
        onMove: (d) => {
          const n = items.length;
          if (!n) return;
          const base = open ? (menu.hi || 0) : hi0;
          setMenu({ key, q, hi: ((base + d) % n + n) % n });
        },
        onPick: (v) => { setMenu({ key: null, hi: 0, q: "" }); onPick(v); },
      };
    }

    function ModelPicker(props) {
      const { value, groups, disabled, placeholder, open, hi, q, showSearch, onOpen, onClose, onMove, onHover, onPick, onQuery } = props;
      const all = flattenGroups(groups);
      const cur = all.filter((x) => x.value === value)[0];
      const label = cur ? cur.label : (value || placeholder);
      const view = filteredGroups(groups, q);
      const items = flattenGroups(view);
      const navKey = (e) => {
        const k = e && e.key;
        if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); onMove(k === "ArrowDown" ? 1 : -1); return; }
        if (k === "Escape") { e.preventDefault(); onClose(); return; }
        if (k === "Enter") {
          e.preventDefault();
          if (open && items[hi]) onPick(items[hi].value);
          else if (!open) onOpen();
        }
      };
      let list = null;
      if (open) {
        const rows = [];
        if (showSearch) {
          rows.push(h("input", {
            key: "__q__",
            className: "rdp-menu-search",
            type: "text",
            value: q,
            placeholder: "搜索模型",
            autoFocus: true,
            onChange: (e) => onQuery(e.target.value),
            onKeyDown: navKey,
          }));
        }
        if (!items.length) {
          rows.push(h("div", { key: "__empty__", className: "rdp-menu-empty" }, "没有匹配的模型"));
        } else {
          view.forEach((g, gi) => {
            rows.push(h("div", { className: "rdp-menu-sec", key: "sec:" + gi },
              g.label ? h("div", { className: "rdp-menu-cap" }, g.label) : null,
              g.items.map((it) => {
                const idx = items.indexOf(it);
                const sel = it.value === value;
                return h("button", {
                  type: "button",
                  key: it.value,
                  className: "rdp-menu-item" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
                  role: "option",
                  "aria-selected": sel ? "true" : "false",
                  title: it.value,
                  onMouseEnter: () => onHover(idx),
                  onClick: () => onPick(it.value),
                },
                  h("span", { className: "rdp-menu-name" }, it.label),
                  sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, "✓") : null);
              })));
          });
        }
        list = h("div", { className: "rdp-menu", role: "listbox" }, rows);
      }
      return h("div", { className: "rdp-pick" },
        h("button", {
          type: "button",
          disabled: !!disabled,
          className: "rdp-pick-btn" + (open ? " is-open" : ""),
          "aria-haspopup": "listbox",
          "aria-expanded": open ? "true" : "false",
          onClick: () => (open ? onClose() : onOpen()),
          onKeyDown: (e) => {
            if (e && e.key === " ") {
              e.preventDefault();
              if (open) { if (items[hi]) onPick(items[hi].value); } else onOpen();
              return;
            }
            navKey(e);
          },
        },
          h("span", { className: "rdp-pick-label" }, label),
          h("span", { className: "rdp-pick-caret", "aria-hidden": "true" }, "▾")),
        list);
    }

    function pickerNode(state, key, exec, cat, value, disabled, placeholder, onPick) {
      const groups = groupedModels(exec, cat);
      return ModelPicker(Object.assign(
        { value, groups, disabled, placeholder },
        menuProps(state, key, groups, value, onPick),
      ));
    }

    function Page(props) {
      const ctx = props.ctx;
      const [st, setSt] = React.useState({ phase: "loading" });
      const [draft, setDraft] = React.useState({});
      const [phase, setPhase] = React.useState("idle");
      const [menu, setMenu] = React.useState({ key: null, hi: 0, q: "" });
      const [tracker] = React.useState(() => ({ phase: "loading", reqSeq: 0 }));

      const updateSt = (next) => {
        tracker.phase = next.phase;
        setSt(next);
      };

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const clearLoadTimer = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
        const runLoad = () => {
          const seq = ++tracker.reqSeq;
          readDescriptor(ctx)
            .then((d) => {
              if (!alive || seq !== tracker.reqSeq) return;
              clearLoadTimer();
              if (d) updateSt({ phase: "ready", desc: d });
              else updateSt({ phase: "nogw", why: "连不上设置服务" });
            })
            .catch((e) => {
              if (!alive || seq !== tracker.reqSeq) return;
              clearLoadTimer();
              if (e && e.code === "NS_MISSING") updateSt({ phase: "nons", why: String(e.message || e) });
              else updateSt({ phase: "nogw", why: String((e && e.message) || e) });
            });
        };
        watchers.add(runLoad);
        timer = setTimeout(() => {
          timer = null;
          if (!alive || tracker.phase !== "loading") return;
          tracker.reqSeq += 1;
          updateSt({ phase: "nogw", why: "设置服务 3 秒内没有返回" });
        }, 3000);
        runLoad();
        return () => {
          alive = false;
          clearLoadTimer();
          watchers.delete(runLoad);
        };
      }, []);

      const desc = st.phase === "ready" ? st.desc : null;
      const value = (desc && desc.value) || {};
      const user = (desc && desc.user) || {};
      const live = !!desc;
      const allFields = live ? fieldsOf(desc) : FALLBACK_FIELDS;
      const fields = allFields;
      const HIDDEN = new Set([
        "executorCatalog",
        "otherStages",
        "repoRoot",
        "seatsFile",
        "stageOpinions",
        "seatOverrides",
        "seatRoster",
        "defaultBackends",
      ]);
      const DEDICATED = new Set(["reviewVotes", "divergeCommand", "divergeModel"]);
      const otherFields = allFields.filter((f) => !HIDDEN.has(f.key) && !DEDICATED.has(f.key));
      const text = (f) => (draft[f.key] !== undefined ? draft[f.key] : String(value[f.key] === undefined ? "" : value[f.key]));
      const dirty = live && fields.some((f) => draft[f.key] !== undefined && draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key]));

      React.useEffect(() => {
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        const onDocDown = (e) => {
          const t = e && e.target;
          if (t && typeof t.closest === "function" && t.closest(".rdp-pick")) return;
          setMenu({ key: null, hi: 0, q: "" });
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
      }, [menu.key]);

      const save = () => {
        if (!live) return;
        const patch = {};
        for (const f of fields) {
          if (draft[f.key] === undefined) continue;
          if (draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key])) patch[f.key] = draft[f.key];
        }
        if (Object.keys(patch).length === 0) { setDraft({}); return; }
        const seq = ++tracker.reqSeq;
        setPhase("saving");
        writePatch(ctx, patch, desc.revision)
          .then(() => readDescriptor(ctx))
          .then((d) => {
            if (seq === tracker.reqSeq && d) updateSt({ phase: "ready", desc: d });
            setDraft({});
            setPhase("saved");
          })
          .catch((e) => setPhase("failed:" + ((e && e.message) || e)));
      };

      const cat = panelCatalog(value, ctx);

      return h("div", { className: "rdp" },
        h("div", { className: "rdp-head", key: "head" },
          h("h2", { className: "rdp-title" }, "科研派工 · 评审与发散"),
          h("p", { className: "rdp-lead" }, "自由选择评审与发散所用的工具及各自模型（支持同一工具排多票对比不同模型，也允许跨工具使用同一模型，如实记录票源）。改完保存即可，下一轮生效。")),
        live ? null : h("div", { className: "rdp-state", key: "state" },
          st.phase === "loading"
            ? "正在连接设置服务…（首次打开会慢一点）"
            : st.phase === "nons"
              ? "设置服务连上了，但本页暂时没有可编辑项。先用默认设置即可；需要改动时请参考项目说明。"
              : "连不上设置服务（原因：" + st.why + "），这一页只能看说明、不能修改。稍后重试，或检查桌面端是否正常运行。"),
        h("div", { className: "rdp-group", key: "sec-review" },
          h("h3", { className: "rdp-group-t" }, "评审"),
          h("p", { className: "rdp-group-d" }, "每条想法交给几位评审员独立打分，自动汇总横向对比表供你裁决。排几票就有几位评审员（可重复选同一工具配不同或相同模型）；一票都不排，就按配置文件里的默认阵容。")),
        (() => {
          const rows = draft.reviewVotes !== undefined ? parseVoteRows(draft.reviewVotes) : voteRows(value);
          const apply = (next) => setDraft({ ...draft, reviewVotes: voteString(next) });
          const hasReviewCatalog = cat.some((c) => REVIEW_SEATS.includes(c.exec));
          const nextSeat = () => {
            const used = new Set(rows.map((r) => r.executor));
            for (const s of REVIEW_SEATS) {
              if (!used.has(s)) return s;
            }
            return REVIEW_SEATS[rows.length % REVIEW_SEATS.length];
          };
          return h("div", { key: "votes" },
            h("div", { className: "rdp-items" },
              rows.length === 0
                ? h("div", { className: "rdp-empty", key: "empty-votes" },
                  "当前未单独排票，将按配置文件里的默认评审阵容运行。点下方「+ 加一票」可自由添加评审员。")
                : rows.map((row, idx) => {
                  const seatOptions = (row.executor && row.executor !== "subagent" && !REVIEW_SEATS.includes(row.executor))
                    ? REVIEW_SEATS.concat([row.executor])
                    : REVIEW_SEATS;
                  return h("div", { className: "rdp-item", key: "v" + idx },
                    h("div", { className: "rdp-item-main" },
                      h("span", { className: "rdp-label" }, "票 " + (idx + 1)),
                      h("span", { className: "rdp-sub" }, "当前 ", h("code", null, row.executor + " · " + (row.model || "默认")))),
                    h("div", { className: "rdp-ctl" },
                      h("div", { className: "rdp-grid2" },
                        h("select", {
                          className: "rdp-in",
                          disabled: !live,
                          value: row.executor,
                          onChange: (e) => apply(rows.map((r, i) => (i === idx ? { executor: e.target.value, model: "" } : r))),
                        },
                          seatOptions.map((exec) => h("option", { key: exec, value: exec }, exec))),
                        pickerNode({ menu, setMenu }, "vote:" + idx, row.executor, cat, row.model, !live,
                          defaultModelLabel(row.executor, cat, "默认（用它自己的默认模型）"),
                          (m) => apply(rows.map((r, i) => (i === idx ? { ...r, model: m } : r))))),
                      h("button", {
                        type: "button",
                        className: "rdp-btn rdp-btn-danger",
                        disabled: !live,
                        title: "删除票 " + (idx + 1),
                        onClick: () => apply(rows.filter((_, i) => i !== idx)),
                      }, "删除")));
                }),
              live && !hasReviewCatalog ? h("div", { className: "rdp-empty", key: "nocat" },
                "没有找到可用的评审员清单。票仍然可以保存，实际由系统按默认安排。") : null),
            h("div", { className: "rdp-add-wrap", key: "add" },
              h("button", {
                type: "button",
                className: "rdp-btn rdp-add",
                disabled: !live,
                onClick: () => apply(rows.concat([{ executor: nextSeat(), model: "" }])),
              }, "+ 加一票")),
          );
        })(),
        h("p", { className: "rdp-note", key: "seats-hint" }, SEATS_HINT),
        h("div", { className: "rdp-group", key: "sec-diverge" },
          h("h3", { className: "rdp-group-t" }, "发散"),
          h("p", { className: "rdp-group-d" }, "结合文献卡片池与过往死胡同产出一批独立候选想法。可自由任选下方任意工具与模型；留空则按配置文件里的默认安排。")),
        (() => {
          const curExec = draft.divergeCommand !== undefined
            ? draft.divergeCommand
            : String(value.divergeCommand === undefined ? "" : value.divergeCommand);
          const curModel = draft.divergeModel !== undefined
            ? draft.divergeModel
            : String(value.divergeModel === undefined ? "" : value.divergeModel);
          const divergeExecOptions = [{ value: "", label: "默认（按配置）" }]
            .concat(DIVERGE_SEATS.map((exec) => ({ value: exec, label: exec })));
          if (curExec && curExec !== "subagent" && !DIVERGE_SEATS.includes(curExec)) {
            divergeExecOptions.push({ value: curExec, label: curExec });
          }
          const modelPlaceholder = curExec
            ? defaultModelLabel(curExec, cat, "默认（用它自己的默认模型）")
            : "默认（随所选工具）";
          return h("div", { className: "rdp-items", key: "diverge" },
            h("div", { className: "rdp-item" },
              h("div", { className: "rdp-item-main" },
                h("span", { className: "rdp-label" }, "由谁发散"),
                h("span", { className: "rdp-sub" }, "当前 ", h("code", null, (curExec || "默认（按配置）") + " · " + (curModel || "默认")))),
              h("div", { className: "rdp-ctl" },
                h("div", { className: "rdp-grid2" },
                  h("select", {
                    className: "rdp-in",
                    disabled: !live,
                    value: curExec,
                    onChange: (e) => setDraft({ ...draft, divergeCommand: e.target.value, divergeModel: "" }),
                  },
                    divergeExecOptions.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
                  pickerNode({ menu, setMenu }, "diverge", curExec, cat, curModel, !live || !curExec,
                    modelPlaceholder,
                    (m) => setDraft({ ...draft, divergeModel: m }))))));
        })(),
        otherFields.length === 0 ? null : h("div", { className: "rdp-group", key: "adv" },
          h("h3", { className: "rdp-group-t" }, "高级项"),
          h("p", { className: "rdp-group-d" }, "这里是没有专用控件的项目，日常不用修改；仓库位置这类内部设置不在页面上展开。")),
        otherFields.map((f) => h("div", { className: "rdp-item rdp-item-full", key: f.key },
          h("div", { className: "rdp-item-main" },
            h("span", { className: "rdp-label" }, f.title,
              live && Object.prototype.hasOwnProperty.call(user, f.key) ? h("span", { className: "rdp-badge" }, "已覆盖") : null),
            h("input", {
              className: "rdp-in",
              type: "text",
              disabled: !live,
              value: text(f),
              placeholder: live ? String(f.default === undefined ? "" : f.default) : "（当前不可编辑）",
              onChange: (e) => setDraft({ ...draft, [f.key]: e.target.value }),
            }),
            f.description ? h("span", { className: "rdp-meta" }, f.description) : null),
        )),
        h("div", { className: "rdp-foot", key: "foot" },
          h("span", { className: "rdp-foot-msg" },
            phase === "saved" ? h("span", { className: "rdp-ok" }, "已保存，下一轮生效")
              : phase.indexOf("failed") === 0 ? h("span", { className: "rdp-bad" }, "保存失败：" + phase.slice(7))
              : (live ? "" : "当前不可编辑，保存不可用")),
          h("div", { className: "rdp-foot-ctl" },
            h("button", {
              className: "rdp-btn",
              type: "button",
              disabled: !dirty || phase === "saving",
              onClick: () => { setDraft({}); setPhase("idle"); },
            }, "放弃"),
            h("button", {
              className: "rdp-btn rdp-primary",
              type: "button",
              disabled: !dirty || phase === "saving",
              onClick: save,
            }, phase === "saving" ? "保存中" : "保存")),
        ),
      );
    }

    const name = "research-dispatch";
    const inject = ["slots", "remote", "remote.settings"];

    function apply(ctx) {
      ensureStyleTag();
      GATEWAY = null;

      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "research-dispatch",
          order: 40,
          label: () => "科研派工",
        }, (p) => h(Page, { ...p, ctx })));
        diag.registered = true;
      } catch (e) {
        diag.error = String((e && e.message) || e);
        console.warn("[research-dispatch] 设置面板注册失败，已跳过：" + (e && e.message));
        return;
      }

      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["remote"], (child) => {
            try {
              const svc = child && child.remote;
              const resolved = resolveSettings(svc, child);
              setGateway(resolved);
              diag.remoteViaInject = !!resolved;
              if (svc && !resolved) {
                try { diag.remoteKeysViaInject = Object.keys(svc).slice(0, 40); } catch { /* 忽略 */ }
              }
              const clearGw = () => { if (GATEWAY === resolved) setGateway(null); };
              if (child && typeof child.on === "function") child.on("dispose", clearGw);
              else if (child && typeof child.effect === "function") child.effect(() => clearGw);
            } catch (e) {
              diag.remoteInjectError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) {
        diag.injectError = String((e && e.message) || e);
      }

      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["remote.session"], (child) => {
            try {
              const svc = (child && child["remote.session"])
                || (child && typeof child.get === "function" ? child.get("remote.session") : null)
                || (child && child.remote && child.remote.session);
              if (!svc || typeof svc.modelCatalog !== "function") {
                diag.liveCatalogError = "modelCatalog 不可用";
                return;
              }
              svc.modelCatalog().then((res) => {
                if (!res || res.ok !== true || !res.value || !Array.isArray(res.value.groups)) {
                  diag.liveCatalogError = "modelCatalog 返回形状不对";
                  return;
                }
                diag.liveCatalog = res.value.groups
                  .map((g) => String((g && (g.id || g.name)) || "?") + ":" + ((g && g.models) || []).length)
                  .join(";");
                setLiveGroups(res.value.groups);
              }).catch((e) => { diag.liveCatalogError = String((e && e.message) || e); });
            } catch (e) {
              diag.liveCatalogError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) { diag.liveCatalogError = String((e && e.message) || e); }

      const onDispose = () => {
        try { if (STYLE_TAG && typeof STYLE_TAG.remove === "function") STYLE_TAG.remove(); } catch { /* 已移除 */ }
        STYLE_TAG = null;
        GATEWAY = null;
        EXTRA_MODELS = null;
      };
      try {
        if (typeof ctx.effect === "function") ctx.effect(() => onDispose);
        else if (typeof ctx.on === "function") ctx.on("dispose", onDispose);
      } catch (e) { diag.effectError = String((e && e.message) || e); }

      try { pushStep("apply@" + Date.now()); } catch { /* 探针失败不影响功能 */ }
      try { diag.inject = inject.slice(); } catch { /* 同上 */ }
      try { diag.slots = !!(ctx && ctx.slots); } catch { /* 同上 */ }
      try { diag.remoteReachable = !!(ctx && ctx.get && ctx.get("remote")); } catch { /* 同上 */ }
    }

    module.exports = {
      name,
      inject,
      apply,
      __test: {
        readDescriptor,
        writePatch,
        fieldsOf,
        propsFromSchema,
        catalogOf,
        mergeCatalog,
        readModelDirectories,
        groupsToCatalog,
        panelCatalog,
        setLiveGroups,
        groupedModels,
        flattenGroups,
        modelMatch,
        filteredGroups,
        messagePlaceholder: null,
        ModelPicker,
        menuProps,
        liveGroups: () => LIVE_GROUPS,
        resetLiveCatalog: () => { LIVE_GROUPS = null; LIVE_CATALOG = null; },
        resetModelDirs: () => { EXTRA_MODELS = null; },
        REVIEW_SEATS,
        DIVERGE_SEATS,
        SEATS_HINT,
        CSS: () => CSS,
      },
      default: { name, inject, apply },
    };
    return module.exports;
  },
});
