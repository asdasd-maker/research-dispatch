/**
 * research-dispatch v2.3.0 — DSH 全流程阵容编排工作台 & Antigravity /swarm 科研拓扑星图（浏览器与桌面端双栖 bundle）。
 *
 * 设计准则（对齐 dsh-claude-style 温润极简工艺 + @deepseek-ai/dsh-client-ui-primitives 原语复用）：
 *   1. 安全加载 `@deepseek-ai/dsh-client-ui-primitives`，在离线 Node 自检/预览沙箱中提供同构 1.5px 描边 SVG 与无障碍 HTML 兜底；
 *   2. 零原生 `<select>`、零 Unicode 伪图标（▾/✓/✦/●/↻/👤）、零刺眼渐变与大面积扩散阴影，所有数值启用 `tabular-nums`；
 *   3. 严格保持 `inject = ["slots", "remote", "remote.settings"]` 与四槽位注册顺序（`settings.section` 殿后）；
 *   4. `/swarm` 科研拓扑画布支持滚轮缩放（0.65x–1.65x）、背景拖拽平移与右下角悬浮控制条，保留 Electron RPC + Web HTTP 双栈桥。
 */
window.__ModuleLoader__.load({
  id: "research-dispatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;

    let Prim = null;
    try {
      Prim = require("@deepseek-ai/dsh-client-ui-primitives");
    } catch {
      Prim = null;
    }

    function setPrimitives(nextPrim) {
      Prim = nextPrim || null;
    }
    function getPrimitives() {
      return Prim;
    }

    const NS = "research-dispatch";
    const RPC_CHANNEL = "/api";
    const RPC_EXEC_METHOD = "research-dispatch/executors";
    const RPC_SWARM_METHOD = "research-dispatch/swarm-state";
    const RPC_ACTION_METHOD = "research-dispatch/action";
    const BRIDGE_EXEC_PATH = "/api/research-dispatch/executors";
    const BRIDGE_SWARM_PATH = "/api/research-dispatch/swarm-state";
    const BRIDGE_ACTION_PATH = "/api/research-dispatch/action";

    function isRenderableComp(c) {
      return typeof c === "function" || (Boolean(c) && typeof c === "object" && Boolean(c.$$typeof));
    }

    // ── 原语与 1.5px 矢量图标同构封装（Prim 存在走官方原语，离线沙箱走语义 HTML/SVG 兜底）──
    function UiIcon(primName, fallbackPaths, size, className) {
      const sz = Number(size) || 16;
      const cls = className ? String(className) : "";
      const Comp = primName && Prim && isRenderableComp(Prim[primName]) ? Prim[primName] : null;
      if (Comp) {
        return h("span", {
          className: ("rdp-ico-wrap " + cls).trim(),
          "aria-hidden": "true",
        }, h(Comp, { size: sz }));
      }
      return h("svg", {
        width: sz,
        height: sz,
        viewBox: "0 0 16 16",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: ("rdp-svg-ico " + cls).trim(),
        "aria-hidden": "true",
      }, fallbackPaths);
    }

    const ICO = {
      folder: (sz, cls) => UiIcon("IconFolderOpenOutline16", [
        h("path", { key: "p1", d: "M2 4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.3 1.5H12.5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5V4.5Z" }),
        h("path", { key: "p2", d: "M2.3 6.8h11.4" }),
      ], sz || 14, cls),
      refresh: (sz, cls) => UiIcon("IconRefreshOutline14", [
        h("path", { key: "p1", d: "M13.2 5.4A5.5 5.5 0 0 0 3.4 4.8L2.5 6" }),
        h("path", { key: "p2", d: "M2.3 3.2V6h2.8" }),
        h("path", { key: "p3", d: "M2.8 10.6a5.5 5.5 0 0 0 9.8.6l.9-1.2" }),
        h("path", { key: "p4", d: "M13.7 12.8V10h-2.8" }),
      ], sz || 14, cls),
      search: (sz, cls) => UiIcon("IconSearchOutline16", [
        h("circle", { key: "c", cx: 7.2, cy: 7.2, r: 4.4 }),
        h("path", { key: "p", d: "M10.5 10.5L13.6 13.6" }),
      ], sz || 14, cls),
      chevronDown: (sz, cls) => UiIcon("IconChevronDownOutline14", [
        h("path", { key: "p", d: "M4.2 6.2L8 10l3.8-3.8" }),
      ], sz || 14, cls),
      check: (sz, cls) => UiIcon("IconCheckOutline14", [
        h("path", { key: "p", d: "M3.3 8.4l3.1 3.1 6.3-6.6" }),
      ], sz || 14, cls),
      plus: (sz, cls) => UiIcon("IconPlusOutline16", [
        h("path", { key: "p", d: "M8 3.3v9.4M3.3 8h9.4" }),
      ], sz || 14, cls),
      minus: (sz, cls) => UiIcon(null, [
        h("path", { key: "p", d: "M3.5 8h9" }),
      ], sz || 14, cls),
      close: (sz, cls) => UiIcon("IconCloseOutline16", [
        h("path", { key: "p", d: "M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" }),
      ], sz || 14, cls),
      trash: (sz, cls) => UiIcon("IconTrashOutline16", [
        h("path", { key: "p1", d: "M3 4.5h10" }),
        h("path", { key: "p2", d: "M6.2 4.5V3.2h3.6v1.3" }),
        h("path", { key: "p3", d: "M4.4 4.5l.6 8.3h6l.6-8.3" }),
      ], sz || 14, cls),
      sparkle: (sz, cls) => UiIcon("IconSparkle16", [
        h("path", { key: "p", d: "M8 2.2l1.4 4.1 4.1 1.4-4.1 1.4L8 13.2 6.6 9.1 2.5 7.7l4.1-1.4L8 2.2Z" }),
      ], sz || 13, cls),
      branch: (sz, cls) => UiIcon("IconBranchOutline16", [
        h("circle", { key: "c1", cx: 4.5, cy: 4, r: 1.7 }),
        h("circle", { key: "c2", cx: 4.5, cy: 12, r: 1.7 }),
        h("circle", { key: "c3", cx: 11.5, cy: 6.5, r: 1.7 }),
        h("path", { key: "p", d: "M4.5 5.7v4.6M6.2 4.5c2.2 0 2.5 2 3.6 2" }),
      ], sz || 14, cls),
      shield: (sz, cls) => UiIcon("IconShieldOutline16", [
        h("path", { key: "p", d: "M8 2.2l4.8 1.9v3.8c0 3.1-2 5.1-4.8 6.1-2.8-1-4.8-3-4.8-6.1V4.1L8 2.2Z" }),
      ], sz || 14, cls),
      lock: (sz, cls) => UiIcon(null, [
        h("rect", { key: "r", x: 3.5, y: 7.2, width: 9, height: 6.2, rx: 1.5 }),
        h("path", { key: "p", d: "M5.3 7.2V5.3a2.7 2.7 0 0 1 5.4 0v1.9" }),
      ], sz || 12, cls),
      resetView: (sz, cls) => UiIcon("IconFullscreenOutline16", [
        h("path", { key: "p1", d: "M2.8 5.8V2.8h3M10.2 2.8h3v3M13.2 10.2v3h-3M5.8 13.2h-3v-3" }),
      ], sz || 14, cls),
      help: (sz, cls) => UiIcon(null, [
        h("circle", { key: "c", cx: 8, cy: 8, r: 6.1 }),
        h("path", { key: "q", d: "M6.2 6.1a1.9 1.9 0 0 1 3.6.7c0 1.2-1.8 1.4-1.8 2.6" }),
        h("circle", { key: "d", cx: 8, cy: 11.7, r: 0.55, fill: "currentColor", stroke: "none" }),
      ], sz || 13, cls),
    };

    function UiStateDot(props) {
      const state = (props && props.state) || "idle";
      const size = (props && props.size) || 8;
      const className = (props && props.className) || "";
      if (Prim && isRenderableComp(Prim.StateDot)) {
        return h(Prim.StateDot, { state, size, className });
      }
      return h("span", {
        className: ("rdp-sdot st-" + state + " " + className).trim(),
        "data-state": state,
        style: { width: size, height: size },
        "aria-hidden": "true",
      });
    }

    function UiTag(props, ...restKids) {
      const tone = (props && props.tone) || "outline";
      const className = (props && props.className) || "";
      const children = restKids.length > 1 ? restKids : (restKids.length === 1 ? restKids[0] : (props && props.children));
      if (Prim && isRenderableComp(Prim.Tag)) {
        return h(Prim.Tag, { tone, className }, children);
      }
      return h("span", {
        className: ("rdp-utag tone-" + tone + " " + className).trim(),
        "data-tone": tone,
      }, children);
    }

    function positionHelpPop(wrapEl, preferredSide) {
      if (!wrapEl || typeof wrapEl.querySelector !== "function" || typeof wrapEl.getBoundingClientRect !== "function") return;
      const pop = wrapEl.querySelector(".rdp-help-pop");
      if (!pop) return;
      const rect = wrapEl.getBoundingClientRect();
      const vw = (typeof window !== "undefined" && window.innerWidth) ? window.innerWidth : 1280;
      const vh = (typeof window !== "undefined" && window.innerHeight) ? window.innerHeight : 800;
      const maxW = Math.min(260, Math.max(180, vw - 24));
      pop.style.maxWidth = maxW + "px";
      const popW = pop.offsetWidth || maxW;
      const popH = pop.offsetHeight || 56;
      const roomTop = rect.top - 12;
      const roomBottom = vh - rect.bottom - 12;
      const place = preferredSide === "bottom"
        ? (roomBottom >= popH || roomBottom >= roomTop ? "bottom" : "top")
        : (roomTop < popH && roomBottom > roomTop ? "bottom" : "top");
      const left = Math.max(12, Math.min(vw - popW - 12, rect.left + rect.width / 2 - popW / 2));
      const rawTop = place === "bottom"
        ? Math.min(vh - popH - 12, Math.round(rect.bottom + 7))
        : Math.max(popH + 12, Math.round(rect.top - 7));
      pop.style.left = Math.round(left) + "px";
      pop.style.top = Math.round(rawTop) + "px";
      pop.style.transform = place === "bottom" ? "translateY(0)" : "translateY(-100%)";
    }

    let ACTIVE_HELP_WRAP = null;
    let ACTIVE_HELP_SIDE = "top";
    let HELP_REPOS_BOUND = false;

    function ensureHelpRepositionListeners() {
      if (HELP_REPOS_BOUND || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
      HELP_REPOS_BOUND = true;
      const syncActive = () => {
        if (ACTIVE_HELP_WRAP && (typeof document === "undefined" || document.contains(ACTIVE_HELP_WRAP))) {
          positionHelpPop(ACTIVE_HELP_WRAP, ACTIVE_HELP_SIDE);
        } else {
          ACTIVE_HELP_WRAP = null;
        }
      };
      window.addEventListener("scroll", syncActive, true);
      window.addEventListener("resize", syncActive, { passive: true });
    }

    function UiHelpTip(text, label, side) {
      const tip = String(text || "").trim();
      if (!tip) return null;
      const aria = String(label || "查看说明");
      const placement = side === "right" || side === "bottom" ? side : "top";
      const btn = h("button", {
        type: "button",
        className: "rdp-help-btn",
        "aria-label": aria,
        onKeyDown: (e) => { if (e && e.key === "Escape" && e.currentTarget && typeof e.currentTarget.blur === "function") e.currentTarget.blur(); },
      }, ICO.help(13));
      if (Prim && isRenderableComp(Prim.Tooltip)) {
        return h(Prim.Tooltip, { label: tip, side: placement, maxWidth: 260 }, btn);
      }
      const activateTip = (e) => {
        const el = e && e.currentTarget;
        if (!el) return;
        ACTIVE_HELP_WRAP = el;
        ACTIVE_HELP_SIDE = placement;
        ensureHelpRepositionListeners();
        positionHelpPop(el, placement);
      };
      const deactivateTip = (e) => {
        if (ACTIVE_HELP_WRAP && e && e.currentTarget === ACTIVE_HELP_WRAP) {
          ACTIVE_HELP_WRAP = null;
        }
      };
      return h("span", {
        className: "rdp-help-wrap",
        "data-tip-side": placement,
        onMouseEnter: activateTip,
        onFocus: activateTip,
        onMouseLeave: deactivateTip,
        onBlur: deactivateTip,
      },
        btn,
        h("span", { className: "rdp-help-pop", role: "tooltip" }, tip));
    }

    function UiSwitch(props) {
      const checked = Boolean(props && props.checked);
      const onChange = props && props.onChange;
      const label = String((props && props.label) || "切换开关");
      const disabled = Boolean(props && props.disabled);
      const title = props && props.title;
      const className = (props && props.className) || "";
      if (Prim && isRenderableComp(Prim.Switch)) {
        return h(Prim.Switch, {
          checked,
          onChange: (nextBool) => { if (!disabled && typeof onChange === "function") onChange(Boolean(nextBool)); },
          label,
          disabled,
          title,
          className,
        });
      }
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label,
        title,
        disabled,
        className: ("rdp-switch" + (checked ? " is-on" : "") + (className ? " " + className : "")).trim(),
        onClick: () => { if (!disabled && typeof onChange === "function") onChange(!checked); },
      }, h("span", { className: "rdp-switch-thumb", "aria-hidden": "true" }));
    }

    function UiButton(props, ...restKids) {
      const p = props || {};
      const variant = p.variant || "outline";
      const size = p.size || "md";
      const icon = p.icon;
      const className = p.className || "";
      const children = restKids.length > 1 ? restKids : (restKids.length === 1 ? restKids[0] : p.children);
      const rest = {};
      const skip = { variant: 1, size: 1, icon: 1, className: 1, children: 1 };
      for (const k of Object.keys(p)) {
        if (!skip[k]) rest[k] = p[k];
      }
      if (Prim && isRenderableComp(Prim.Button)) {
        const primProps = Object.assign({ variant, size, className }, rest);
        if (icon) primProps.icon = icon;
        return h(Prim.Button, primProps, children);
      }
      const fallbackCls = [
        "rdp-btn",
        variant === "primary" ? "rdp-primary" : "",
        variant === "ghost" ? "rdp-btn-ghost" : "",
        size === "sm" ? "rdp-btn-sm" : "",
        className,
      ].filter(Boolean).join(" ");
      const btnProps = Object.assign({ type: "button", className: fallbackCls }, rest);
      if (icon) {
        return h("button", btnProps, h("span", { className: "rdp-btn-ico", "aria-hidden": "true" }, icon), children);
      }
      return h("button", btnProps, children);
    }

    function resolveDirectoryPicker(ctx) {
      if (!ctx) return null;
      try {
        const ws = ctx.uiWorkspace || (typeof ctx.get === "function" ? ctx.get("uiWorkspace") : null);
        if (ws && typeof ws.pickDirectory === "function") {
          return () => ws.pickDirectory();
        }
      } catch { /* cordis 未声明服务抛异常时静默跳过 */ }
      try {
        const rem = ctx.remote || (typeof ctx.get === "function" ? ctx.get("remote") : null);
        const dp = rem && rem.directoryPicker;
        if (dp && typeof dp.pick === "function") {
          return async () => {
            const res = await dp.pick();
            if (!res || res.ok === false) return null;
            return res.value === undefined ? null : res.value;
          };
        }
      } catch { /* 静默跳过 */ }
      return null;
    }

    // ── dsh-claude-style 温润极简工作台 & /swarm 交互拓扑样式（纯 --dsw-alias-* 语义令牌）──
    const CSS = [
      ".rdp{max-width:960px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#141413);font-size:13px;line-height:1.58;container-type:inline-size;padding-bottom:20px}",
      ".rdp.is-swarm{max-width:1240px}",
      ".rdp-num{font-variant-numeric:tabular-nums lining-nums}",
      ".rdp-ico-wrap,.rdp-btn-ico{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;line-height:0}",
      ".rdp-svg-ico{display:block;flex:0 0 auto}",
      ".rdp-sdot{display:inline-block;border-radius:999px;flex:0 0 auto;background:var(--dsw-alias-label-tertiary,#87867f)}",
      ".rdp-sdot.st-done{background:var(--dsw-alias-state-success-primary,#10b981)}",
      ".rdp-sdot.st-ongoing{background:var(--dsw-alias-brand-primary,#c96442);animation:rdpPulse 1.6s ease-in-out infinite}",
      ".rdp-sdot.st-warning{background:var(--dsw-alias-state-warn-primary,#d97706)}",
      ".rdp-sdot.st-error,.rdp-sdot.st-failed{background:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".rdp-utag{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:550;line-height:1;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.26));background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.08));color:var(--dsw-alias-label-secondary,#5e5d59)}",
      ".rdp-utag.tone-quiet{border-color:transparent;background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.10));color:var(--dsw-alias-label-secondary,#5e5d59)}",
      ".rdp-utag.tone-info{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 28%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 10%,transparent);color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-utag.tone-success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 11%,transparent);color:var(--dsw-alias-state-success-primary,#059669)}",
      ".rdp-utag.tone-warning{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 32%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 11%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#d97706))}",
      ".rdp-utag.tone-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 30%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}",

      // 页头与分段切换器（克制单层中性面，零渐变零口号）
      ".rdp-hero{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.04))}",
      ".rdp-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}",
      ".rdp-head{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 300px}",
      ".rdp-title{margin:0;font-size:15.5px;font-weight:600;letter-spacing:-.01em;line-height:1.38;color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-lead{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.52;max-width:68ch}",
      ".rdp-tabs{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.24));background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.09));flex:0 0 auto}",
      ".rdp-tab{display:inline-flex;align-items:center;gap:6px;height:27px;padding:0 11px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .14s cubic-bezier(.16,1,.3,1),color .14s cubic-bezier(.16,1,.3,1)}",
      ".rdp-tab:hover{color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-tab.is-active{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#141413);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}",
      ".rdp-fleet{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:9px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.16))}",
      ".rdp-fleet-chip{display:inline-flex;align-items:center;gap:5px;height:23px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-base,transparent);font-size:11.5px;color:var(--dsw-alias-label-secondary,#5e5d59)}",
      ".rdp-fleet-chip.is-off{opacity:.58;border-style:dashed}",
      ".rdp-fleet-cnt{font-size:11px;color:var(--dsw-alias-label-tertiary,#73726c);font-variant-numeric:tabular-nums}",
      ".rdp-fleet-refresh{margin-left:auto}",

      // Bento 二栏矩阵与分区设置卡片（DOM 保持闭环顺序，视觉采用左 S0+S4.5 / 右 S2 / 下 S4 矩阵）
      ".rdp-state{padding:10px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.24));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.05));font-size:12px;color:var(--dsw-alias-label-secondary,#5e5d59);line-height:1.58}",
      ".rdp-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 36%,var(--dsw-alias-border-l2,rgba(120,119,112,.24)));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 8%,transparent);color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-bento-matrix{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:stretch}",
      ".rdp-bento{position:relative;padding:13px 15px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.03));transition:border-color .14s cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;gap:8px}",
      ".rdp-bento:hover{border-color:var(--dsw-alias-border-l3,rgba(120,119,112,.36))}",
      ".rdp-bento.has-menu{z-index:40}",
      ".rdp-bento-s0{grid-column:1;grid-row:1}",
      ".rdp-bento-s2{grid-column:2;grid-row:1 / span 2}",
      ".rdp-bento-s45{grid-column:1;grid-row:2}",
      ".rdp-bento-s4{grid-column:1 / -1;grid-row:3}",
      ".rdp-group{display:flex;flex-direction:column;gap:2px}",
      ".rdp-group-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".rdp-group-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
      ".rdp-step-pill{display:inline-flex;align-items:center;justify-content:center;height:18px;padding:0 6px;border-radius:5px;font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.28));background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.10));color:var(--dsw-alias-label-secondary,#5e5d59)}",
      ".rdp-group-t{margin:0;font-size:13.5px;font-weight:600;letter-spacing:-.005em;color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-group-d{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.5;max-width:68ch}",
      ".rdp-help-wrap{position:relative;display:inline-flex;align-items:center;flex:0 0 auto}",
      ".rdp-help-btn{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary,#73726c);cursor:help;transition:color .14s ease,background-color .14s ease}",
      ".rdp-help-btn:hover,.rdp-help-btn:focus-visible{color:var(--dsw-alias-label-primary,#141413);background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.12));outline:none}",
      ".rdp-help-pop{position:fixed;z-index:9999;left:-9999px;top:-9999px;width:max-content;max-width:260px;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l3,rgba(120,119,112,.32));background:var(--dsw-alias-bg-base,#1c1c1a);color:var(--dsw-alias-label-primary,#f3f2ee);font-size:11.5px;font-weight:400;line-height:1.45;white-space:normal;box-shadow:0 8px 22px rgba(0,0,0,.22);opacity:0;pointer-events:none;transition:opacity .12s ease}",
      ".rdp-help-wrap:hover .rdp-help-pop,.rdp-help-wrap:focus-within .rdp-help-pop{opacity:1}",
      ".rdp-items{display:flex;flex-direction:column;margin-top:2px}",
      ".rdp-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;align-items:center;padding:8px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.16))}",
      ".rdp-item-stack{grid-template-columns:minmax(0,1fr);gap:7px;align-items:stretch}",
      ".rdp-item-stack .rdp-item-main{flex-direction:row;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 10px}",
      ".rdp-item-meta-r{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto}",
      ".rdp-item-vote-del{height:24px;padding:0 7px;font-size:11px;border-radius:6px}",
      ".rdp-items .rdp-item:first-child{border-top:0;padding-top:2px}",
      ".rdp-items .rdp-item:last-child{padding-bottom:2px}",
      ".rdp-item-full{grid-template-columns:minmax(0,1fr)}",
      ".rdp-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".rdp-label{font-size:12.5px;font-weight:550;display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#73726c);min-width:0}",
      ".rdp-inherit{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:5px;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 10%,transparent);color:var(--dsw-alias-brand-primary,#c96442);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".rdp-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.52}",
      ".rdp code{font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,#4a4945);background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.11));padding:1px 6px;border-radius:4px}",
      ".rdp-ctl{display:flex;align-items:center;gap:7px;min-width:0}",
      ".rdp-path-row{display:flex;align-items:center;gap:6px;max-width:100%}",
      ".rdp-grid2{display:grid;grid-template-columns:minmax(130px,1fr) minmax(156px,1.25fr);gap:6px;width:100%}",
      ".rdp-grid3{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) minmax(104px,max-content);gap:6px;width:100%;align-items:center}",

      // 输入框、定制下拉框（零 <select>）与无障碍拨杆开关（Switch）
      ".rdp-in{font:inherit;font-size:12px;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#141413);box-sizing:border-box;width:100%;transition:border-color .14s cubic-bezier(.16,1,.3,1),box-shadow .14s cubic-bezier(.16,1,.3,1)}",
      ".rdp-in-path{width:380px;max-width:100%}",
      ".rdp-in-num{width:80px;text-align:center;font-weight:600;font-variant-numeric:tabular-nums}",
      ".rdp-in:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(120,119,112,.48))}",
      ".rdp-in:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#c96442);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 18%,transparent)}",
      ".rdp-in:disabled{opacity:.52;cursor:default}",
      ".rdp-switch{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;padding:2px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,rgba(120,119,112,.34));background:var(--dsw-alias-bg-layer-3,rgba(120,119,112,.22));cursor:pointer;box-sizing:border-box;flex:0 0 auto;transition:background-color .15s cubic-bezier(.16,1,.3,1),border-color .15s cubic-bezier(.16,1,.3,1)}",
      ".rdp-switch.is-on{background:var(--dsw-alias-brand-primary,#c96442);border-color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-switch:focus-visible{outline:none;box-shadow:0 0 0 2.5px color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 22%,transparent)}",
      ".rdp-switch:disabled{opacity:.48;cursor:default}",
      ".rdp-switch-thumb{width:14px;height:14px;border-radius:999px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.18);transform:translateX(0);transition:transform .15s cubic-bezier(.16,1,.3,1)}",
      ".rdp-switch.is-on .rdp-switch-thumb{transform:translateX(16px)}",

      // 工作区快捷胶囊条
      ".rdp-ws-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}",
      ".rdp-ws-cap{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#73726c);margin-right:2px}",
      ".rdp-ws-pill{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.26));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;cursor:pointer;transition:border-color .14s ease,color .14s ease,background-color .14s ease}",
      ".rdp-ws-pill:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#c96442);color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-ws-pill.is-active{border-color:var(--dsw-alias-brand-primary,#c96442);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 11%,transparent);color:var(--dsw-alias-brand-primary,#c96442);font-weight:600}",
      ".rdp-ws-star{display:inline-flex;color:var(--dsw-alias-brand-primary,#c96442)}",

      // 定制下拉与模型搜索弹层 + 思考强度选择器（ExecPicker / ModelPicker / EffortPicker）
      ".rdp-pick{position:relative;min-width:0}",
      ".rdp-pick-btn{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:12px;text-align:left;cursor:pointer;transition:border-color .14s cubic-bezier(.16,1,.3,1),box-shadow .14s cubic-bezier(.16,1,.3,1)}",
      ".rdp-pick-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(120,119,112,.48))}",
      ".rdp-pick-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#c96442);box-shadow:0 0 0 2.5px color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 18%,transparent)}",
      ".rdp-pick-btn:disabled{opacity:.56;cursor:default}",
      ".rdp-pick-btn.is-open{border-color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-effort-pick{flex:0 0 auto}",
      ".rdp-effort-btn{width:auto;height:24px;padding:0 8px;border-radius:999px;font-size:11px;gap:4px;background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.07))}",
      ".rdp-effort-btn.is-coupled{border-style:dashed;background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.08));color:var(--dsw-alias-label-secondary,#5e5d59);opacity:.92}",
      ".rdp-effort-btn.is-unsupported{border-style:dashed;background:transparent;color:var(--dsw-alias-label-tertiary,#73726c);opacity:.66}",
      ".rdp-pick-lead{display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden}",
      ".rdp-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-pick-caret{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,#73726c)}",
      ".rdp-menu{position:absolute;z-index:60;top:calc(100% + 5px);right:0;width:max(296px,100%);max-height:336px;overflow:auto;padding:6px;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,rgba(120,119,112,.28));background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 28px rgba(0,0,0,.14)}",
      ".rdp-exec-menu{left:0;right:auto;width:max(248px,100%)}",
      ".rdp-effort-menu{right:0;left:auto;width:max(168px,100%)}",
      ".rdp-search-box{position:relative;display:flex;align-items:center;margin:0 0 6px}",
      ".rdp-search-ico{position:absolute;left:9px;color:var(--dsw-alias-label-tertiary,#73726c);pointer-events:none}",
      ".rdp-menu-search{display:block;width:100%;height:30px;margin:0;padding:0 9px 0 28px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.26));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:12px;outline:none;box-sizing:border-box}",
      ".rdp-menu-search:focus{border-color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-menu-empty{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#73726c)}",
      ".rdp-menu-sec+.rdp-menu-sec{margin-top:4px;padding-top:4px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.14))}",
      ".rdp-menu-cap{display:flex;align-items:center;height:20px;padding:0 8px;color:var(--dsw-alias-label-tertiary,#73726c);font-size:11px;font-weight:600}",
      ".rdp-menu-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:30px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:12px;text-align:left;cursor:pointer}",
      ".rdp-menu-item:hover,.rdp-menu-item.is-hi{background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.12))}",
      ".rdp-menu-item.is-sel{color:var(--dsw-alias-brand-primary,#c96442);font-weight:600}",
      ".rdp-menu-lead{display:inline-flex;align-items:center;gap:7px;min-width:0;overflow:hidden}",
      ".rdp-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-menu-tick{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-brand-primary,#c96442)}",

      // 按钮与实底不透明底部保存栏（无改动时安静克制，dirty 或保存反馈时浮现强调）
      ".rdp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12px;height:30px;padding:0 11px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#5e5d59);white-space:nowrap;flex:0 0 auto;transition:background-color .14s ease,border-color .14s ease,color .14s ease}",
      ".rdp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.10));color:var(--dsw-alias-label-primary,#141413);border-color:var(--dsw-alias-border-l3,rgba(120,119,112,.44))}",
      ".rdp-btn:focus-visible{outline:none;box-shadow:0 0 0 2.5px color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 18%,transparent)}",
      ".rdp-btn:disabled{opacity:.44;cursor:default}",
      ".rdp-btn-sm{height:26px;padding:0 9px;font-size:11.5px;border-radius:7px}",
      ".rdp-btn-ghost{border-color:transparent;background:transparent}",
      ".rdp-btn-danger{height:28px;padding:0 8px;border-color:transparent;color:var(--dsw-alias-label-tertiary,#73726c);background:transparent}",
      ".rdp-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);border-color:transparent}",
      ".rdp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#c96442));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:560}",
      ".rdp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 88%,#000));color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}",
      ".rdp-add-wrap{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}",
      ".rdp-add{flex:1 1 180px;height:30px;border-style:dashed;color:var(--dsw-alias-label-secondary,#5e5d59)}",
      ".rdp-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#c96442);color:var(--dsw-alias-brand-primary,#c96442);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 6%,transparent)}",
      ".rdp-note{margin:2px 2px 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.55}",
      ".rdp-empty{padding:9px 11px;border:1px dashed var(--dsw-alias-border-l2,rgba(120,119,112,.28));border-radius:9px;font-size:12px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.55;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}",
      ".rdp-slot-pills{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".rdp-badge{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 11%,transparent);color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-foot{position:sticky;bottom:0;z-index:25;display:flex;align-items:center;gap:12px;margin-top:4px;padding:10px 14px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.20));background:var(--dsw-alias-bg-base,#ffffff);transition:border-color .15s ease,box-shadow .15s ease}",
      ".rdp-foot.is-quiet{border-color:var(--dsw-alias-border-l2,rgba(120,119,112,.16));background:var(--dsw-alias-bg-base,#ffffff)}",
      ".rdp-foot.is-elevated{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 34%,var(--dsw-alias-border-l2,rgba(120,119,112,.24)));background:var(--dsw-alias-bg-base,#ffffff);box-shadow:0 -2px 14px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.07)}",
      ".rdp-foot-msg{font-size:12px;color:var(--dsw-alias-label-tertiary,#73726c);margin-right:auto}",
      ".rdp-foot-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-ok{color:var(--dsw-alias-state-success-primary,#059669);font-weight:550}",
      ".rdp-bad{color:var(--dsw-alias-state-error-primary,#dc2626);font-weight:550}",

      // 会话右上角状态胶囊（conversation.session.header.utilities）
      ".rdp-hdr-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.28));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.06));color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;font-weight:550;font-variant-numeric:tabular-nums;cursor:pointer;transition:border-color .14s ease,color .14s ease,background-color .14s ease}",
      ".rdp-hdr-pill:hover{border-color:var(--dsw-alias-brand-primary,#c96442);color:var(--dsw-alias-label-primary,#141413);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 8%,transparent)}",
      ".rdp-hdr-pill.is-working{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 10%,transparent);color:var(--dsw-alias-brand-primary,#c96442)}",

      // /swarm 科研拓扑星图工作台（8列满宽阶梯轨 + 宽幅画布 + 右侧选项卡检视与常驻底栏裁决台）
      ".rdp-swarm-shell{container-type:inline-size;display:flex;flex-direction:column;gap:10px;padding:14px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#141413);font-size:12.5px;height:100%;overflow:auto}",
      ".rdp-swarm-shell.is-embedded{padding:2px 0 0;height:auto;overflow:visible}",
      ".rdp-swarm-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 12px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.04))}",
      ".rdp-swarm-bar-l,.rdp-swarm-bar-r{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
      ".rdp-topic-pill{height:24px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.26));background:transparent;color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;cursor:pointer}",
      ".rdp-topic-pill.is-active{border-color:var(--dsw-alias-brand-primary,#c96442);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 11%,transparent);color:var(--dsw-alias-brand-primary,#c96442);font-weight:600}",
      ".rdp-rail{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px;overflow:visible}",
      ".rdp-stage-card{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:7px 9px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.20));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.03));color:var(--dsw-alias-label-primary,#141413);font:inherit;text-align:left;cursor:pointer;min-width:0;transition:border-color .14s ease,background-color .14s ease}",
      ".rdp-stage-card:hover{border-color:var(--dsw-alias-border-l3,rgba(120,119,112,.42))}",
      ".rdp-stage-card.is-active{border-color:var(--dsw-alias-brand-primary,#c96442);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 8%,var(--dsw-alias-bg-base,transparent))}",
      ".rdp-stage-top{display:flex;align-items:center;justify-content:space-between;width:100%;gap:4px}",
      ".rdp-stage-id{font-size:10px;font-weight:650;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#73726c)}",
      ".rdp-stage-dot{width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-label-tertiary,#87867f)}",
      ".rdp-stage-dot.st-done{background:var(--dsw-alias-state-success-primary,#10b981)}",
      ".rdp-stage-dot.st-working{background:var(--dsw-alias-brand-primary,#c96442);animation:rdpPulse 1.5s infinite}",
      ".rdp-stage-dot.st-pending{background:var(--dsw-alias-state-warn-primary,#d97706)}",
      ".rdp-stage-name{font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}",
      ".rdp-stage-cnt{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#73726c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}",
      ".rdp-ideas-strip{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:2px 1px}",
      ".rdp-idea-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l3,rgba(120,119,112,.25));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;transition:border-color .14s ease,color .14s ease}",
      ".rdp-idea-chip:hover{border-color:var(--dsw-alias-brand-primary,#c96442);color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-idea-chip.is-active{border-color:var(--dsw-alias-brand-primary,#c96442);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 11%,transparent);color:var(--dsw-alias-brand-primary,#c96442);font-weight:600}",
      ".rdp-vtag{font-size:10px;font-weight:650;padding:1px 6px;border-radius:999px}",
      ".rdp-vtag-go{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 15%,transparent);color:var(--dsw-alias-state-success-primary,#059669)}",
      ".rdp-vtag-revise{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 16%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#d97706))}",
      ".rdp-vtag-kill{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".rdp-vtag-pending{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#c96442) 13%,transparent);color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-swarm-body{display:grid;grid-template-columns:minmax(0,1fr) 348px;gap:12px;align-items:stretch;min-height:492px}",
      ".rdp-canvas-card{display:flex;flex-direction:column;justify-content:space-between;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.24));background:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--dsw-alias-label-tertiary,#73726c) 18%,transparent) 1px,transparent 0) 0 0/20px 20px,var(--dsw-alias-bg-layer-1,rgba(120,119,112,.03));overflow:hidden;position:relative;min-height:492px}",
      ".rdp-canvas-viewport{position:relative;flex:1 1 auto;display:flex;align-items:stretch;overflow:hidden;cursor:grab;touch-action:none}",
      ".rdp-canvas-viewport.is-panning{cursor:grabbing}",
      ".rdp-svg{width:100%;height:auto;min-height:430px;display:block;user-select:none}",
      ".rdp-edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary,#73726c) 36%,transparent);stroke-width:1.5;transition:stroke .16s ease}",
      ".rdp-edge.st-done{stroke:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 58%,transparent)}",
      ".rdp-edge.st-pending{stroke:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 55%,transparent);stroke-dasharray:5 5}",
      ".rdp-edge.st-working{stroke:var(--dsw-alias-brand-primary,#c96442);stroke-width:2;stroke-dasharray:7 5;animation:rdpFlow .9s linear infinite}",
      ".rdp-edge.st-failed{stroke:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 65%,transparent);stroke-dasharray:4 4}",
      ".rdp-edge-pulse{fill:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-gnode{cursor:pointer}",
      ".rdp-gnode-box{fill:var(--dsw-alias-bg-base,#ffffff);stroke:var(--dsw-alias-border-l2,rgba(120,119,112,.34));stroke-width:1;transition:stroke .14s ease,stroke-width .14s ease}",
      ".rdp-gnode:hover .rdp-gnode-box{stroke:var(--dsw-alias-brand-primary,#c96442);stroke-width:1.5}",
      ".rdp-gnode.is-selected .rdp-gnode-box{stroke:var(--dsw-alias-brand-primary,#c96442);stroke-width:2}",
      ".rdp-canvas-legend{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:6px 12px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.18));background:var(--dsw-alias-bg-base,#ffffff);font-size:11px;color:var(--dsw-alias-label-tertiary,#73726c)}",
      ".rdp-legend-items{display:flex;align-items:center;gap:11px;flex-wrap:wrap}",
      ".rdp-legend-i{display:inline-flex;align-items:center;gap:5px}",
      ".rdp-zoom-bar{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.26));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.05));margin-left:auto}",
      ".rdp-zoom-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:22px;min-width:22px;padding:0 6px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11px;cursor:pointer}",
      ".rdp-zoom-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.12));color:var(--dsw-alias-label-primary,#141413)}",
      ".rdp-zoom-btn:disabled{opacity:.4;cursor:default}",
      ".rdp-zoom-pct{min-width:40px;text-align:center;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#5e5d59)}",

      // 右侧选项卡节点检视器与首屏常驻人类唯一拍板底栏
      ".rdp-drawer{display:flex;flex-direction:column;gap:9px;padding:12px 13px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.24));background:var(--dsw-alias-bg-layer-1,rgba(120,119,112,.03));max-height:540px;overflow:hidden}",
      ".rdp-drawer-h{display:flex;flex-direction:column;gap:3px;padding-bottom:8px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.18));flex:0 0 auto}",
      ".rdp-drawer-t{margin:0;font-size:13.5px;font-weight:600;line-height:1.38}",
      ".rdp-dock-tabs{display:grid;grid-template-columns:1fr 1fr;gap:3px;padding:3px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.08));flex:0 0 auto}",
      ".rdp-dock-tab{height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;font-weight:500;cursor:pointer;transition:background-color .12s ease,color .12s ease}",
      ".rdp-dock-tab.is-active{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#141413);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}",
      ".rdp-drawer-scroll{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:9px;padding-right:2px}",
      ".rdp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 9px;font-size:11.5px}",
      ".rdp-kv-k{color:var(--dsw-alias-label-tertiary,#73726c);white-space:nowrap}",
      ".rdp-kv-v{color:var(--dsw-alias-label-primary,#141413);font-weight:520;font-variant-numeric:tabular-nums;word-break:break-all}",
      ".rdp-sec-cap{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary,#73726c);margin-bottom:3px}",
      ".rdp-push-list{display:flex;flex-direction:column;gap:5px}",
      ".rdp-push-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.09));font-size:11.5px}",
      ".rdp-dim-list{display:flex;flex-direction:column;gap:6px}",
      ".rdp-dim-row{display:flex;flex-direction:column;gap:2px}",
      ".rdp-dim-top{display:flex;align-items:center;justify-content:space-between;font-size:11.5px;font-variant-numeric:tabular-nums}",
      ".rdp-dim-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(120,119,112,.18));overflow:hidden}",
      ".rdp-dim-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-dim-reason{font-size:11px;color:var(--dsw-alias-label-tertiary,#73726c);line-height:1.42}",
      ".rdp-verdict-box{display:flex;flex-direction:column;gap:7px;padding:10px 11px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 34%,var(--dsw-alias-border-l2,rgba(120,119,112,.25)));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 7%,var(--dsw-alias-bg-base,#fff));flex:0 0 auto}",
      ".rdp-verdict-btns{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}",
      ".rdp-vbtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:29px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.30));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#5e5d59);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;transition:border-color .14s ease,background-color .14s ease,color .14s ease}",
      ".rdp-vbtn-go:hover,.rdp-vbtn-go.is-sel{border-color:var(--dsw-alias-state-success-primary,#10b981);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#10b981) 14%,transparent);color:var(--dsw-alias-state-success-primary,#059669)}",
      ".rdp-vbtn-revise:hover,.rdp-vbtn-revise.is-sel{border-color:var(--dsw-alias-state-warn-primary,#d97706);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 15%,transparent);color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#d97706))}",
      ".rdp-vbtn-kill:hover,.rdp-vbtn-kill.is-sel{border-color:var(--dsw-alias-state-error-primary,#dc2626);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}",
      ".rdp-textarea{width:100%;min-height:46px;padding:6px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(120,119,112,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#141413);font:inherit;font-size:11.5px;resize:vertical;box-sizing:border-box}",
      ".rdp-textarea:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#c96442)}",
      ".rdp-act-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".rdp-preview{margin:0;padding:9px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2,rgba(120,119,112,.22));background:var(--dsw-alias-bg-base,rgba(0,0,0,.02));font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#4a4945);white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}",
      "@keyframes rdpFlow{to{stroke-dashoffset:-24}}",
      "@keyframes rdpPulse{0%,100%{opacity:1}50%{opacity:.42}}",
      "@container (max-width:900px){.rdp-swarm-body{grid-template-columns:minmax(0,1fr)}.rdp-drawer{max-height:none}.rdp-rail{grid-template-columns:repeat(4,minmax(0,1fr))}}",
      "@container (max-width:820px){.rdp-bento-matrix{grid-template-columns:minmax(0,1fr)}.rdp-bento-s0,.rdp-bento-s2,.rdp-bento-s4,.rdp-bento-s45{grid-column:auto;grid-row:auto}}",
      "@container (max-width:600px){.rdp-rail{grid-template-columns:repeat(2,minmax(0,1fr))}.rdp-item-path{grid-template-columns:minmax(0,1fr)}.rdp-item-path .rdp-ctl,.rdp-path-row,.rdp-in-path{width:100%}.rdp-grid2{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);width:100%}}",
      "@media (max-width:900px){.rdp-swarm-body{grid-template-columns:minmax(0,1fr)}.rdp-drawer{max-height:none}.rdp-rail{grid-template-columns:repeat(4,minmax(0,1fr))}}",
      "@media (max-width:820px){.rdp-bento-matrix{grid-template-columns:minmax(0,1fr)}.rdp-bento-s0,.rdp-bento-s2,.rdp-bento-s4,.rdp-bento-s45{grid-column:auto;grid-row:auto}}",
      "@media (max-width:600px){.rdp-rail{grid-template-columns:repeat(2,minmax(0,1fr))}.rdp-item-path{grid-template-columns:minmax(0,1fr)}.rdp-item-path .rdp-ctl,.rdp-path-row,.rdp-in-path{width:100%}.rdp-grid2{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);width:100%}}",
      "@media (prefers-reduced-motion:reduce){.rdp *,.rdp-swarm-shell *{transition:none!important;animation:none!important}}",
    ].join("");

    let STYLE_TAG = null;
    function ensureStyleTag() {
      try {
        if (typeof document === "undefined" || !document || typeof document.querySelector !== "function") return;
        const existing = document.querySelector('style[data-plugin-css="research-dispatch"]');
        if (existing) {
          existing.textContent = CSS;
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

    function isDshProfilePath(p) {
      const norm = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      return /(?:^|\/)\.dsh\/profiles(?:\/|$)/i.test(norm);
    }

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
      "scoutCommand",
      "scoutModel",
      "scoutEffort",
      "divergeCommand",
      "divergeModel",
      "divergeEffort",
      "divergeCount",
      "divergeUseDeadEnds",
      "reviewVotes",
      "noveltyCommand",
      "noveltyModel",
      "noveltyEffort",
      "executorCatalog",
      "executorStatus",
      "otherStages",
      "stageOpinions",
    ];

    const LABELS = {
      repoRoot: "项目文件夹",
      seatsFile: "座位表路径",
      scoutCommand: "文献调研工具",
      scoutModel: "文献调研模型",
      scoutEffort: "文献调研思考强度",
      divergeCommand: "想法发散工具",
      divergeModel: "想法发散模型",
      divergeEffort: "想法发散思考强度",
      divergeCount: "单轮默认条数",
      divergeUseDeadEnds: "历史死胡同过滤",
      reviewVotes: "评审票",
      noveltyCommand: "前置查重工具",
      noveltyModel: "前置查重模型",
      noveltyEffort: "前置查重思考强度",
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
      if (!diag.fieldKeys) diag.fieldKeys = keys.slice(0, 20);
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
      { key: "repoRoot", title: "项目文件夹", description: "科研项目文件夹路径", default: "" },
      { key: "scoutCommand", title: "文献调研工具", description: "文献调研执行工具", default: "" },
      { key: "scoutModel", title: "文献调研模型", description: "文献调研模型", default: "" },
      { key: "scoutEffort", title: "文献调研思考强度", description: "文献调研思考强度", default: "" },
      { key: "divergeCommand", title: "想法发散工具", description: "想法发散执行工具", default: "" },
      { key: "divergeModel", title: "想法发散模型", description: "想法发散模型", default: "" },
      { key: "divergeEffort", title: "想法发散思考强度", description: "想法发散思考强度", default: "" },
      { key: "divergeCount", title: "单轮默认条数", description: "每次发散默认条数", default: "" },
      { key: "divergeUseDeadEnds", title: "历史死胡同过滤", description: "是否挂载历史已证伪方向", default: "" },
      { key: "reviewVotes", title: "评审票", description: "几票对应几位评审员", default: "" },
      { key: "noveltyCommand", title: "前置查重工具", description: "前置查重执行工具", default: "" },
      { key: "noveltyModel", title: "前置查重模型", description: "前置查重模型", default: "" },
      { key: "noveltyEffort", title: "前置查重思考强度", description: "前置查重思考强度", default: "" },
    ];

    const SEATS_HINT = "保存后，以上四环节工具与模型阵容将自动同步至所选项目的本地配置，桌面端与命令行即刻共享生效，且不会覆盖手写的底层启动参数。";
    const STAGE_SEATS = ["codex", "claude", "dsh", "agy", "kimi"];
    const REVIEW_SEATS = STAGE_SEATS;
    const DIVERGE_SEATS = STAGE_SEATS;
    const SEAT_LABELS = {
      codex: "codex · Codex CLI",
      claude: "claude · Claude Code",
      dsh: "dsh · DeepSeek Harness",
      agy: "agy · Antigravity",
      kimi: "kimi · Kimi Code",
    };
    const SEAT_COLORS = {
      codex: "#10b981",
      claude: "#c96442",
      dsh: "#3b82f6",
      agy: "#6366f1",
      kimi: "#0d9488",
    };
    const DIM_LABELS = {
      novelty: "新意",
      feasibility: "可行性",
      baseline_fit: "基线契合",
      impl_cost: "轻量省算力",
      expected_gain: "预期提升",
    };

    function statusOf(value) {
      const raw = String((value && value.executorStatus) || "");
      const out = {};
      for (const row of raw.split(";")) {
        const i = row.indexOf(":");
        if (i < 0) continue;
        const exec = row.slice(0, i).trim();
        const flag = row.slice(i + 1).trim();
        if (!exec || !flag) continue;
        out[exec] = flag === "1" || flag.toLowerCase() === "true";
      }
      return out;
    }

    function seatOptionLabel(exec, statusMap) {
      if (exec === "api") return "api · 旧配置兼容项（建议切换）";
      if (exec === "gemini") return "gemini · 旧版兼容项（建议切换至 agy）";
      const base = SEAT_LABELS[exec] || exec;
      if (statusMap && Object.prototype.hasOwnProperty.call(statusMap, exec) && statusMap[exec] === false) {
        return base + "（未检测到命令）";
      }
      return base;
    }

    function seatStateTone(exec, statusMap) {
      if (!exec) return "idle";
      if (exec === "api" || exec === "gemini") return "warning";
      if (statusMap && Object.prototype.hasOwnProperty.call(statusMap, exec) && statusMap[exec] === false) {
        return "idle";
      }
      return "done";
    }

    function buildExecOptions(curExec, statusMap, emptyLabel) {
      const opts = [];
      if (emptyLabel) opts.push({ value: "", label: emptyLabel, state: "idle" });
      for (const exec of STAGE_SEATS) {
        opts.push({
          value: exec,
          label: seatOptionLabel(exec, statusMap),
          state: seatStateTone(exec, statusMap),
        });
      }
      if (curExec && curExec !== "subagent" && !STAGE_SEATS.includes(curExec)) {
        opts.push({
          value: curExec,
          label: seatOptionLabel(curExec, statusMap),
          state: seatStateTone(curExec, statusMap),
        });
      }
      return opts;
    }

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
        if (!row) { byExec.set(exec, { exec: exec, models: models.slice() }); continue; }
        for (const m of models) if (!row.models.includes(m)) row.models.push(m);
      }
      return [...byExec.values()];
    }

    function mergeCatalogRows(primary, fallback) {
      const byExec = new Map();
      for (const row of primary || []) {
        if (!row || !row.exec) continue;
        byExec.set(row.exec, { exec: row.exec, models: (row.models || []).slice() });
      }
      for (const row of fallback || []) {
        if (!row || !row.exec) continue;
        const cur = byExec.get(row.exec);
        if (!cur) {
          byExec.set(row.exec, { exec: row.exec, models: (row.models || []).slice() });
          continue;
        }
        for (const m of row.models || []) {
          if (m && !cur.models.includes(m)) cur.models.push(m);
        }
      }
      return [...byExec.values()];
    }

    // ── 实时执行者探测桥与 /swarm 拓扑快照存储（兼容 DSH Electron connection.rpc 与 HTTP fetch）──
    let CONNECTION = null;
    let CONN_SEQ = 0;
    let BRIDGE_SNAPSHOT = null;
    let SWARM_SNAPSHOT = null;
    let SWARM_ROUTE_MISSING = false;
    let SWARM_LAST_ERROR = "";
    const bridgeWatchers = new Set();

    function notifyBridgeWatchers() {
      for (const fn of bridgeWatchers) {
        try { fn(); } catch { /* 单个订阅者异常不影响其余监听器 */ }
      }
    }

    function setConnection(conn) {
      CONNECTION = conn || null;
      CONN_SEQ += 1;
      if (CONNECTION) SWARM_LAST_ERROR = "";
      notifyBridgeWatchers();
    }

    function isRouteMissingError(msg) {
      return /\bHTTP\s*404\b|\bstatus(?:\s*code)?\s*[:=]?\s*404\b|404\s+not\s+found|^not found$|unknown endpoint/i.test(String(msg || ""));
    }

    let SWARM_REQ_SEQ = 0;
    let SWARM_ACTION_EPOCH = 0;
    let SWARM_ACTIVE_CTX = null;

    function buildSwarmCtx(obj, fallbackSnap) {
      const repo = String((obj && obj.repoRoot) || (fallbackSnap && fallbackSnap.repoRoot) || "").trim();
      const topic = String((obj && obj.topic) || (fallbackSnap && fallbackSnap.activeTopic) || "").trim();
      if (!repo && !topic) return null;
      return { repo, topic };
    }

    function isSwarmCtxCompatible(candidateCtx, activeCtx) {
      if (!activeCtx || (!activeCtx.repo && !activeCtx.topic)) return true;
      if (!candidateCtx || (!candidateCtx.repo && !candidateCtx.topic)) return true;
      if (candidateCtx.repo && activeCtx.repo && candidateCtx.repo !== activeCtx.repo) return false;
      if (candidateCtx.topic && activeCtx.topic && candidateCtx.topic !== activeCtx.topic) return false;
      return true;
    }

    function setBridgeSnapshot(snap) {
      BRIDGE_SNAPSHOT = snap && typeof snap === "object"
        ? {
          catalog: String(snap.catalog || ""),
          status: String(snap.status || ""),
          version: String(snap.version || ""),
          defaultRepoRoot: String(snap.defaultRepoRoot || ""),
          repoRoot: String(snap.repoRoot || ""),
          workspaces: Array.isArray(snap.workspaces) ? snap.workspaces.slice() : [],
          projectLineup: snap.projectLineup && typeof snap.projectLineup === "object" ? snap.projectLineup : null,
          effortCapabilities: snap.effortCapabilities && typeof snap.effortCapabilities === "object" ? { ...snap.effortCapabilities } : null,
          effortLevels: snap.effortLevels && typeof snap.effortLevels === "object" ? { ...snap.effortLevels } : null,
        }
        : null;
      notifyBridgeWatchers();
    }

    function setSwarmSnapshot(snap) {
      SWARM_SNAPSHOT = snap && typeof snap === "object" ? snap : null;
      if (snap) {
        SWARM_ROUTE_MISSING = false;
        SWARM_LAST_ERROR = "";
      }
      notifyBridgeWatchers();
    }

    const NATIVE_FETCH = typeof fetch === "function" ? fetch : null;
    function resolveRpcCaller(customFetch) {
      if (typeof customFetch === "function") return null;
      if (customFetch && typeof customFetch === "object" && typeof customFetch.call === "function") {
        return customFetch;
      }
      if (CONNECTION && CONNECTION.rpc && typeof CONNECTION.rpc.call === "function") {
        return CONNECTION.rpc;
      }
      if (
        typeof globalThis !== "undefined"
        && globalThis.__DSH_TRANSPORT__
        && globalThis.__DSH_TRANSPORT__.rpc
        && typeof globalThis.__DSH_TRANSPORT__.rpc.call === "function"
      ) {
        return globalThis.__DSH_TRANSPORT__.rpc;
      }
      return null;
    }

    function resolveFetchFn(customFetch) {
      if (typeof customFetch === "function") return customFetch;
      if (typeof fetch === "function" && fetch !== NATIVE_FETCH) return fetch;
      if (CONNECTION && typeof CONNECTION.fetch === "function") {
        return (p, init) => CONNECTION.fetch(p, init);
      }
      if (
        typeof globalThis !== "undefined"
        && globalThis.__DSH_TRANSPORT__
        && typeof globalThis.__DSH_TRANSPORT__.fetch === "function"
      ) {
        return (p, init) => globalThis.__DSH_TRANSPORT__.fetch(new URL(p, "http://dsh.internal"), init);
      }
      if (
        typeof fetch === "function"
        && typeof window !== "undefined"
        && window.location
        && /^https?:$/i.test(String(window.location.protocol || ""))
      ) {
        return fetch;
      }
      return null;
    }

    async function fetchBridgeSnapshot(customFetch, opts) {
      const bodyObj = typeof opts === "string"
        ? { repoRoot: opts }
        : (opts && typeof opts === "object" ? opts : {});
      const rpc = resolveRpcCaller(customFetch);
      let rpcMissingFallback = false;
      if (rpc) {
        try {
          const res = await rpc.call(RPC_CHANNEL, RPC_EXEC_METHOD, bodyObj);
          if (res && res.ok && res.value && typeof res.value === "object") {
            setBridgeSnapshot(res.value);
            try {
              diag.bridgeVersion = String(res.value.version || "");
              diag.bridgeVia = "connection.rpc";
            } catch { /* 忽略 */ }
            return res.value;
          }
          if (res && res.ok === false && res.error) {
            const errMsg = String(res.error.message || res.error.code || "");
            try { diag.bridgeError = errMsg; } catch { /* 忽略 */ }
            if (isRouteMissingError(errMsg)) {
              rpcMissingFallback = true;
            }
          }
        } catch (e) {
          const msg = String((e && e.message) || e);
          try { diag.bridgeError = msg; } catch { /* 忽略 */ }
          if (isRouteMissingError(msg)) {
            rpcMissingFallback = true;
          }
        }
        if (!rpcMissingFallback) return null;
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) {
        if (rpcMissingFallback) {
          SWARM_ROUTE_MISSING = true;
          notifyBridgeWatchers();
        }
        return null;
      }
      try {
        const resp = await fn(BRIDGE_EXEC_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyObj),
        });
        if (!resp || !resp.ok) {
          if (rpcMissingFallback || (resp && resp.status === 404)) {
            SWARM_ROUTE_MISSING = true;
            notifyBridgeWatchers();
          }
          return null;
        }
        const data = await resp.json();
        if (data && data.ok && data.value && typeof data.value === "object") {
          SWARM_ROUTE_MISSING = false;
          setBridgeSnapshot(data.value);
          try {
            diag.bridgeVersion = String(data.value.version || "");
            diag.bridgeVia = "fetch";
          } catch { /* 忽略 */ }
          return data.value;
        }
      } catch (e) {
        try { diag.bridgeError = String((e && e.message) || e); } catch { /* 忽略 */ }
        if (rpcMissingFallback) {
          SWARM_ROUTE_MISSING = true;
          notifyBridgeWatchers();
        }
      }
      return null;
    }

    const BRIDGE_BUSINESS_CODES = new Set([
      "BRIEF_NOT_FOUND",
      "BRIEF_CHANGED",
      "BRIEF_SHA_REQUIRED",
      "UNAUTHORIZED_REPO_ROOT",
      "WRITE_FAILED",
    ]);

    function isKnownBridgeHttpResp(resp, data) {
      const bridgeHdr = resp && resp.headers && typeof resp.headers.get === "function"
        ? String(resp.headers.get("x-research-dispatch-bridge") || "")
        : "";
      return Boolean(
        bridgeHdr === "1"
        || (data && typeof data === "object" && (
          data.bridge === "research-dispatch"
          || BRIDGE_BUSINESS_CODES.has(String(data.code || ""))
        )),
      );
    }

    async function fetchSwarmSnapshot(params, customFetch) {
      const reqSeq = ++SWARM_REQ_SEQ;
      const actionEpochAtStart = SWARM_ACTION_EPOCH;
      const isStaleRead = () => reqSeq !== SWARM_REQ_SEQ || actionEpochAtStart !== SWARM_ACTION_EPOCH;
      const bodyObj = params && typeof params === "object" ? params : {};
      const reqCtx = buildSwarmCtx(bodyObj, null);
      if (reqCtx) {
        // 同仓库未传 topic（自动选题轮询）时保留当前已知课题上下文，避免清空 topic 让旧课题迟到动作覆写快照
        if (
          SWARM_ACTIVE_CTX
          && reqCtx.repo
          && reqCtx.repo === SWARM_ACTIVE_CTX.repo
          && !reqCtx.topic
          && SWARM_ACTIVE_CTX.topic
        ) {
          // preserve SWARM_ACTIVE_CTX until response settles
        } else {
          SWARM_ACTIVE_CTX = reqCtx;
        }
      }
      const rpc = resolveRpcCaller(customFetch);
      let rpcMissingFallback = false;
      if (rpc) {
        try {
          const res = await rpc.call(RPC_CHANNEL, RPC_SWARM_METHOD, bodyObj);
          if (isStaleRead()) return null;
          if (res && res.ok && res.value && typeof res.value === "object") {
            const valCtx = buildSwarmCtx(bodyObj, res.value);
            if (valCtx) SWARM_ACTIVE_CTX = valCtx;
            setSwarmSnapshot(res.value);
            try { diag.swarmVia = "connection.rpc"; } catch { /* 忽略 */ }
            return res.value;
          }
          const errCode = String((res && res.error && res.error.details && res.error.details.code) || "");
          const errMsg = String((res && res.error && res.error.message) || "实时拓扑接口返回异常");
          try { diag.swarmError = errMsg; } catch { /* 忽略 */ }
          if (!BRIDGE_BUSINESS_CODES.has(errCode) && isRouteMissingError(errMsg)) {
            rpcMissingFallback = true;
          } else {
            SWARM_LAST_ERROR = errMsg;
            notifyBridgeWatchers();
            return null;
          }
        } catch (e) {
          if (isStaleRead()) return null;
          const msg = String((e && e.message) || e);
          try { diag.swarmError = msg; } catch { /* 忽略 */ }
          if (isRouteMissingError(msg)) {
            rpcMissingFallback = true;
          } else {
            SWARM_LAST_ERROR = msg;
            notifyBridgeWatchers();
            return null;
          }
        }
        if (!rpcMissingFallback) return null;
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) {
        if (rpcMissingFallback) {
          SWARM_ROUTE_MISSING = true;
          SWARM_LAST_ERROR = "";
        } else {
          SWARM_LAST_ERROR = "暂未就绪宿主实时通道，请点击右上角「刷新拓扑」重试或从系统托盘重启应用。";
        }
        notifyBridgeWatchers();
        return null;
      }
      try {
        const resp = await fn(BRIDGE_SWARM_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyObj),
        });
        if (isStaleRead()) return null;
        if (!resp) {
          SWARM_LAST_ERROR = "未收到宿主拓扑响应";
          notifyBridgeWatchers();
          return null;
        }
        let data = null;
        try {
          data = await resp.json();
        } catch {
          data = null;
        }
        if (isStaleRead()) return null;
        if (resp.status === 404 && !isKnownBridgeHttpResp(resp, data)) {
          SWARM_ROUTE_MISSING = true;
          SWARM_LAST_ERROR = "";
          notifyBridgeWatchers();
          return null;
        }
        if (!resp.ok) {
          SWARM_LAST_ERROR = String((data && data.error) || ("拓扑接口响应异常 (HTTP " + resp.status + ")"));
          notifyBridgeWatchers();
          return null;
        }
        if (data && data.ok && data.value && typeof data.value === "object") {
          const valCtx = buildSwarmCtx(bodyObj, data.value);
          if (valCtx) SWARM_ACTIVE_CTX = valCtx;
          setSwarmSnapshot(data.value);
          try { diag.swarmVia = "fetch"; } catch { /* 忽略 */ }
          return data.value;
        }
        SWARM_LAST_ERROR = String((data && data.error) || "拓扑数据格式不完整");
        notifyBridgeWatchers();
      } catch (e) {
        if (isStaleRead()) return null;
        const msg = String((e && e.message) || e);
        try { diag.swarmError = msg; } catch { /* 忽略 */ }
        SWARM_LAST_ERROR = msg;
        notifyBridgeWatchers();
      }
      return null;
    }

    async function postDispatchAction(payload, customFetch) {
      const bodyObj = payload && typeof payload === "object" ? payload : {};
      // 发起动作即推进全局快照序号；动作返回时仅在仍在同一动作代次且未切换课题/工作区上下文时才写入快照
      ++SWARM_REQ_SEQ;
      const myActionToken = ++SWARM_ACTION_EPOCH;
      const applyActionSnap = (snap) => {
        if (!snap || typeof snap !== "object" || myActionToken !== SWARM_ACTION_EPOCH) return;
        const actionCtx = buildSwarmCtx(bodyObj, snap);
        if (!isSwarmCtxCompatible(actionCtx, SWARM_ACTIVE_CTX)) return;
        if (actionCtx) SWARM_ACTIVE_CTX = actionCtx;
        SWARM_ACTION_EPOCH += 1;
        SWARM_REQ_SEQ += 1;
        setSwarmSnapshot(snap);
      };
      const rpc = resolveRpcCaller(customFetch);
      let rpcMissingFallback = false;
      if (rpc) {
        let res;
        try {
          res = await rpc.call(RPC_CHANNEL, RPC_ACTION_METHOD, bodyObj);
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (isRouteMissingError(msg)) {
            rpcMissingFallback = true;
          } else {
            throw new Error(msg);
          }
        }
        if (!rpcMissingFallback) {
          if (res && res.ok) {
            const val = (res.value && typeof res.value === "object") ? res.value : {};
            const snap = (val.snapshot && typeof val.snapshot === "object") ? val.snapshot : null;
            applyActionSnap(snap);
            return { ok: true, value: val, snapshot: snap };
          }
          const errSnap = res && res.error && res.error.details && res.error.details.snapshot;
          applyActionSnap(errSnap);
          const errCode = String((res && res.error && res.error.details && res.error.details.code) || "");
          const errMsg = String((res && res.error && res.error.message) || "操作执行失败");
          // 已返回已知桥接业务错误码时绝不按消息含 "HTTP 404" 误判为路由未挂载而重复发 HTTP 请求
          if (!BRIDGE_BUSINESS_CODES.has(errCode) && isRouteMissingError(errMsg)) {
            rpcMissingFallback = true;
          } else {
            throw new Error(errMsg);
          }
        }
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) {
        if (rpcMissingFallback) {
          SWARM_ROUTE_MISSING = true;
          notifyBridgeWatchers();
          throw new Error("后台驻留旧版进程，请先从系统托盘退出 DeepSeek Harness 后重开");
        }
        throw new Error("本地桥接通道未就绪");
      }
      const resp = await fn(BRIDGE_ACTION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      if (!resp) throw new Error("未收到后台响应");
      let data = null;
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
      if (resp.status === 404 && !isKnownBridgeHttpResp(resp, data)) {
        SWARM_ROUTE_MISSING = true;
        notifyBridgeWatchers();
        throw new Error("后台驻留旧版进程，请先从系统托盘退出 DeepSeek Harness 后重开");
      }
      if (data && data.snapshot) applyActionSnap(data.snapshot);
      if (!resp.ok || !data || !data.ok) {
        throw new Error((data && data.error) || ("操作失败 (" + resp.status + ")"));
      }
      return data;
    }

    function isBackendOutdated(desc) {
      if (SWARM_ROUTE_MISSING) return true;
      if (BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.version) {
        if (/^(?:1\.|2\.[01]\.|2\.2\.0(?:$|-))/.test(BRIDGE_SNAPSHOT.version)) return true;
        return !(BRIDGE_SNAPSHOT.catalog || "").split(";").some((r) => r.trim().startsWith("agy:"));
      }
      const props = propsFromSchema(desc && desc.schema);
      if (!props) return false;
      if (
        !Object.prototype.hasOwnProperty.call(props, "executorStatus")
        || !Object.prototype.hasOwnProperty.call(props, "scoutCommand")
        || !Object.prototype.hasOwnProperty.call(props, "noveltyCommand")
      ) {
        return true;
      }
      const defCat = props.executorCatalog && typeof props.executorCatalog.default === "string"
        ? props.executorCatalog.default
        : "";
      return Boolean(defCat && !defCat.split(";").some((r) => r.trim().startsWith("agy:")));
    }

    function effectiveStatusOf(value, schemaProps) {
      const schemaDefault = schemaProps
        && schemaProps.executorStatus
        && typeof schemaProps.executorStatus.default === "string"
        ? schemaProps.executorStatus.default
        : "";
      const fromSchema = statusOf({ executorStatus: schemaDefault });
      const fromValue = statusOf(value);
      const fromBridge = BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.status
        ? statusOf({ executorStatus: BRIDGE_SNAPSHOT.status })
        : {};
      return { ...fromSchema, ...fromValue, ...fromBridge };
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
          const full = mid.indexOf(prov + "/") === 0 ? mid : (prov + "/" + mid);
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

    function panelCatalog(value, ctx, schemaProps) {
      const schemaDefault = schemaProps
        && schemaProps.executorCatalog
        && typeof schemaProps.executorCatalog.default === "string"
        ? schemaProps.executorCatalog.default
        : "";
      const bridgeRows = BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.catalog
        ? catalogOf({ executorCatalog: BRIDGE_SNAPSHOT.catalog })
        : [];
      const valueRows = catalogOf(value);
      const schemaRows = schemaDefault ? catalogOf({ executorCatalog: schemaDefault }) : [];
      const layeredRows = mergeCatalogRows(bridgeRows, mergeCatalogRows(valueRows, schemaRows));
      const base = mergeCatalog(layeredRows, readModelDirectories(ctx))
        .filter((c) => c.exec !== "subagent" && c.exec !== "api");
      if (!LIVE_CATALOG) return base;
      const out = base.filter((c) => !Object.prototype.hasOwnProperty.call(LIVE_CATALOG, c.exec));
      for (const [exec, models] of Object.entries(LIVE_CATALOG)) {
        if (models.length) out.push({ exec, models: models.slice() });
      }
      return out;
    }

    const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
    const EFFORT_TRAIL_RE = /@(minimal|min|low|medium|high|xhigh|extra-high|extra_high|max)$/i;

    function normalizeEffort(raw) {
      const s = String(raw === undefined || raw === null ? "" : raw).trim().toLowerCase();
      if (!s || s === "default" || s === "__default__" || s === "auto" || s === "none") return "";
      if (s === "minimal" || s === "min") return "low";
      if (s === "extra-high" || s === "extra_high") return "xhigh";
      return ["low", "medium", "high", "xhigh", "max"].includes(s) ? s : "";
    }

    function embeddedModelEffort(modelName) {
      const clean = String(modelName === undefined || modelName === null ? "" : modelName)
        .trim()
        .replace(/-from-.*$/, "")
        .replace(/-explicit$/, "")
        .replace(/-manual-attested$/, "")
        .replace(/^(?:dsh:)?.*\//, "")
        .replace(/^dsh:/, "")
        .toLowerCase();
      if (!clean) return "";
      const m = clean.match(/(?:^|[-_:])(low|medium|high|xhigh|max)$/);
      if (m && m[1]) return m[1];
      if (/(?:^|[-_/:])(thinking|reasoner)(?:$|[-_/:])/.test(clean) || /(?:^|-)r1(?:$|-)/.test(clean)) {
        return "thinking";
      }
      return "";
    }

    function seatSupportsEffort(exec) {
      const id = String(exec || "").trim().toLowerCase();
      if (!id) return false;
      if (BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.effortCapabilities && Object.prototype.hasOwnProperty.call(BRIDGE_SNAPSHOT.effortCapabilities, id)) {
        return Boolean(BRIDGE_SNAPSHOT.effortCapabilities[id]);
      }
      return id === "codex" || id === "claude" || id === "agy" || id === "dsh";
    }

    function seatEffortLevels(exec, curVal) {
      const id = String(exec || "").trim().toLowerCase();
      let base;
      if (
        BRIDGE_SNAPSHOT
        && BRIDGE_SNAPSHOT.effortLevels
        && Array.isArray(BRIDGE_SNAPSHOT.effortLevels[id])
        && BRIDGE_SNAPSHOT.effortLevels[id].length > 0
      ) {
        base = BRIDGE_SNAPSHOT.effortLevels[id].slice();
      } else if (id === "claude") {
        base = ["low", "medium", "high", "max"];
      } else if (id === "dsh") {
        base = EFFORT_LEVELS.concat(["max"]);
      } else {
        base = EFFORT_LEVELS.slice();
      }
      if (curVal && !base.includes(curVal)) base.push(curVal);
      return base;
    }

    function splitModelEffortSuffix(rawTail) {
      const s = String(rawTail || "").trim();
      const m = s.match(EFFORT_TRAIL_RE);
      if (!m) return { model: s, effort: "" };
      return { model: s.slice(0, m.index).trim(), effort: normalizeEffort(m[1]) };
    }

    function parseVoteRows(raw) {
      const text = String(raw || "").trim();
      if (!text) return [];
      return text.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const i = t.indexOf(":");
        if (i < 0) {
          const sp = splitModelEffortSuffix(t);
          return { executor: sp.model, model: "", effort: sp.effort };
        }
        const executor = t.slice(0, i).trim();
        const sp = splitModelEffortSuffix(t.slice(i + 1));
        return {
          executor,
          model: sp.model,
          effort: embeddedModelEffort(sp.model) ? "" : sp.effort,
        };
      }).filter((r) => Boolean(r.executor));
    }

    function voteRows(value) {
      return parseVoteRows(value && value.reviewVotes);
    }

    function voteString(rows) {
      if (!rows || rows.length === 0) return "";
      return rows.map((r) => {
        const mdl = String(r.model || "").trim();
        const eff = embeddedModelEffort(mdl) ? "" : normalizeEffort(r.effort);
        return r.executor + ":" + mdl + (eff ? ("@" + eff) : "");
      }).join(",");
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
          const items = ms.map((m) => {
            const rawId = String((m && (m.id || m.name)) || "").trim();
            const fullVal = rawId.indexOf(prov + "/") === 0 ? rawId : (prov + "/" + rawId);
            return {
              value: rawId ? fullVal : "",
              label: String((m && m.name) || rawId || "").trim(),
            };
          }).filter((x) => x.value && x.label && x.label !== "undefined");
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
      for (const g of groups || []) {
        for (const it of (g && g.items) || []) items.push(it);
      }
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
      for (const g of groups || []) {
        const items = (g.items || []).filter((it) => modelMatch(it, q));
        if (items.length) out.push({ label: g.label, items });
      }
      return out;
    }

    const DEFAULT_MODEL_OPTION = {
      value: "",
      label: "默认模型",
      isDefault: true,
    };

    function buildMenuView(groups, q) {
      const rawQ = String(q || "").trim();
      const allPreset = flattenGroups(groups);
      if (!rawQ) {
        const sections = [{ label: "", items: [DEFAULT_MODEL_OPTION] }];
        for (const g of groups || []) {
          if (g && Array.isArray(g.items) && g.items.length > 0) {
            sections.push({ label: g.label || "", items: g.items });
          }
        }
        return {
          sections,
          items: flattenGroups(sections),
          rawQ: "",
          presetCount: allPreset.length,
        };
      }
      const sections = filteredGroups(groups, rawQ).slice();
      const exactExists = allPreset.some((it) => it.value === rawQ);
      if (!exactExists) {
        sections.push({
          label: "",
          items: [{ value: rawQ, label: "使用自定义模型：" + rawQ, isCustom: true }],
        });
      }
      return {
        sections,
        items: flattenGroups(sections),
        rawQ,
        presetCount: allPreset.length,
      };
    }

    function menuProps(state, key, groups, value, onPick) {
      const { menu, setMenu } = state;
      const open = menu.key === key;
      const q = open ? String(menu.q || "") : "";
      const curVal = String(value === undefined || value === null ? "" : value);
      const items = buildMenuView(groups, q).items;
      const idxOf = (v) => {
        for (let i = 0; i < items.length; i++) if (items[i].value === v) return i;
        return -1;
      };
      const hi0 = Math.max(0, idxOf(curVal));
      return {
        open,
        q,
        showSearch: true,
        hi: open ? Math.min(Math.max(0, menu.hi || 0), Math.max(0, items.length - 1)) : hi0,
        onOpen: () => setMenu({ key, hi: hi0, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key, hi: i, q }),
        onQuery: (v) => {
          const next = buildMenuView(groups, v).items;
          const at = curVal ? next.findIndex((it) => it.value === curVal) : -1;
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

    // ── DSH 定制工具下拉框（彻底替代 Windows 原生丑灰框 <select>，支持 Prim.Menu 与离线 listbox 兜底）──
    const EXEC_EMPTY_ID = "__default__";

    function ExecPicker(props) {
      const p = props || {};
      const curVal = String(p.value === undefined || p.value === null ? "" : p.value);
      const options = Array.isArray(p.options) ? p.options : [];
      const disabled = Boolean(p.disabled);
      const open = Boolean(p.open);
      const hi = Number(p.hi || 0);
      const onOpen = p.onOpen;
      const onClose = p.onClose;
      const onMove = p.onMove;
      const onHover = p.onHover;
      const onPick = p.onPick;
      const ariaLabel = p.ariaLabel || "选择执行工具";

      const curOpt = options.find((o) => o.value === curVal) || options[0] || { value: curVal, label: curVal || "默认（按配置）", state: "idle" };
      const navKey = (e) => {
        const k = e && e.key;
        if (k === "ArrowDown" || k === "ArrowUp") {
          e.preventDefault();
          onMove(k === "ArrowDown" ? 1 : -1);
          return;
        }
        if (k === "Escape") {
          e.preventDefault();
          onClose();
          return;
        }
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          if (open && options[hi]) onPick(options[hi].value);
          else if (!open) onOpen();
        }
      };

      const triggerBtn = h("button", {
        type: "button",
        disabled,
        "aria-label": ariaLabel,
        "aria-haspopup": "listbox",
        "aria-expanded": open ? "true" : "false",
        className: "rdp-pick-btn rdp-exec-btn" + (open ? " is-open" : ""),
        onClick: () => { if (!disabled) (open ? onClose() : onOpen()); },
        onKeyDown: navKey,
      },
        h("span", { className: "rdp-pick-lead" },
          curOpt.value ? UiStateDot({ state: curOpt.state || "done", size: 7 }) : null,
          h("span", { className: "rdp-pick-label" }, curOpt.label)),
        ICO.chevronDown(14, "rdp-pick-caret"));

      if (Prim && typeof Prim.Menu === "function") {
        const menuItems = options.map((o) => ({
          id: o.value === "" ? EXEC_EMPTY_ID : o.value,
          label: o.label,
          icon: o.value ? UiStateDot({ state: o.state || "done", size: 8 }) : undefined,
        }));
        return h("div", { className: "rdp-pick rdp-exec-pick" },
          h(Prim.Menu, {
            open,
            anchor: triggerBtn,
            items: menuItems,
            selectedId: curVal === "" ? EXEC_EMPTY_ID : curVal,
            onSelect: (pickedId) => {
              const nextVal = pickedId === EXEC_EMPTY_ID ? "" : String(pickedId || "");
              onPick(nextVal);
            },
            onClose,
            align: "start",
            side: "bottom",
            portal: true,
            dense: true,
            autoFocus: true,
            selection: "check",
          }));
      }

      let list = null;
      if (open) {
        list = h("div", {
          className: "rdp-menu rdp-exec-menu",
          role: "listbox",
          "aria-label": ariaLabel,
          onKeyDown: navKey,
        },
          options.map((o, idx) => {
            const sel = o.value === curVal;
            return h("button", {
              type: "button",
              key: "ex:" + (o.value || EXEC_EMPTY_ID),
              role: "option",
              "data-exec-val": o.value,
              "aria-selected": sel ? "true" : "false",
              className: "rdp-menu-item" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
              onMouseEnter: () => onHover(idx),
              onClick: () => onPick(o.value),
              onKeyDown: navKey,
            },
              h("span", { className: "rdp-menu-lead" },
                o.value ? UiStateDot({ state: o.state || "done", size: 7 }) : null,
                h("span", { className: "rdp-menu-name" }, o.label)),
              sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, ICO.check(13)) : null);
          }));
      }

      return h("div", { className: "rdp-pick rdp-exec-pick" }, triggerBtn, list);
    }

    function execPickerNode(state, key, curExec, options, disabled, ariaLabel, onPick) {
      const { menu, setMenu } = state;
      const fullKey = "exec:" + key;
      const open = menu.key === fullKey;
      const curVal = String(curExec === undefined || curExec === null ? "" : curExec);
      const curIdx = Math.max(0, options.findIndex((o) => o.value === curVal));
      const hi = open ? Math.min(Math.max(0, menu.hi || 0), Math.max(0, options.length - 1)) : curIdx;
      return ExecPicker({
        value: curVal,
        options,
        disabled,
        ariaLabel,
        open,
        hi,
        onOpen: () => setMenu({ key: fullKey, hi: curIdx, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key: fullKey, hi: i, q: "" }),
        onMove: (d) => {
          const n = options.length;
          if (!n) return;
          const base = open ? (menu.hi || 0) : curIdx;
          setMenu({ key: fullKey, hi: ((base + d) % n + n) % n, q: "" });
        },
        onPick: (v) => {
          setMenu({ key: null, hi: 0, q: "" });
          onPick(v);
        },
      });
    }

    function ModelPicker(props) {
      const { value, groups, disabled, placeholder, open, hi, q, onOpen, onClose, onMove, onHover, onPick, onQuery } = props;
      const curVal = String(value === undefined || value === null ? "" : value);
      const all = flattenGroups(groups);
      const cur = all.filter((x) => x.value === curVal)[0];
      const label = cur ? cur.label : (curVal || placeholder);
      const built = buildMenuView(groups, q);
      const view = built.sections;
      const items = built.items;
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
        rows.push(h("div", { key: "__qwrap__", className: "rdp-search-box" },
          ICO.search(13, "rdp-search-ico"),
          h("input", {
            key: "__q__",
            className: "rdp-menu-search",
            type: "text",
            value: q === undefined ? "" : q,
            placeholder: "搜索已探测模型，或直接输入新模型名回车…",
            autoFocus: true,
            onChange: (e) => onQuery(e.target.value),
            onKeyDown: navKey,
          })));
        view.forEach((g, gi) => {
          rows.push(h("div", { className: "rdp-menu-sec", key: "sec:" + gi },
            g.label ? h("div", { className: "rdp-menu-cap" }, g.label) : null,
            g.items.map((it) => {
              const idx = items.indexOf(it);
              const sel = it.value === curVal && !it.isCustom;
              return h("button", {
                type: "button",
                key: (it.isDefault ? "__default__" : (it.isCustom ? "__custom__:" : "m:")) + it.value,
                className: "rdp-menu-item" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
                role: "option",
                "aria-selected": sel ? "true" : "false",
                title: it.value || "使用工具自身默认模型",
                onMouseEnter: () => onHover(idx),
                onClick: () => onPick(it.value),
              },
                h("span", { className: "rdp-menu-name" }, it.label),
                sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, ICO.check(13)) : null);
            })));
        });
        if (!built.rawQ && built.presetCount === 0) {
          rows.push(h("div", { key: "__empty_hint__", className: "rdp-menu-empty" },
            "暂未探测到本地预设模型，可直接在上方输入框键入任意模型名回车选用"));
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
          ICO.chevronDown(14, "rdp-pick-caret")),
        list);
    }

    function pickerNode(state, key, exec, cat, value, disabled, placeholder, onPick) {
      const groups = groupedModels(exec, cat);
      return ModelPicker(Object.assign(
        { value, groups, disabled, placeholder },
        menuProps(state, key, groups, value, onPick),
      ));
    }

    // ── 思考强度选择器（Prim.Menu + 仅模型内置 *-high/*-thinking 时显示只读随模型态）──
    function EffortPicker(props) {
      const p = props || {};
      const curExec = String(p.exec || "").trim();
      const curModel = String(p.model || "").trim();
      const embedded = embeddedModelEffort(p.effectiveModel || curModel);
      const curVal = embedded ? "" : normalizeEffort(p.value);
      const disabled = Boolean(p.disabled);
      const supported = !curExec || seatSupportsEffort(curExec);
      const open = Boolean(p.open) && !embedded && supported && !disabled;
      const hi = Number(p.hi || 0);
      const onOpen = p.onOpen;
      const onClose = p.onClose;
      const onMove = p.onMove;
      const onHover = p.onHover;
      const onPick = p.onPick;
      const ariaLabel = p.ariaLabel || "思考强度";

      if (embedded) {
        const coupledBtn = h("button", {
          type: "button",
          disabled: true,
          "aria-disabled": "true",
          "aria-label": ariaLabel + "：随模型内置（" + embedded + "）",
          "data-effort-mode": "coupled",
          className: "rdp-pick-btn rdp-effort-btn is-coupled is-readonly",
          title: "所选模型已内置思考强度（" + embedded + "），随模型生效且不可覆盖",
        },
          h("span", { className: "rdp-pick-lead" },
            ICO.lock(11, "rdp-pick-caret"),
            h("span", { className: "rdp-pick-label" }, "随模型 · " + embedded)));
        return h("div", { className: "rdp-pick rdp-effort-pick" }, coupledBtn);
      }

      if (curExec && !supported) {
        const unsupBtn = h("button", {
          type: "button",
          disabled: true,
          "aria-disabled": "true",
          "aria-label": ariaLabel + "：当前席位不支持覆盖",
          "data-effort-mode": "unsupported",
          className: "rdp-pick-btn rdp-effort-btn is-unsupported is-readonly",
          title: curExec + " 未开放独立思考强度参数，运行期将安全忽略",
        },
          h("span", { className: "rdp-pick-lead" },
            h("span", { className: "rdp-pick-label" }, "默认 · 不透传")));
        return h("div", { className: "rdp-pick rdp-effort-pick" }, unsupBtn);
      }

      const tiers = seatEffortLevels(curExec, curVal);
      const options = [{ value: "", label: "默认" }].concat(tiers.map((lv) => ({ value: lv, label: lv })));
      const curOpt = options.find((o) => o.value === curVal) || options[0];

      const navKey = (e) => {
        const k = e && e.key;
        if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); onMove(k === "ArrowDown" ? 1 : -1); return; }
        if (k === "Escape") { e.preventDefault(); onClose(); return; }
        if (k === "Enter" || k === " ") {
          e.preventDefault();
          if (open && options[hi]) onPick(options[hi].value);
          else if (!open) onOpen();
        }
      };

      const triggerBtn = h("button", {
        type: "button",
        disabled,
        "aria-label": ariaLabel,
        "aria-haspopup": "listbox",
        "aria-expanded": open ? "true" : "false",
        "data-effort-mode": "selectable",
        className: "rdp-pick-btn rdp-effort-btn" + (open ? " is-open" : ""),
        title: "设置独立思考强度参数（默认跟随工具自身配置）",
        onClick: () => { if (!disabled) (open ? onClose() : onOpen()); },
        onKeyDown: navKey,
      },
        h("span", { className: "rdp-pick-lead" },
          h("span", { className: "rdp-pick-label rdp-num" }, "思考 · " + curOpt.label)),
        ICO.chevronDown(12, "rdp-pick-caret"));

      if (Prim && typeof Prim.Menu === "function") {
        const menuItems = options.map((o) => ({
          id: o.value === "" ? EXEC_EMPTY_ID : o.value,
          label: o.label,
        }));
        return h("div", { className: "rdp-pick rdp-effort-pick" },
          h(Prim.Menu, {
            open,
            anchor: triggerBtn,
            items: menuItems,
            selectedId: curVal === "" ? EXEC_EMPTY_ID : curVal,
            onSelect: (pickedId) => {
              const nextVal = pickedId === EXEC_EMPTY_ID ? "" : String(pickedId || "");
              onPick(nextVal);
            },
            onClose,
            align: "end",
            side: "bottom",
            portal: true,
            dense: true,
            autoFocus: true,
            selection: "check",
          }));
      }

      let list = null;
      if (open) {
        list = h("div", {
          className: "rdp-menu rdp-effort-menu",
          role: "listbox",
          "aria-label": ariaLabel,
          onKeyDown: navKey,
        },
          options.map((o, idx) => {
            const sel = o.value === curVal;
            return h("button", {
              type: "button",
              key: "eff:" + (o.value || EXEC_EMPTY_ID),
              role: "option",
              "data-effort-val": o.value,
              "aria-selected": sel ? "true" : "false",
              className: "rdp-menu-item rdp-num" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
              onMouseEnter: () => onHover(idx),
              onClick: () => onPick(o.value),
              onKeyDown: navKey,
            },
              h("span", { className: "rdp-menu-name" }, o.label),
              sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, ICO.check(13)) : null);
          }));
      }

      return h("div", { className: "rdp-pick rdp-effort-pick" }, triggerBtn, list);
    }

    function effortPickerNode(state, key, curExec, curModel, effectiveModel, curEffort, disabled, ariaLabel, onPick) {
      const { menu, setMenu } = state;
      const fullKey = "effort:" + key;
      const open = menu.key === fullKey;
      const curVal = normalizeEffort(curEffort);
      const tiers = seatEffortLevels(curExec, curVal);
      const vals = [""].concat(tiers);
      const curIdx = Math.max(0, vals.indexOf(curVal));
      const hi = open ? Math.min(Math.max(0, menu.hi || 0), vals.length - 1) : curIdx;
      return EffortPicker({
        exec: curExec,
        model: curModel,
        effectiveModel,
        value: curVal,
        disabled,
        ariaLabel,
        open,
        hi,
        onOpen: () => setMenu({ key: fullKey, hi: curIdx, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key: fullKey, hi: i, q: "" }),
        onMove: (d) => {
          const n = vals.length;
          const base = open ? (menu.hi || 0) : curIdx;
          setMenu({ key: fullKey, hi: ((base + d) % n + n) % n, q: "" });
        },
        onPick: (v) => {
          setMenu({ key: null, hi: 0, q: "" });
          onPick(v);
        },
      });
    }

    // ── SVG 拓扑辅助函数、视口缩放边界与四类节点专属线性矢量图标 ────────────
    const NODE_W = 204;
    const NODE_H = 66;
    const ZOOM_MIN = 0.65;
    const ZOOM_MAX = 1.65;
    const ZOOM_STEP = 0.15;

    function clampZoom(z) {
      const n = Number(z);
      if (!Number.isFinite(n)) return 1;
      return Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n)) * 100) / 100;
    }

    function cubicEdgePath(fromNode, toNode) {
      if (!fromNode || !toNode) return "";
      const x1 = Number(fromNode.x || 0) + NODE_W / 2 - 4;
      const y1 = Number(fromNode.y || 0);
      const x2 = Number(toNode.x || 0) - NODE_W / 2 + 4;
      const y2 = Number(toNode.y || 0);
      const dx = Math.max(48, Math.abs(x2 - x1) * 0.48);
      return "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2;
    }

    function nodeAccentColor(node) {
      if (!node) return "#73726c";
      if (node.status === "working") return "#c96442";
      if (node.status === "failed") return "#dc2626";
      if (node.seat && SEAT_COLORS[node.seat]) return SEAT_COLORS[node.seat];
      if (node.kind === "hub") return "#c96442";
      if (node.kind === "gate") return node.status === "done" ? "#059669" : "#d97706";
      if (node.kind === "artifact" || node.kind === "input") return "#5e5d59";
      return "#73726c";
    }

    function renderNodeKindGlyph(kind, accent) {
      const k = String(kind || "artifact");
      const common = { fill: "none", stroke: accent, strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };
      if (k === "hub") {
        // 调度中枢：中心节点与双向分流分支
        return h("g", Object.assign({ transform: "translate(10, 13)" }, common),
          h("circle", { cx: 3.5, cy: 7, r: 2 }),
          h("circle", { cx: 11.5, cy: 3.5, r: 1.8 }),
          h("circle", { cx: 11.5, cy: 10.5, r: 1.8 }),
          h("path", { d: "M5.4 6.2L9.7 4.2M5.4 7.8L9.7 9.8" }));
      }
      if (k === "worker") {
        // 独立沙箱 Worker：隔离方舱终端
        return h("g", Object.assign({ transform: "translate(10, 13)" }, common),
          h("rect", { x: 1.5, y: 2, width: 12, height: 10, rx: 2.2 }),
          h("path", { d: "M4.5 5.5L6.5 7L4.5 8.5M8 8.5h2.5" }));
      }
      if (k === "gate") {
        // 人类拍板闸门：护盾与核准勾号
        return h("g", Object.assign({ transform: "translate(10, 13)" }, common),
          h("path", { d: "M7.5 1.5l5 1.9v3.6c0 3-1.9 4.8-5 5.8-3.1-1-5-2.8-5-5.8V3.4l5-1.9Z" }),
          h("path", { d: "M5.3 7.1l1.6 1.6 3.1-3.2" }));
      }
      // 推式输入源 / 落盘契约：结构化文稿锚点
      return h("g", Object.assign({ transform: "translate(10, 13)" }, common),
        h("rect", { x: 2.2, y: 1.5, width: 10.6, height: 11, rx: 2 }),
        h("path", { d: "M5 5h5M5 7.5h5M5 10h3.2" }));
    }

    function truncSvgText(str, maxLen) {
      const s = String(str || "").trim();
      if (s.length <= maxLen) return s;
      return s.slice(0, Math.max(1, maxLen - 1)) + "…";
    }

    function humanIdeaCode(ideaId) {
      const raw = String(ideaId || "").trim();
      if (!raw) return "当前方案";
      const m = raw.match(/^idea[_-]?0*(\d+)$/i);
      if (m) return "方案 " + m[1];
      return raw.replace(/\.md$/i, "").replace(/[_-]+/g, " ");
    }

    function cleanIdeaTitle(ideaId, title) {
      let t = String(title || "").trim();
      if (!t) return "";
      if (ideaId) {
        const esc = String(ideaId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        t = t.replace(new RegExp("^" + esc + "\\s*[:：—–-]\\s*", "i"), "").trim();
        if (t.toLowerCase() === String(ideaId).toLowerCase()) return "";
      }
      t = t.replace(/^idea[_-]?0*\d+\s*[:：—–-]\s*/i, "").trim();
      return t;
    }

    function humanIdeaLabel(ideaId, title, maxLen) {
      const clean = cleanIdeaTitle(ideaId, title);
      if (clean) return maxLen ? truncSvgText(clean, maxLen) : clean;
      return humanIdeaCode(ideaId);
    }

    function formatElapsed(startedAt, durationMs) {
      if (Number.isFinite(durationMs) && durationMs > 0) {
        const sec = Math.max(1, Math.round(durationMs / 1000));
        return sec >= 60 ? (Math.floor(sec / 60) + "m" + (sec % 60) + "s") : (sec + "s");
      }
      if (startedAt && Number(startedAt) > 0) {
        const sec = Math.max(1, Math.floor((Date.now() - Number(startedAt)) / 1000));
        return sec >= 60 ? (Math.floor(sec / 60) + "m" + (sec % 60) + "s") : (sec + "s");
      }
      return "";
    }

    function SettingsNavIcon() {
      if (Prim && typeof Prim.IconBranchOutline16 === "function") {
        return h("span", { className: "rdp-ico-wrap", "aria-hidden": "true" }, h(Prim.IconBranchOutline16, { size: 16 }));
      }
      return h("svg", {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
        style: { display: "block", flex: "0 0 auto" },
      },
        h("circle", { cx: 3.2, cy: 8, r: 1.8, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 8.2, cy: 3.5, r: 1.7, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 8.2, cy: 12.5, r: 1.7, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 13, cy: 8, r: 1.9, stroke: "currentColor", strokeWidth: 1.4 }),
        h("path", { d: "M4.8 7.1L6.7 4.5M4.8 8.9L6.7 11.5M9.8 4.5L11.5 7M9.8 11.5L11.5 9", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
      );
    }

    // ── /swarm 科研拓扑星图工作台组件（支持滚轮缩放 0.65x–1.65x、拖拽平移与人类拍板台）──
    function SwarmStudio(props) {
      const embedded = Boolean(props.embedded);
      const propRoot = String(props.repoRoot || "").trim();
      const [overrideRoot, setOverrideRoot] = React.useState("");
      const [topic, setTopic] = React.useState("");
      const [focusStage, setFocusStage] = React.useState("");
      const [focusIdeaId, setFocusIdeaId] = React.useState("");
      const [selectedNodeId, setSelectedNodeId] = React.useState("");
      const [inspectorTab, setInspectorTab] = React.useState("overview");
      const [verdictChoice, setVerdictChoice] = React.useState("go");
      const [verdictNote, setVerdictNote] = React.useState("");
      const [appendDeadEnd, setAppendDeadEnd] = React.useState(false);
      const [deadEndSummary, setDeadEndSummary] = React.useState("");
      const [draftAnchor, setDraftAnchor] = React.useState(null);
      const [busyMsg, setBusyMsg] = React.useState("");
      const [actionFeedback, setActionFeedback] = React.useState(null);
      const [viewport, setViewport] = React.useState({ zoom: 1, panX: 0, panY: 0 });
      const [isPanning, setIsPanning] = React.useState(false);
      const [panDrag] = React.useState(() => ({ active: false, pointerId: null, startX: 0, startY: 0, baseX: 0, baseY: 0 }));
      const [localSnap, setLocalSnap] = React.useState(() => SWARM_SNAPSHOT || null);
      const [snapReqState] = React.useState(() => ({ seq: 0, actionSeq: 0, contextKey: "", draftRev: 0 }));
      const [, setSnapSeq] = React.useState(0);

      const effectiveReqRoot = overrideRoot || (!isDshProfilePath(propRoot) ? propRoot : "");
      const currentContextKey = effectiveReqRoot + "|" + String(topic || "");
      snapReqState.contextKey = currentContextKey;

      const loadSnapshot = () => {
        const mySeq = ++snapReqState.seq;
        fetchSwarmSnapshot({
          repoRoot: effectiveReqRoot,
          topic,
          focusStage,
          focusIdeaId,
        }).then((nextSnap) => {
          if (mySeq !== snapReqState.seq) return;
          if (nextSnap && typeof nextSnap === "object") {
            setLocalSnap(nextSnap);
          } else if (!SWARM_SNAPSHOT) {
            setLocalSnap(null);
          }
        });
      };

      React.useEffect(() => {
        let alive = true;
        const onSnap = () => { if (alive) setSnapSeq((n) => n + 1); };
        bridgeWatchers.add(onSnap);
        loadSnapshot();
        const curActiveSnap = localSnap || SWARM_SNAPSHOT;
        const intervalMs = curActiveSnap && curActiveSnap.activeWorkerCount > 0 ? 1500 : 5000;
        const iv = setInterval(() => {
          if (!alive) return;
          loadSnapshot();
        }, intervalMs);
        return () => {
          alive = false;
          clearInterval(iv);
          bridgeWatchers.delete(onSnap);
        };
      }, [effectiveReqRoot, topic, focusStage, focusIdeaId, CONN_SEQ, localSnap && localSnap.activeWorkerCount]);

      React.useEffect(() => {
        if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
        const stopPan = () => {
          if (panDrag.active) {
            panDrag.active = false;
            panDrag.pointerId = null;
            setIsPanning(false);
          }
        };
        window.addEventListener("blur", stopPan);
        return () => window.removeEventListener("blur", stopPan);
      }, []);

      const stepZoom = (delta) => {
        setViewport((prev) => ({
          zoom: clampZoom((prev && prev.zoom ? prev.zoom : 1) + delta),
          panX: prev ? prev.panX : 0,
          panY: prev ? prev.panY : 0,
        }));
      };
      const resetViewport = () => {
        panDrag.active = false;
        panDrag.pointerId = null;
        setIsPanning(false);
        setViewport({ zoom: 1, panX: 0, panY: 0 });
      };

      const onCanvasWheel = (e) => {
        if (!e) return;
        if (typeof e.preventDefault === "function") e.preventDefault();
        const dy = Number(e.deltaY || 0);
        if (dy === 0) return;
        stepZoom(dy < 0 ? ZOOM_STEP : -ZOOM_STEP);
      };

      const onCanvasPointerDown = (e) => {
        if (!e) return;
        if (e.button !== undefined && e.button !== 0) return;
        const t = e.target;
        if (t && typeof t.closest === "function" && (t.closest(".rdp-gnode") || t.closest(".rdp-zoom-bar"))) {
          return;
        }
        panDrag.active = true;
        panDrag.pointerId = e.pointerId !== undefined ? e.pointerId : 1;
        panDrag.startX = Number(e.clientX || 0);
        panDrag.startY = Number(e.clientY || 0);
        panDrag.baseX = Number(viewport.panX || 0);
        panDrag.baseY = Number(viewport.panY || 0);
        setIsPanning(true);
        if (e.currentTarget && typeof e.currentTarget.setPointerCapture === "function" && e.pointerId !== undefined) {
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        }
      };

      const onCanvasPointerMove = (e) => {
        if (!panDrag.active || !e) return;
        const dx = Number(e.clientX || 0) - panDrag.startX;
        const dy = Number(e.clientY || 0) - panDrag.startY;
        setViewport((prev) => ({
          zoom: prev ? prev.zoom : 1,
          panX: Math.round(panDrag.baseX + dx),
          panY: Math.round(panDrag.baseY + dy),
        }));
      };

      const endCanvasPan = (e) => {
        if (!panDrag.active) return;
        if (e && e.currentTarget && typeof e.currentTarget.releasePointerCapture === "function" && panDrag.pointerId !== null) {
          try { e.currentTarget.releasePointerCapture(panDrag.pointerId); } catch { /* 忽略 */ }
        }
        panDrag.active = false;
        panDrag.pointerId = null;
        setIsPanning(false);
      };

      const snap = SWARM_SNAPSHOT ? (localSnap || SWARM_SNAPSHOT) : null;
      const stages = (snap && Array.isArray(snap.stages)) ? snap.stages : [];
      const ideas = (snap && Array.isArray(snap.ideas)) ? snap.ideas : [];
      const topics = (snap && Array.isArray(snap.topics)) ? snap.topics : [];
      const workspaces = (snap && Array.isArray(snap.workspaces) && snap.workspaces.length > 0)
        ? snap.workspaces
        : ((BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.workspaces) || []);
      const graph = (snap && snap.graph) || { focusStage: "S4", focusIdeaId: "", nodes: [], edges: [] };
      const nodeList = Array.isArray(graph.nodes) ? graph.nodes : [];
      const edgeList = Array.isArray(graph.edges) ? graph.edges : [];
      const nodeById = new Map(nodeList.map((n) => [n.id, n]));

      const selectedNode = (selectedNodeId && nodeById.get(selectedNodeId))
        || nodeList.find((n) => n.kind === "gate")
        || nodeList.find((n) => n.kind === "worker")
        || nodeList[0]
        || null;
      const inspect = (selectedNode && selectedNode.inspect) || null;
      const curStage = graph.focusStage || focusStage || "S4";
      const curIdeaId = graph.focusIdeaId || focusIdeaId || (ideas[0] ? ideas[0].ideaId : "");
      const activeWorkers = Number((snap && snap.activeWorkerCount) || 0);

      const zoomVal = clampZoom(viewport.zoom);
      const panX = Number(viewport.panX || 0);
      const panY = Number(viewport.panY || 0);
      const zoomPct = Math.round(zoomVal * 100) + "%";
      const stageTransform = "translate(" + (490 + panX) + "," + (260 + panY) + ") scale(" + zoomVal + ") translate(-490,-260)";

      const runAction = (payload, label) => {
        const targetRoot = effectiveReqRoot || (snap && snap.repoRoot) || "";
        if (!snap || (effectiveReqRoot && snap.repoRoot && snap.repoRoot !== effectiveReqRoot)) {
          setActionFeedback({ ok: false, text: "工作区正在切换同步中，请稍候刷新后再提交" });
          loadSnapshot();
          return;
        }
        if (topic && snap.activeTopic && snap.activeTopic !== topic) {
          setActionFeedback({ ok: false, text: "课题正在切换同步中，请稍候刷新后再提交" });
          loadSnapshot();
          return;
        }
        const effectiveTopic = (payload && payload.topic) || (snap && snap.activeTopic) || topic || "default";
        const myActionSeq = ++snapReqState.actionSeq;
        snapReqState.seq += 1;
        const startContextKey = currentContextKey;
        const startDraftRev = snapReqState.draftRev;
        setBusyMsg(label || "正在执行…");
        setActionFeedback(null);
        postDispatchAction(Object.assign({
          repoRoot: targetRoot,
          topic: effectiveTopic,
          focusStage: curStage,
          focusIdeaId: curIdeaId,
        }, payload))
          .then((res) => {
            if (myActionSeq === snapReqState.actionSeq) setBusyMsg("");
            if (startContextKey !== snapReqState.contextKey || myActionSeq !== snapReqState.actionSeq) return;
            if (res && res.snapshot && typeof res.snapshot === "object") {
              // 推进本地读序号，使动作期间发出的陈旧轮询不再回写旧盘面
              snapReqState.seq += 1;
              setLocalSnap(res.snapshot);
            }
            const val = (res && res.value) || {};
            let msg = "";
            if (val.verdictRel) {
              // 仅在提交期间草稿未被用户再次编辑时清空全部草稿字段（含 verdictChoice 重置为 go）
              if (snapReqState.draftRev === startDraftRev) {
                setDraftAnchor(null);
                setVerdictChoice("go");
                setVerdictNote("");
                setDeadEndSummary("");
                setAppendDeadEnd(false);
              }
              msg = "已写入裁决：" + val.verdictRel
                + (val.deadEndError ? ("（警告：" + val.deadEndError + "）") : "");
            } else if (val.mode === "async" || val.async) {
              msg = "已在后台沙箱启动派工（PID " + (val.pid || "active") + "）"
                + (val.warning ? ("（警告：" + val.warning + "）") : "");
            } else {
              msg = val.message || "操作已完成并刷新盘面";
            }
            setActionFeedback({ ok: true, text: msg });
          })
          .catch((err) => {
            if (myActionSeq === snapReqState.actionSeq) setBusyMsg("");
            if (startContextKey !== snapReqState.contextKey || myActionSeq !== snapReqState.actionSeq) return;
            setActionFeedback({ ok: false, text: String((err && err.message) || err) });
          });
      };

      const actionLabels = {
        init: "初始化课题骨架",
        pool: "汇总文献池",
        summary: "重算降序榜单",
        "run-brief": "启动多票盲审",
        "run-novelty": "发起前置查重",
      };

      const activeIdeaObj = ideas.find((it) => it.ideaId === curIdeaId) || ideas[0] || null;
      const gateIdeaNode = nodeList.find((n) => n && n.inspect && n.inspect.canVerdict && n.inspect.ideaId) || null;
      const resolveIdeaSha = (iid) => {
        const found = ideas.find((it) => it && it.ideaId === iid);
        return (found && (found.sha || found.rawSha)) || "";
      };
      const verdictTarget = (inspect && inspect.canVerdict && inspect.ideaId)
        ? {
          ideaId: inspect.ideaId,
          topic: inspect.topic || (snap && snap.activeTopic) || "default",
          currentVerdict: inspect.currentVerdict || (activeIdeaObj && activeIdeaObj.verdict) || "pending",
          briefSha: inspect.sha || resolveIdeaSha(inspect.ideaId),
        }
        : (gateIdeaNode
          ? {
            ideaId: gateIdeaNode.inspect.ideaId,
            topic: gateIdeaNode.inspect.topic || (snap && snap.activeTopic) || "default",
            currentVerdict: gateIdeaNode.inspect.currentVerdict || (activeIdeaObj && activeIdeaObj.verdict) || "pending",
            briefSha: gateIdeaNode.inspect.sha || resolveIdeaSha(gateIdeaNode.inspect.ideaId),
          }
          : null);
      const curVerdictAnchor = verdictTarget
        ? {
          repoRoot: effectiveReqRoot || (snap && snap.repoRoot) || "",
          topic: verdictTarget.topic,
          ideaId: verdictTarget.ideaId,
          briefSha: verdictTarget.briefSha || "",
        }
        : null;
      const isSameAnchor = (a, b) => Boolean(
        a && b
        && a.repoRoot === b.repoRoot
        && a.topic === b.topic
        && a.ideaId === b.ideaId
        && a.briefSha === b.briefSha,
      );
      const hasDraftEdits = Boolean(
        draftAnchor
        && (verdictNote.trim() || deadEndSummary.trim() || verdictChoice !== "go" || appendDeadEnd),
      );
      const draftAnchorConflict = Boolean(hasDraftEdits && curVerdictAnchor && !isSameAnchor(draftAnchor, curVerdictAnchor));
      const bindDraftAnchorIfNeeded = () => {
        snapReqState.draftRev += 1;
        if (!draftAnchor && curVerdictAnchor) setDraftAnchor(curVerdictAnchor);
      };
      const clearVerdictDraft = () => {
        snapReqState.draftRev += 1;
        setDraftAnchor(null);
        setVerdictChoice("go");
        setVerdictNote("");
        setAppendDeadEnd(false);
        setDeadEndSummary("");
      };
      const hasAuditTabContent = Boolean(
        (inspect && Array.isArray(inspect.pushedInputs) && inspect.pushedInputs.length > 0)
        || (inspect && inspect.preview),
      );
      const effectiveTab = inspectorTab === "audit" && hasAuditTabContent ? "audit" : "overview";

      return h("div", { className: "rdp-swarm-shell" + (embedded ? " is-embedded" : "") },
        (!embedded && SWARM_ROUTE_MISSING) ? h("div", { className: "rdp-state rdp-warn", key: "swarm-route-warn" },
          "检测到后台仍驻留旧版进程，暂未开放实时拓扑通道。请右键右下角系统托盘中的 DeepSeek Harness 图标选择「退出」后重新打开。") : null,

        // 顶部工作区、课题与实时活性状态栏
        h("div", { className: "rdp-swarm-bar", key: "bar" },
          h("div", { className: "rdp-swarm-bar-l" },
            UiTag({ tone: "quiet" }, [ICO.folder(13), "项目"]),
            h("code", null, (snap && snap.repoName) || (effectiveReqRoot ? effectiveReqRoot.split(/[\\/]/).pop() : "正在探测科研工作区…")),
            topics.map((tp) => {
              const tpId = tp.id || tp.slug || "default";
              const active = (snap ? snap.activeTopic : topic) === tpId;
              return h("button", {
                type: "button",
                key: "tp:" + tpId,
                className: "rdp-topic-pill rdp-num" + (active ? " is-active" : ""),
                onClick: () => { setTopic(tpId); setFocusIdeaId(""); setSelectedNodeId(""); },
              }, tp.label + " (" + tp.briefCount + ")");
            })),
          h("div", { className: "rdp-swarm-bar-r" },
            h("span", { className: "rdp-hdr-pill rdp-num" + (activeWorkers > 0 ? " is-working" : ""), style: { cursor: "default" } },
              UiStateDot({ state: activeWorkers > 0 ? "ongoing" : "done", size: 7 }),
              activeWorkers > 0 ? (activeWorkers + " 个沙箱 Worker 运行中") : "沙箱空闲就绪"),
            snap && snap.initialized === false ? UiButton({
              variant: "primary",
              size: "sm",
              disabled: !!busyMsg,
              onClick: () => runAction({ kind: "init" }, "初始化骨架…"),
            }, "初始化课题骨架") : null,
            UiButton({
              variant: "outline",
              size: "sm",
              icon: ICO.refresh(13),
              onClick: loadSnapshot,
            }, "刷新拓扑"))),

        // 若当前工作区非科研项目且存在已发现科研项目，给出 1-Click 工作区快切胶囊
        workspaces.some((w) => w.isResearch) && snap && snap.initialized === false
          ? h("div", { className: "rdp-ws-strip", key: "ws-quick" },
            h("span", { className: "rdp-ws-cap" }, "切换至科研工作区："),
            workspaces.filter((w) => w.isResearch).slice(0, 6).map((ws) => {
              const wsDir = ws.dir || ws.path;
              return h("button", {
                type: "button",
                key: "sws:" + wsDir,
                className: "rdp-ws-pill" + (snap.repoRoot === wsDir ? " is-active" : ""),
                onClick: () => {
                  setOverrideRoot(wsDir);
                  if (typeof props.onSelectRepoRoot === "function") props.onSelectRepoRoot(wsDir);
                },
              }, h("span", { className: "rdp-ws-star" }, ICO.sparkle(12)), ws.name);
            }))
          : null,

        // S0 → S6 八阶段全链路进度轨
        stages.length > 0 ? h("div", { className: "rdp-rail", key: "rail", role: "tablist", "aria-label": "科研闭环阶段轨" },
          stages.map((stg) => {
            const isSel = curStage === stg.id;
            return h("button", {
              type: "button",
              key: stg.id,
              role: "tab",
              "aria-selected": isSel ? "true" : "false",
              className: "rdp-stage-card" + (isSel ? " is-active" : ""),
              onClick: () => { setFocusStage(stg.id); setSelectedNodeId(""); },
            },
              h("div", { className: "rdp-stage-top" },
                h("span", { className: "rdp-stage-id rdp-num" }, stg.code || stg.id),
                h("span", { className: "rdp-stage-dot st-" + (stg.status || "ready") })),
              h("span", { className: "rdp-stage-name" }, stg.title || stg.label),
              h("span", { className: "rdp-stage-cnt rdp-num" }, stg.badge || stg.countText || "就绪"));
          })) : null,

        // 候选方案降序快捷切换条（按五维 /25 综合排名排列，隐藏内部下划线编号）
        ideas.length > 0 && (curStage === "S3" || curStage === "S4" || curStage === "S4.5" || curStage === "S5")
          ? h("div", { className: "rdp-ideas-strip", key: "ideas-strip" },
            ideas.map((it) => {
              const isCur = curIdeaId === it.ideaId;
              const dec = it.humanDecision || (it.verdict && it.verdict !== "pending" ? it.verdict : "");
              const vTag = dec
                ? { cls: "rdp-vtag-" + dec, text: dec.toUpperCase() }
                : (it.voteCount > 0 ? { cls: "rdp-vtag-pending", text: "待拍板" } : null);
              const scoreLabel = it.meanScore25 !== null && it.meanScore25 !== undefined
                ? (" · " + Number(it.meanScore25).toFixed(1) + "/25")
                : "";
              const friendlyName = humanIdeaLabel(it.ideaId, it.title, 16);
              const fullTitle = cleanIdeaTitle(it.ideaId, it.title);
              return h("button", {
                type: "button",
                key: it.ideaId,
                className: "rdp-idea-chip rdp-num" + (isCur ? " is-active" : ""),
                title: fullTitle ? (humanIdeaCode(it.ideaId) + "：" + fullTitle) : humanIdeaCode(it.ideaId),
                onClick: () => { setFocusIdeaId(it.ideaId); setSelectedNodeId(""); },
              },
                it.rank ? ("#" + it.rank + " ") : "",
                friendlyName,
                scoreLabel,
                vTag ? h("span", { className: "rdp-vtag " + vTag.cls }, vTag.text) : null);
            }))
          : null,

        // 主体分栏：左侧可缩放平移 SVG /swarm 拓扑画布 + 右侧检查器与人类拍板台
        h("div", { className: "rdp-swarm-body", key: "body" },
          h("div", { className: "rdp-canvas-card" },
            nodeList.length === 0
              ? h("div", {
                className: "rdp-state" + ((!snap && (SWARM_ROUTE_MISSING || SWARM_LAST_ERROR)) ? " rdp-warn" : ""),
                style: { margin: 20 },
              },
                snap
                  ? "当前阶段暂无拓扑节点，请点击上方阶段轨或先初始化课题骨架。"
                  : SWARM_ROUTE_MISSING
                    ? "后台仍驻留旧版进程，请右键右下角系统托盘中的 DeepSeek Harness 图标选择「退出」后重新打开。"
                    : SWARM_LAST_ERROR
                      ? ("实时拓扑同步未成功：" + SWARM_LAST_ERROR + "（可点击右上角「刷新拓扑」重试）")
                      : "正在同步实时科研拓扑盘面…")
              : h("div", {
                className: "rdp-canvas-viewport" + (isPanning ? " is-panning" : ""),
                onWheel: onCanvasWheel,
                onPointerDown: onCanvasPointerDown,
                onPointerMove: onCanvasPointerMove,
                onPointerUp: endCanvasPan,
                onPointerCancel: endCanvasPan,
                onLostPointerCapture: endCanvasPan,
              },
                  h("svg", {
                    className: "rdp-svg",
                    viewBox: "0 0 980 520",
                    role: "img",
                    "aria-label": "科研派工 Swarm 关系与进度拓扑星图",
                  },
                    h("defs", null,
                      h("filter", { id: "rdp-node-shadow", x: "-8%", y: "-10%", width: "116%", height: "126%" },
                        h("feDropShadow", { dx: 0, dy: 2, stdDeviation: 3, floodColor: "#000000", floodOpacity: 0.06 })),
                      h("clipPath", { id: "rdp-clip-title" },
                        h("rect", { x: 28, y: 6, width: NODE_W - 102, height: 26 })),
                      h("clipPath", { id: "rdp-clip-sub" },
                        h("rect", { x: 11, y: 34, width: NODE_W - 22, height: 26 }))),

                    h("g", { className: "rdp-svg-stage", transform: stageTransform },
                      // 顶部分列导引标题（无 Unicode 圆圈序号）
                      [
                        { x: 118, t: "01 · 输入源" },
                        { x: 342, t: "02 · 派工" },
                        { x: 590, t: "03 · Workers" },
                        { x: 848, t: "04 · 裁决" },
                      ].map((col, ci) => h("text", {
                        key: "colhdr:" + ci,
                        x: col.x,
                        y: 28,
                        textAnchor: "middle",
                        fontSize: 11,
                        fontWeight: 600,
                        fill: "var(--dsw-alias-label-tertiary,#73726c)",
                      }, col.t)),

                      // 三次贝塞尔平滑连线 + 仅在 working 连线上流动的微光脉冲点
                      edgeList.map((ed) => {
                        const fn = nodeById.get(ed.from);
                        const tn = nodeById.get(ed.to);
                        const d = cubicEdgePath(fn, tn);
                        if (!d) return null;
                        const isWorkingEdge = ed.status === "working";
                        return h("g", { key: ed.id, className: "rdp-edge-wrap" },
                          h("path", {
                            d,
                            className: "rdp-edge st-" + (ed.status || "ready"),
                          }),
                          isWorkingEdge ? h("circle", {
                            r: 3.2,
                            className: "rdp-edge-pulse",
                          }, h("animateMotion", {
                            dur: "1.6s",
                            repeatCount: "indefinite",
                            path: d,
                          })) : null);
                      }),

                      // 节点卡片群（分栏裁切零重叠 + 4 类节点专属线性矢量图标）
                      nodeList.map((nd) => {
                        const nx = Number(nd.x || 0) - NODE_W / 2;
                        const ny = Number(nd.y || 0) - NODE_H / 2;
                        const accent = nodeAccentColor(nd);
                        const isSel = selectedNode && selectedNode.id === nd.id;
                        const elapsed = nd.status === "working"
                          ? formatElapsed(nd.startedAt, null)
                          : "";
                        const rawBadge = elapsed ? (nd.badge + " · " + elapsed) : (nd.badge || "");
                        const badgeText = truncSvgText(rawBadge, 14);
                        const estBadgeUnits = Array.from(badgeText).reduce((acc, ch) => acc + (/[^\x00-\xff]/.test(ch) ? 9.6 : 5.8), 0);
                        const badgeW = badgeText ? Math.min(86, Math.max(40, Math.ceil(estBadgeUnits) + 14)) : 0;

                        return h("g", {
                          key: nd.id,
                          transform: "translate(" + nx + "," + ny + ")",
                          className: "rdp-gnode" + (isSel ? " is-selected" : ""),
                          onClick: () => setSelectedNodeId(nd.id),
                        },
                          h("rect", {
                            className: "rdp-gnode-box",
                            x: 0,
                            y: 0,
                            width: NODE_W,
                            height: NODE_H,
                            rx: 10,
                            ry: 10,
                            filter: "url(#rdp-node-shadow)",
                          }),
                          h("rect", {
                            x: 0,
                            y: 12,
                            width: 3,
                            height: NODE_H - 24,
                            rx: 1.5,
                            fill: accent,
                          }),
                          renderNodeKindGlyph(nd.kind, accent),
                          h("g", { clipPath: "url(#rdp-clip-title)" },
                            h("text", {
                              x: 29,
                              y: 25,
                              fontSize: 12,
                              fontWeight: 600,
                              fill: "var(--dsw-alias-label-primary,#141413)",
                            }, truncSvgText(nd.title, 13))),
                          badgeText ? h("g", null,
                            h("rect", {
                              x: NODE_W - badgeW - 8,
                              y: 11,
                              width: badgeW,
                              height: 18,
                              rx: 5,
                              fill: accent,
                              fillOpacity: 0.12,
                            }),
                            h("text", {
                              x: NODE_W - 8 - badgeW / 2,
                              y: 23,
                              textAnchor: "middle",
                              fontSize: 9.2,
                              fontWeight: 650,
                              style: { fontVariantNumeric: "tabular-nums" },
                              fill: accent,
                            }, badgeText)) : null,
                          h("g", { clipPath: "url(#rdp-clip-sub)" },
                            h("text", {
                              x: 12,
                              y: 49,
                              fontSize: 10.5,
                              fill: "var(--dsw-alias-label-tertiary,#73726c)",
                            }, truncSvgText(nd.subtitle || "", 24))));
                      })))),

            // 单行底部画布图例 + 内联缩放控制栏（- / 100% / + / 重置视图）
            h("div", { className: "rdp-canvas-legend" },
              h("div", { className: "rdp-legend-items" },
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-working" }), "运行中"),
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-done" }), "已落盘"),
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-pending" }), "待拍板")),
              h("div", { className: "rdp-zoom-bar", role: "toolbar", "aria-label": "拓扑画布缩放控制" },
                h("button", {
                  type: "button",
                  className: "rdp-zoom-btn",
                  "data-zoom-act": "out",
                  "aria-label": "缩小拓扑画布",
                  disabled: zoomVal <= ZOOM_MIN,
                  onClick: () => stepZoom(-ZOOM_STEP),
                }, ICO.minus(12)),
                h("span", { className: "rdp-zoom-pct rdp-num" }, zoomPct),
                h("button", {
                  type: "button",
                  className: "rdp-zoom-btn",
                  "data-zoom-act": "in",
                  "aria-label": "放大拓扑画布",
                  disabled: zoomVal >= ZOOM_MAX,
                  onClick: () => stepZoom(ZOOM_STEP),
                }, ICO.plus(12)),
                h("button", {
                  type: "button",
                  className: "rdp-zoom-btn",
                  "data-zoom-act": "reset",
                  title: "重置缩放与平移",
                  onClick: resetViewport,
                }, ICO.resetView(12), "重置视图")))),

          // 右侧选项卡证据检视器 + 首屏常驻人类唯一裁决台
          h("div", { className: "rdp-drawer" },
            inspect ? [
              h("div", { className: "rdp-drawer-h", key: "dh" },
                h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 } },
                  UiTag({ tone: "info" }, inspect.kindLabel || "节点详情"),
                  (inspect.fileRel || inspect.sha) ? UiHelpTip(
                    (inspect.fileRel ? ("文件: " + inspect.fileRel) : "")
                      + (inspect.fileRel && inspect.sha ? " | " : "")
                      + (inspect.sha ? ("sha:" + inspect.sha) : ""),
                    "节点文件与哈希",
                    "bottom"
                  ) : null),
                h("h4", { className: "rdp-drawer-t" }, cleanIdeaTitle(inspect.ideaId || curIdeaId, inspect.title || selectedNode.title) || humanIdeaCode(inspect.ideaId || curIdeaId))),

              hasAuditTabContent ? h("div", { className: "rdp-dock-tabs", key: "dtabs", role: "tablist", "aria-label": "节点检视切换" },
                h("button", {
                  type: "button",
                  role: "tab",
                  "aria-selected": effectiveTab === "overview" ? "true" : "false",
                  className: "rdp-dock-tab" + (effectiveTab === "overview" ? " is-active" : ""),
                  onClick: () => setInspectorTab("overview"),
                }, inspect.dims ? "评分概览" : "指标 & 动作"),
                h("button", {
                  type: "button",
                  role: "tab",
                  "aria-selected": effectiveTab === "audit" ? "true" : "false",
                  className: "rdp-dock-tab" + (effectiveTab === "audit" ? " is-active" : ""),
                  onClick: () => setInspectorTab("audit"),
                }, "隔离审计")) : null,

              h("div", { className: "rdp-drawer-scroll", key: "dscroll" },
                effectiveTab === "audit"
                  ? [
                    Array.isArray(inspect.pushedInputs) && inspect.pushedInputs.length > 0
                      ? h("div", { key: "pushed" },
                        h("div", { className: "rdp-sec-cap" },
                          "上下文来源",
                          UiHelpTip("Worker 在仓外独立沙箱运行，仅接收主控单向推送的输入文件。", "隔离说明")),
                        h("div", { className: "rdp-push-list" },
                          inspect.pushedInputs.map((inp, ii) => (typeof inp === "string"
                            ? h("div", { className: "rdp-push-row", key: "pi" + ii }, h("span", null, inp))
                            : h("div", { className: "rdp-push-row", key: "pi" + ii },
                              h("span", null, inp.label),
                              h("code", { className: "rdp-num" }, inp.rel + (inp.sha ? " #" + inp.sha.slice(0, 6) : "")))))))
                      : null,
                    inspect.preview ? h("div", { key: "prev" },
                      h("div", { className: "rdp-sec-cap" }, "证据原文"),
                      h("pre", { className: "rdp-preview" }, inspect.preview)) : null,
                  ]
                  : [
                    inspect.dims ? h("div", { key: "dims" },
                      h("div", { className: "rdp-sec-cap" },
                        "五维评分",
                        UiHelpTip("每维 1–5 分，总分 25 分；悬停各维度问号可查看具体评分依据。", "评分规则")),
                      h("div", { className: "rdp-dim-list" },
                        Object.keys(DIM_LABELS).map((dk) => {
                          const val = inspect.dims[dk];
                          const num = Number.isFinite(Number(val)) ? Number(val) : 0;
                          const pct = Math.min(100, Math.max(0, (num / 5) * 100));
                          const reason = inspect.dimReasons && inspect.dimReasons[dk] ? inspect.dimReasons[dk] : "";
                          return h("div", { className: "rdp-dim-row", key: dk },
                            h("div", { className: "rdp-dim-top rdp-num" },
                              h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
                                DIM_LABELS[dk],
                                reason ? UiHelpTip(reason, DIM_LABELS[dk] + "评分依据") : null),
                              h("strong", { className: "rdp-num" }, num ? (num + " / 5") : "—")),
                            h("div", { className: "rdp-dim-bar" },
                              h("div", { className: "rdp-dim-fill", style: { width: pct + "%" } })));
                        }))) : null,

                    Array.isArray(inspect.metaRows) && inspect.metaRows.length > 0
                      ? h("div", { className: "rdp-kv", key: "kv" },
                        inspect.metaRows.map((pair, pi) => [
                          h("span", { className: "rdp-kv-k", key: "k" + pi }, pair[0]),
                          h("span", { className: "rdp-kv-v rdp-num", key: "v" + pi }, pair[1]),
                        ]))
                      : null,

                    Array.isArray(inspect.actions) && inspect.actions.length > 0
                      ? h("div", { className: "rdp-act-row", key: "acts" },
                        inspect.actions.map((act) => UiButton({
                          key: act,
                          variant: "outline",
                          size: "sm",
                          disabled: !!busyMsg,
                          onClick: () => runAction({
                            kind: act,
                            topic: inspect.topic || (snap && snap.activeTopic) || "default",
                            ideaId: inspect.ideaId || curIdeaId,
                          }, "正在执行 " + (actionLabels[act] || act) + "…"),
                        }, actionLabels[act] || act)))
                      : null,

                    !hasAuditTabContent || !inspect.dims
                      ? (inspect.preview && !inspect.dims ? h("pre", { className: "rdp-preview", key: "prev-inline" }, inspect.preview) : null)
                      : null,

                    actionFeedback ? h("div", {
                      key: "fb",
                      className: actionFeedback.ok ? "rdp-ok" : "rdp-bad",
                      style: { fontSize: 11.5 },
                    }, actionFeedback.text) : null,
                  ]),
            ] : h("div", { className: "rdp-meta", key: "empty-insp" }, "选择左侧节点查看详情"),

            // 首屏常驻底部：人类唯一裁决台（即使切换检视沙箱节点也不被挤出首屏）
            verdictTarget ? h("div", { className: "rdp-verdict-box rdp-verdict-dock", key: "verdict-dock" },
              h("div", { className: "rdp-sec-cap", style: { color: "var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary,#d97706))", marginBottom: 0, justifyContent: "space-between", width: "100%" } },
                h("span", { style: { display: "inline-flex", alignItems: "center", gap: 5 } },
                  ICO.shield(13),
                  "人类裁决 · " + humanIdeaCode(verdictTarget.ideaId),
                  UiHelpTip("多模型评审与探针仅作参考，最终必须由人类拍板 GO / REVISE / KILL 并落盘。", "人类裁决说明")),
                verdictTarget.currentVerdict && verdictTarget.currentVerdict !== "pending"
                  ? UiTag({ tone: verdictTarget.currentVerdict === "go" ? "success" : (verdictTarget.currentVerdict === "kill" ? "danger" : "warning") },
                    verdictTarget.currentVerdict.toUpperCase())
                  : null),
              draftAnchorConflict ? h("div", {
                className: "rdp-bad",
                style: { fontSize: 11.5, display: "flex", flexDirection: "column", gap: 6 },
              },
                h("span", null,
                  "当前裁决草稿原本对应 " + humanIdeaCode(draftAnchor.ideaId)
                  + (draftAnchor.briefSha ? ("（" + draftAnchor.briefSha.slice(0, 6) + "）") : "")
                  + "，与当前选中的工单或版本不一致；已保留草稿并拦截误提交。"),
                h("div", { style: { display: "flex", gap: 6, flexWrap: "wrap" } },
                  UiButton({
                    variant: "outline",
                    size: "sm",
                    onClick: () => { snapReqState.draftRev += 1; setDraftAnchor(curVerdictAnchor); },
                  }, "确认绑定当前版本"),
                  UiButton({
                    variant: "outline",
                    size: "sm",
                    onClick: clearVerdictDraft,
                  }, "清空草稿"))) : null,
              h("div", { className: "rdp-verdict-btns" },
                [
                  { k: "go", label: "GO 立项", icon: ICO.check(12) },
                  { k: "revise", label: "REVISE 修订", icon: ICO.refresh(12) },
                  { k: "kill", label: "KILL 淘汰", icon: ICO.close(12) },
                ].map((b) => h("button", {
                  type: "button",
                  key: b.k,
                  className: "rdp-vbtn rdp-vbtn-" + b.k + (verdictChoice === b.k ? " is-sel" : ""),
                  onClick: () => { bindDraftAnchorIfNeeded(); setVerdictChoice(b.k); },
                }, b.icon, b.label))),
              h("textarea", {
                className: "rdp-textarea",
                value: verdictNote,
                placeholder: "输入裁决依据（可选）…",
                onChange: (e) => { bindDraftAnchorIfNeeded(); setVerdictNote(e.target.value); },
              }),
              verdictChoice === "kill" ? h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 11.5 } },
                h("span", { style: { display: "inline-flex", alignItems: "center", gap: 4 } },
                  "记录到禁入清单",
                  UiHelpTip("淘汰后将一句话证伪机制追加至 dead-ends.md，防止后续发散重复踩坑。", "禁入清单说明")),
                UiSwitch({
                  checked: appendDeadEnd,
                  label: "记录到禁入清单",
                  onChange: (next) => { bindDraftAnchorIfNeeded(); setAppendDeadEnd(next); },
                })) : null,
              verdictChoice === "kill" && appendDeadEnd ? h("input", {
                className: "rdp-in",
                type: "text",
                value: deadEndSummary,
                placeholder: "一句话简述淘汰原因…",
                onChange: (e) => { bindDraftAnchorIfNeeded(); setDeadEndSummary(e.target.value); },
              }) : null,
              UiButton({
                variant: "primary",
                disabled: !!busyMsg || draftAnchorConflict || !verdictTarget.briefSha,
                onClick: () => {
                  if (draftAnchorConflict) {
                    setActionFeedback({ ok: false, text: "草稿绑定的工单或版本已变更，请先核对并确认绑定当前版本后再提交" });
                    return;
                  }
                  runAction({
                    kind: "verdict",
                    topic: verdictTarget.topic,
                    ideaId: verdictTarget.ideaId,
                    expectedBriefSha: verdictTarget.briefSha || "",
                    decision: verdictChoice,
                    note: verdictNote,
                    appendDeadEnd: verdictChoice === "kill" && appendDeadEnd,
                    deadEndSummary,
                  }, "正在写入人类裁决…");
                },
              }, busyMsg || ("确认 " + verdictChoice.toUpperCase()))) : null),
        ),
      );
    }

    // ── 会话顶栏视图与右上角胶囊槽位包装组件 ──────────────────────────────
    function extractSessionCwd(slotProps) {
      if (!slotProps || typeof slotProps.useSessions !== "function") return "";
      try {
        const cwd = slotProps.useSessions((s) => {
          const sid = slotProps.sessionId;
          if (sid && s && s.byId && s.byId[sid]) return s.byId[sid].cwd || "";
          return "";
        });
        return String(cwd || "").trim();
      } catch {
        return "";
      }
    }

    function ConversationSwarmView(slotProps) {
      const sessionCwd = extractSessionCwd(slotProps);
      return h(SwarmStudio, { repoRoot: sessionCwd, embedded: false });
    }

    function SessionHeaderSwarmPill(slotProps) {
      const sessionCwd = extractSessionCwd(slotProps);
      const [, setSeq] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const bump = () => { if (alive) setSeq((n) => n + 1); };
        bridgeWatchers.add(bump);
        if (!SWARM_SNAPSHOT) {
          fetchSwarmSnapshot({ repoRoot: !isDshProfilePath(sessionCwd) ? sessionCwd : "" });
        }
        return () => {
          alive = false;
          bridgeWatchers.delete(bump);
        };
      }, [sessionCwd, CONN_SEQ]);

      const activeWorkers = Number((SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount) || 0);
      const stages = (SWARM_SNAPSHOT && Array.isArray(SWARM_SNAPSHOT.stages)) ? SWARM_SNAPSHOT.stages : [];
      const curStg = stages.find((s) => s.status === "working")
        || stages.find((s) => s.status === "pending")
        || stages.slice().reverse().find((s) => s.status === "done")
        || null;

      return h("button", {
        type: "button",
        className: "rdp-hdr-pill rdp-num" + (activeWorkers > 0 ? " is-working" : ""),
        title: "打开科研派工 /swarm 实时进度与关系拓扑图",
        onClick: () => {
          if (slotProps && typeof slotProps.openView === "function") {
            slotProps.openView("research-swarm", "");
            return;
          }
          const c = slotProps && slotProps.ctx;
          const cv = c && typeof c.get === "function" ? c.get("conversationView") : null;
          if (cv && typeof cv.openView === "function") cv.openView("research-swarm", "");
        },
      },
        UiStateDot({ state: activeWorkers > 0 ? "ongoing" : "done", size: 7 }),
        h("span", { className: "rdp-num" }, activeWorkers > 0
          ? ("科研拓扑 · " + activeWorkers + " 运行中")
          : ("科研拓扑" + (curStg ? (" · " + curStg.id) : ""))));
    }

    // ── 设置页主组件：双模式切换（阵容编排工作台 | 科研拓扑 Swarm）──────────
    function Page(props) {
      const ctx = props.ctx;
      const [st, setSt] = React.useState({ phase: "loading" });
      const [draft, setDraft] = React.useState({});
      const [phase, setPhase] = React.useState("idle");
      const [menu, setMenu] = React.useState({ key: null, hi: 0, q: "" });
      const [activeTab, setActiveTab] = React.useState("lineup");
      const [probing, setProbing] = React.useState(false);
      const [pickingDir, setPickingDir] = React.useState(false);
      const [tracker] = React.useState(() => ({ phase: "loading", reqSeq: 0 }));
      const [, setBridgeSeq] = React.useState(0);

      const updateSt = (next) => {
        tracker.phase = next.phase;
        setSt(next);
      };

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const bumpBridge = () => {
          if (alive) setBridgeSeq((n) => n + 1);
        };
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
              if (d) {
                updateSt({ phase: "ready", desc: d });
                const savedRoot = String((d.value && d.value.repoRoot) || "");
                if (savedRoot) fetchBridgeSnapshot(null, { repoRoot: savedRoot, refresh: false });
              } else {
                updateSt({ phase: "nogw", why: "连不上设置服务" });
              }
            })
            .catch((e) => {
              if (!alive || seq !== tracker.reqSeq) return;
              clearLoadTimer();
              if (e && e.code === "NS_MISSING") updateSt({ phase: "nons", why: String(e.message || e) });
              else updateSt({ phase: "nogw", why: String((e && e.message) || e) });
            });
        };
        watchers.add(runLoad);
        bridgeWatchers.add(bumpBridge);
        timer = setTimeout(() => {
          timer = null;
          if (!alive || tracker.phase !== "loading") return;
          tracker.reqSeq += 1;
          updateSt({ phase: "nogw", why: "设置服务 3 秒内没有返回" });
        }, 3000);
        runLoad();
        fetchBridgeSnapshot();
        return () => {
          alive = false;
          clearLoadTimer();
          watchers.delete(runLoad);
          bridgeWatchers.delete(bumpBridge);
        };
      }, []);

      React.useEffect(() => {
        if (CONNECTION && !BRIDGE_SNAPSHOT) {
          fetchBridgeSnapshot(null, { refresh: false });
        }
      }, [CONN_SEQ]);

      const desc = st.phase === "ready" ? st.desc : null;
      const value = (desc && desc.value) || {};
      const user = (desc && desc.user) || {};
      const live = !!desc;
      const allFields = live ? fieldsOf(desc) : FALLBACK_FIELDS;
      const fields = allFields;
      const HIDDEN = new Set([
        "seatsFile",
        "executorCatalog",
        "executorStatus",
        "otherStages",
        "stageOpinions",
        "seatOverrides",
        "seatRoster",
        "defaultBackends",
      ]);
      const DEDICATED = new Set([
        "repoRoot",
        "scoutCommand",
        "scoutModel",
        "scoutEffort",
        "divergeCommand",
        "divergeModel",
        "divergeEffort",
        "divergeCount",
        "divergeUseDeadEnds",
        "reviewVotes",
        "noveltyCommand",
        "noveltyModel",
        "noveltyEffort",
      ]);
      const otherFields = allFields.filter((f) => !HIDDEN.has(f.key) && !DEDICATED.has(f.key));
      const text = (f) => (draft[f.key] !== undefined ? draft[f.key] : String(value[f.key] === undefined ? "" : value[f.key]));

      const rawSavedRepoRoot = String(value.repoRoot === undefined ? "" : value.repoRoot);
      const bridgeDefRoot = String((BRIDGE_SNAPSHOT && (BRIDGE_SNAPSHOT.repoRoot || BRIDGE_SNAPSHOT.defaultRepoRoot)) || "");
      const autoCorrectedRoot = isDshProfilePath(rawSavedRepoRoot) && bridgeDefRoot && !isDshProfilePath(bridgeDefRoot);
      const sanitizedSavedRoot = autoCorrectedRoot ? bridgeDefRoot : rawSavedRepoRoot;
      const curRepoRoot = draft.repoRoot !== undefined ? draft.repoRoot : sanitizedSavedRoot;
      const manualProfileWarn = isDshProfilePath(curRepoRoot);
      const nativeDirPicker = resolveDirectoryPicker(ctx);

      const dirty = live && (
        fields.some((f) => draft[f.key] !== undefined && draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key]))
        || (draft.repoRoot === undefined && sanitizedSavedRoot !== rawSavedRepoRoot)
      );

      React.useEffect(() => {
        if (!menu.key) return undefined;
        const usesPrimMenu = String(menu.key).indexOf("exec:") === 0 || String(menu.key).indexOf("effort:") === 0;
        if (Prim && typeof Prim.Menu === "function" && usesPrimMenu) return undefined;
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        const onDocDown = (e) => {
          if (!menu.key) return;
          const isPrimControlled = String(menu.key).indexOf("exec:") === 0 || String(menu.key).indexOf("effort:") === 0;
          if (Prim && typeof Prim.Menu === "function" && isPrimControlled) return;
          const t = e && e.target;
          if (t && typeof t.closest === "function" && (t.closest(".rdp-pick") || t.closest('[role="menu"]'))) return;
          setMenu({ key: null, hi: 0, q: "" });
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
      }, [menu.key]);

      const onBrowseDirectory = () => {
        if (!live || !nativeDirPicker || pickingDir) return;
        setPickingDir(true);
        Promise.resolve()
          .then(() => nativeDirPicker())
          .then((picked) => {
            if (typeof picked === "string" && picked.trim()) {
              const clean = picked.trim();
              setDraft((prev) => ({ ...prev, repoRoot: clean }));
              fetchBridgeSnapshot(null, { repoRoot: clean, refresh: false });
            }
          })
          .catch(() => { /* 宿主不支持或用户取消时静默跳过 */ })
          .finally(() => setPickingDir(false));
      };

      const save = () => {
        if (!live) return;
        const patch = {};
        if (draft.repoRoot === undefined && sanitizedSavedRoot !== rawSavedRepoRoot) {
          patch.repoRoot = sanitizedSavedRoot;
        }
        for (const f of fields) {
          if (draft[f.key] === undefined) continue;
          let nextVal = draft[f.key];
          if (f.key === "divergeCount") {
            const trimmed = String(nextVal).trim();
            if (trimmed === "") {
              nextVal = "";
            } else {
              const parsed = parseInt(trimmed, 10);
              nextVal = Number.isFinite(parsed) ? String(Math.min(50, Math.max(1, parsed))) : "10";
            }
          }
          if (nextVal !== String(value[f.key] === undefined ? "" : value[f.key])) {
            patch[f.key] = nextVal;
          }
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
            fetchBridgeSnapshot(null, { repoRoot: patch.repoRoot || curRepoRoot, refresh: false });
          })
          .catch((e) => setPhase("failed:" + ((e && e.message) || e)));
      };

      const schemaProps = live ? propsFromSchema(desc && desc.schema) : null;
      const backendOutdated = live && isBackendOutdated(desc);
      const cat = panelCatalog(value, ctx, schemaProps);
      const statusMap = effectiveStatusOf(value, schemaProps);
      const projLineup = (BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.projectLineup) || null;
      const workspaces = (BRIDGE_SNAPSHOT && Array.isArray(BRIDGE_SNAPSHOT.workspaces)) ? BRIDGE_SNAPSHOT.workspaces : [];
      const activeWorkers = Number((SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount) || 0);

      const inheritedStageLabel = (stageKey) => {
        if (!projLineup || !projLineup.configured || !projLineup[stageKey]) return "";
        const item = projLineup[stageKey];
        if (!item.seat) return "";
        const effStr = item.embeddedEffort ? ("随模型·" + item.embeddedEffort) : (item.effort || "");
        return item.seat
          + (item.resolvedModel ? (" · " + item.resolvedModel) : "")
          + (effStr ? (" · " + effStr) : "");
      };

      const effectiveModelForEffort = (exec, model) => {
        if (model) return model;
        if (!exec) return "";
        const gs = groupedModels(exec, cat);
        for (const g of gs) {
          if (g && Array.isArray(g.items) && g.items.length > 0 && g.items[0].value) {
            return g.items[0].value;
          }
        }
        return "";
      };

      const isMenuIn = (prefixList) => {
        const mk = String(menu.key || "");
        if (!mk) return false;
        return prefixList.some((p) => mk === p || mk.indexOf(p) === 0);
      };

      const renderSingleStageItem = (stageKey, rowLabel, cmdKey, modelKey, effortKey) => {
        const curExec = draft[cmdKey] !== undefined
          ? draft[cmdKey]
          : String(value[cmdKey] === undefined ? "" : value[cmdKey]);
        const curModel = draft[modelKey] !== undefined
          ? draft[modelKey]
          : String(value[modelKey] === undefined ? "" : value[modelKey]);
        const curEffort = draft[effortKey] !== undefined
          ? draft[effortKey]
          : String(value[effortKey] === undefined ? "" : value[effortKey]);
        const execOptions = buildExecOptions(curExec, statusMap, "默认");
        const modelPlaceholder = curExec
          ? defaultModelLabel(curExec, cat, "默认模型")
          : "默认模型";
        const inherited = !curExec ? inheritedStageLabel(stageKey) : "";
        const projItem = !curExec && projLineup && projLineup.configured ? projLineup[stageKey] : null;
        const effectiveModel = curExec
          ? effectiveModelForEffort(curExec, curModel)
          : ((projItem && (projItem.model || projItem.resolvedModel)) || "");
        return h("div", { className: "rdp-item rdp-item-stack", key: "row-" + stageKey },
          h("div", { className: "rdp-item-main" },
            h("span", { className: "rdp-label" },
              rowLabel,
              inherited ? h("span", { className: "rdp-inherit" }, "项目默认：" + inherited) : null),
            h("div", { className: "rdp-item-meta-r" },
              effortPickerNode({ menu, setMenu }, stageKey, curExec, curModel, effectiveModel, curEffort, !live || !curExec,
                rowLabel + "思考强度",
                (eff) => setDraft((prev) => ({ ...prev, [effortKey]: eff }))))),
          h("div", { className: "rdp-ctl" },
            h("div", { className: "rdp-grid2" },
              execPickerNode({ menu, setMenu }, stageKey, curExec, execOptions, !live, rowLabel + "执行工具",
                (nextExec) => setDraft((prev) => ({ ...prev, [cmdKey]: nextExec, [modelKey]: "", [effortKey]: "" }))),
              pickerNode({ menu, setMenu }, stageKey, curExec, cat, curModel, !live || !curExec,
                modelPlaceholder,
                (m) => setDraft((prev) => ({
                  ...prev,
                  [modelKey]: m,
                  ...(embeddedModelEffort(m) ? { [effortKey]: "" } : {}),
                }))))));
      };

      const curDivergeCount = draft.divergeCount !== undefined
        ? draft.divergeCount
        : (String(value.divergeCount === undefined || value.divergeCount === "" ? "10" : value.divergeCount));

      const rawDeadEnds = draft.divergeUseDeadEnds !== undefined
        ? draft.divergeUseDeadEnds
        : String(value.divergeUseDeadEnds === undefined || value.divergeUseDeadEnds === "" ? "true" : value.divergeUseDeadEnds);
      const curUseDeadEndsBool = String(rawDeadEnds).trim().toLowerCase() !== "false";
      const footElevated = dirty || phase !== "idle";

      return h("div", { className: "rdp" + (activeTab === "swarm" ? " is-swarm" : "") },
        // 顶部克制页头：标题 + 视图切换器 + 五大本地 CLI 状态条
        h("div", { className: "rdp-hero", key: "head" },
          h("div", { className: "rdp-hero-top" },
            h("div", { className: "rdp-head" },
              h("h2", { className: "rdp-title", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
                "科研派工 · 全流程阵容与拓扑",
                UiHelpTip("按闭环阶段搭配调研、发散、盲审与查重工具，并在科研拓扑中检视沙箱进度与人类拍板。", "科研派工说明", "bottom"))),
            h("div", { className: "rdp-tabs", role: "tablist", "aria-label": "科研派工视图切换" },
              h("button", {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "lineup" ? "true" : "false",
                className: "rdp-tab" + (activeTab === "lineup" ? " is-active" : ""),
                onClick: () => setActiveTab("lineup"),
              }, "阵容编排"),
              h("button", {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "swarm" ? "true" : "false",
                className: "rdp-tab rdp-num" + (activeTab === "swarm" ? " is-active" : ""),
                onClick: () => setActiveTab("swarm"),
              },
                UiStateDot({ state: activeWorkers > 0 ? "ongoing" : "done", size: 7 }),
                "科研拓扑" + (activeWorkers > 0 ? (" (" + activeWorkers + ")") : "")))),

          h("div", { className: "rdp-fleet" },
            STAGE_SEATS.map((exec) => {
              const row = cat.find((c) => c.exec === exec);
              const mCount = row && Array.isArray(row.models) ? row.models.length : 0;
              const isInstalled = !Object.prototype.hasOwnProperty.call(statusMap, exec) || statusMap[exec] !== false;
              return h("span", {
                key: "fl:" + exec,
                className: "rdp-fleet-chip" + (isInstalled ? "" : " is-off"),
              },
                UiStateDot({ state: isInstalled ? "done" : "idle", size: 7 }),
                h("strong", null, exec),
                h("span", { className: "rdp-fleet-cnt rdp-num" }, isInstalled ? (mCount > 0 ? (mCount + " 模型") : "已就绪") : "未安装"));
            }),
            UiButton({
              variant: "outline",
              size: "sm",
              icon: ICO.refresh(13),
              className: "rdp-fleet-refresh",
              disabled: probing,
              onClick: () => {
                setProbing(true);
                fetchBridgeSnapshot(null, { repoRoot: curRepoRoot, refresh: true })
                  .finally(() => setProbing(false));
              },
            }, probing ? "探测中…" : "刷新模型探测"))),

        live ? null : h("div", { className: "rdp-state", key: "state" },
          st.phase === "loading"
            ? "正在连接设置服务…（首次打开会慢一点）"
            : st.phase === "nons"
              ? "设置服务连上了，但本页暂时没有可编辑项。先用默认设置即可；需要改动时请参考项目说明。"
              : "连不上设置服务（原因：" + st.why + "），这一页只能看说明、不能修改。稍后重试，或检查桌面端是否正常运行。"),
        backendOutdated ? h("div", { className: "rdp-state rdp-warn", key: "stale-backend" },
          "检测到插件界面已更新，但后台服务仍在运行旧版进程（Windows 点击右上角关闭仅最小化到右下角系统托盘）。请右键任务栏右下角托盘中的 DeepSeek Harness 图标选择「退出」后再重新打开，即可完成后台刷新并开启实时拓扑通道。") : null,

        // 视图 B：科研拓扑 /swarm 全链路进度与关系星图
        activeTab === "swarm"
          ? h(SwarmStudio, {
            key: "swarm-tab",
            repoRoot: curRepoRoot,
            embedded: true,
            onSelectRepoRoot: (nextDir) => {
              setDraft((prev) => ({ ...prev, repoRoot: nextDir }));
              fetchBridgeSnapshot(null, { repoRoot: nextDir, refresh: false });
            },
          })
          : [
            // 1. 工作流项目
            h("div", { className: "rdp-bento", key: "bento-project" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  ICO.folder(15),
                  h("h3", { className: "rdp-group-t" }, "工作流项目"),
                  UiHelpTip("定位当前科研项目根目录，保存后自动同步各阶段阵容配置。", "工作流项目说明"))),
              (autoCorrectedRoot || manualProfileWarn) ? h("div", { className: "rdp-state rdp-warn", style: { marginTop: 4 } },
                manualProfileWarn
                  ? "当前路径指向桌面宿主内部运行目录而非科研项目文件夹，建议点击下方科研工作区胶囊或浏览选择真实项目目录。"
                  : "已自动将误填的宿主内部运行目录纠偏为当前科研项目根目录，点击右下角保存即可固化。") : null,
              h("div", { className: "rdp-items" },
                h("div", { className: "rdp-item rdp-item-path" },
                  h("div", { className: "rdp-item-main" },
                    h("span", { className: "rdp-label" }, "项目文件夹")),
                  h("div", { className: "rdp-ctl" },
                    h("div", { className: "rdp-path-row" },
                      h("input", {
                        className: "rdp-in rdp-in-path",
                        type: "text",
                        disabled: !live,
                        value: curRepoRoot,
                        placeholder: "选择或输入项目路径（留空自动探测）",
                        onChange: (e) => setDraft((prev) => ({ ...prev, repoRoot: e.target.value })),
                      }),
                      nativeDirPicker ? UiButton({
                        variant: "outline",
                        size: "md",
                        icon: ICO.folder(14),
                        className: "rdp-browse-btn",
                        disabled: !live || pickingDir,
                        onClick: onBrowseDirectory,
                      }, pickingDir ? "选择中…" : "浏览…") : null)))),
              workspaces.length > 0 ? h("div", { className: "rdp-ws-strip" },
                h("span", { className: "rdp-ws-cap" }, "已发现工作区："),
                workspaces.slice(0, 7).map((ws) => h("button", {
                  type: "button",
                  key: "ws:" + ws.dir,
                  disabled: !live,
                  className: "rdp-ws-pill" + (curRepoRoot === ws.dir ? " is-active" : ""),
                  title: ws.dir,
                  onClick: () => {
                    setDraft((prev) => ({ ...prev, repoRoot: ws.dir }));
                    fetchBridgeSnapshot(null, { repoRoot: ws.dir, refresh: false });
                  },
                },
                  ws.isResearch ? h("span", { className: "rdp-ws-star" }, ICO.sparkle(12)) : null,
                  ws.name))) : null),

            // 2–5. 四阶段 Bento Matrix（DOM 严格保持 S0 → S2 → S4 → S4.5，视觉为 左列 S0+S4.5 / 右列 S2 / 下方通栏 S4 评审矩阵）
            h("div", { className: "rdp-bento-matrix", key: "bento-matrix" },
              // 2. 文献调研（S0）
              h("div", { className: "rdp-bento rdp-bento-s0" + (isMenuIn(["exec:scout", "effort:scout", "scout"]) ? " has-menu" : ""), key: "bento-scout" },
                h("div", { className: "rdp-group" },
                  h("div", { className: "rdp-group-row" },
                    h("span", { className: "rdp-step-pill rdp-num" }, "S0"),
                    h("h3", { className: "rdp-group-t" }, "文献调研"),
                    UiHelpTip("检索论文源码与实验主表，自动校验并沉淀结构化文献卡片池。", "文献调研说明"))),
                h("div", { className: "rdp-items" },
                  renderSingleStageItem("scout", "由谁调研", "scoutCommand", "scoutModel", "scoutEffort"))),

              // 3. 想法发散（S2）
              h("div", { className: "rdp-bento rdp-bento-s2" + (isMenuIn(["exec:diverge", "effort:diverge", "diverge"]) ? " has-menu" : ""), key: "bento-diverge" },
                h("div", { className: "rdp-group" },
                  h("div", { className: "rdp-group-row" },
                    h("span", { className: "rdp-step-pill rdp-num" }, "S2"),
                    h("h3", { className: "rdp-group-t" }, "想法发散"),
                    UiHelpTip("结合文献池与基线读数，产出一批互不串写、带数值判据的候选方案。", "想法发散说明"))),
                h("div", { className: "rdp-items" },
                  renderSingleStageItem("diverge", "由谁发散", "divergeCommand", "divergeModel", "divergeEffort"),
                  h("div", { className: "rdp-item", key: "row-diverge-count" },
                    h("div", { className: "rdp-item-main" },
                      h("span", { className: "rdp-label" },
                        "单轮默认条数",
                        UiHelpTip("每次发散默认生成的候选方案数量（1–50 条，默认 10）。", "单轮默认条数说明"))),
                    h("div", { className: "rdp-ctl" },
                      h("input", {
                        className: "rdp-in rdp-in-num rdp-num",
                        type: "number",
                        min: 1,
                        max: 50,
                        disabled: !live,
                        value: curDivergeCount,
                        placeholder: "10",
                        onChange: (e) => setDraft((prev) => ({ ...prev, divergeCount: e.target.value })),
                      }))),
                  h("div", { className: "rdp-item", key: "row-diverge-deadends" },
                    h("div", { className: "rdp-item-main" },
                      h("span", { className: "rdp-label" },
                        "历史死胡同过滤",
                        UiHelpTip("开启时自动挂载 dead-ends.md 已证伪方向防止重复踩坑；关闭则为零历史锚定的纯空白发散。", "历史死胡同过滤说明"))),
                    h("div", { className: "rdp-ctl" },
                      UiSwitch({
                        checked: curUseDeadEndsBool,
                        disabled: !live,
                        label: "历史死胡同过滤",
                        className: "rdp-deadends-switch",
                        onChange: (nextBool) => setDraft((prev) => ({ ...prev, divergeUseDeadEnds: nextBool ? "true" : "false" })),
                      }))))),

              // 4. 多票评审（S4 陪审矩阵）
              h("div", { className: "rdp-bento rdp-bento-s4" + (isMenuIn(["exec:vote:", "effort:vote:", "vote:"]) ? " has-menu" : ""), key: "bento-review" },
                (() => {
                  const rows = draft.reviewVotes !== undefined ? parseVoteRows(draft.reviewVotes) : voteRows(value);
                  const applyVotes = (next) => setDraft((prev) => ({ ...prev, reviewVotes: voteString(next) }));
                  const hasReviewCatalog = cat.some((c) => REVIEW_SEATS.includes(c.exec));
                  const projReviewSlots = (projLineup && projLineup.configured && Array.isArray(projLineup.review))
                    ? projLineup.review
                    : [];
                  const nextSeat = () => {
                    const used = new Set(rows.map((r) => r.executor));
                    for (const s of REVIEW_SEATS) {
                      if (!used.has(s)) return s;
                    }
                    return REVIEW_SEATS[rows.length % REVIEW_SEATS.length];
                  };
                  return [
                    h("div", { className: "rdp-group-head", key: "s4-head" },
                      h("div", { className: "rdp-group" },
                        h("div", { className: "rdp-group-row" },
                          h("span", { className: "rdp-step-pill rdp-num" }, "S4"),
                          h("h3", { className: "rdp-group-t" }, "多票评审"),
                          UiHelpTip("每条候选在独立沙箱内由各席位独立盲审打分，自动生成五维总分降序榜；留空时继承项目默认阵容。", "多票评审说明"))),
                      rows.length === 0 && projReviewSlots.length > 0 ? UiButton({
                        variant: "outline",
                        size: "sm",
                        disabled: !live,
                        onClick: () => applyVotes(projReviewSlots
                          .filter((sl) => STAGE_SEATS.includes(sl.seat))
                          .map((sl) => ({ executor: sl.seat, model: sl.model || "", effort: sl.effort || "" }))),
                      }, "载入默认") : null),
                    h("div", { key: "votes" },
                      h("div", { className: "rdp-items" },
                        rows.length === 0
                          ? h("div", { className: "rdp-empty", key: "empty-votes" },
                            h("span", null, "继承项目默认阵容"),
                            projReviewSlots.length > 0 ? h("span", { className: "rdp-slot-pills" },
                              projReviewSlots.map((sl, si) => h("span", { className: "rdp-inherit", key: "ps:" + si },
                                sl.tag
                                  + (sl.resolvedModel ? (" · " + sl.resolvedModel) : "")
                                  + (sl.embeddedEffort ? (" · 随模型·" + sl.embeddedEffort) : (sl.effort ? (" · " + sl.effort) : ""))))) : null)
                          : rows.map((row, idx) => {
                            const seatOptions = buildExecOptions(row.executor, statusMap, "");
                            const effVoteModel = effectiveModelForEffort(row.executor, row.model);
                            return h("div", { className: "rdp-item rdp-item-stack rdp-item-vote", key: "v" + idx },
                              h("div", { className: "rdp-item-main" },
                                h("span", { className: "rdp-label rdp-num" }, "票 " + (idx + 1)),
                                h("div", { className: "rdp-item-meta-r" },
                                  effortPickerNode({ menu, setMenu }, "vote:" + idx, row.executor, row.model, effVoteModel, row.effort || "", !live,
                                    "票 " + (idx + 1) + " 思考强度",
                                    (eff) => applyVotes(rows.map((r, i) => (i === idx ? { ...r, effort: eff } : r)))),
                                  UiButton({
                                    variant: "ghost",
                                    size: "sm",
                                    icon: ICO.trash(13),
                                    className: "rdp-btn-danger rdp-item-vote-del",
                                    disabled: !live,
                                    title: "删除票 " + (idx + 1),
                                    onClick: () => applyVotes(rows.filter((_, i) => i !== idx)),
                                  }, "删除"))),
                              h("div", { className: "rdp-ctl" },
                                h("div", { className: "rdp-grid2" },
                                  execPickerNode({ menu, setMenu }, "vote:" + idx, row.executor, seatOptions, !live, "票 " + (idx + 1) + " 执行工具",
                                    (nextExec) => applyVotes(rows.map((r, i) => (i === idx ? { executor: nextExec, model: "", effort: "" } : r)))),
                                  pickerNode({ menu, setMenu }, "vote:" + idx, row.executor, cat, row.model, !live,
                                    defaultModelLabel(row.executor, cat, "默认模型"),
                                    (m) => applyVotes(rows.map((r, i) => (i === idx ? { ...r, model: m, effort: embeddedModelEffort(m) ? "" : (r.effort || "") } : r)))))));
                          }),
                        live && !hasReviewCatalog ? h("div", { className: "rdp-empty", key: "nocat" },
                          "未探测到模型，可手动输入") : null),
                      h("div", { className: "rdp-add-wrap", key: "add" },
                        UiButton({
                          variant: "outline",
                          icon: ICO.plus(14),
                          className: "rdp-add",
                          disabled: !live,
                          onClick: () => applyVotes(rows.concat([{ executor: nextSeat(), model: "", effort: "" }])),
                        }, "加一票"))),
                  ];
                })()),

              // 5. 前置查重（S4.5）
              h("div", { className: "rdp-bento rdp-bento-s45" + (isMenuIn(["exec:novelty", "effort:novelty", "novelty"]) ? " has-menu" : ""), key: "bento-novelty" },
                h("div", { className: "rdp-group" },
                  h("div", { className: "rdp-group-row" },
                    h("span", { className: "rdp-step-pill rdp-num" }, "S4.5"),
                    h("h3", { className: "rdp-group-t" }, "前置查重"),
                    UiHelpTip("正式长训前对入围方案执行单单隔离查新与撞车核验，落盘结构化查重报告。", "前置查重说明"))),
                h("div", { className: "rdp-items" },
                  renderSingleStageItem("novelty", "由谁查重", "noveltyCommand", "noveltyModel", "noveltyEffort")))),

            otherFields.length === 0 ? null : h("div", { className: "rdp-bento", key: "adv" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("h3", { className: "rdp-group-t" }, "高级项"),
                  UiHelpTip("未映射专用控件的新增配置项，日常通常无需修改。", "高级项说明"))),
              otherFields.map((f) => h("div", { className: "rdp-item rdp-item-full", key: f.key },
                h("div", { className: "rdp-item-main" },
                  h("span", { className: "rdp-label" }, f.title,
                    f.description ? UiHelpTip(f.description, f.title + "说明") : null,
                    live && Object.prototype.hasOwnProperty.call(user, f.key) ? UiTag({ tone: "info" }, "已覆盖") : null),
                  h("input", {
                    className: "rdp-in",
                    type: "text",
                    disabled: !live,
                    value: text(f),
                    placeholder: live ? String(f.default === undefined ? "" : f.default) : "（当前不可编辑）",
                    onChange: (e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value })),
                  }))))),

            h("div", { className: "rdp-foot " + (footElevated ? "is-elevated" : "is-quiet"), key: "foot" },
              h("span", { className: "rdp-foot-msg", style: { display: "inline-flex", alignItems: "center", gap: 6 } },
                phase === "saved" ? h("span", { className: "rdp-ok" }, "已保存并同步")
                  : phase.indexOf("failed") === 0 ? h("span", { className: "rdp-bad" }, "保存失败：" + phase.slice(7))
                  : dirty ? "有未保存改动"
                  : (live ? "已与项目配置同步" : "当前不可编辑"),
                UiHelpTip(SEATS_HINT, "同步说明")),
              h("div", { className: "rdp-foot-ctl" },
                UiButton({
                  variant: "outline",
                  disabled: !dirty || phase === "saving",
                  onClick: () => { setDraft({}); setPhase("idle"); },
                }, "放弃"),
                UiButton({
                  variant: "primary",
                  disabled: !dirty || phase === "saving",
                  onClick: save,
                }, phase === "saving" ? "保存中" : "保存"))),
          ],
      );
    }

    const name = "research-dispatch";
    const inject = ["slots", "remote", "remote.settings"];

    function apply(ctx) {
      ensureStyleTag();
      GATEWAY = null;
      CONNECTION = null;
      SWARM_LAST_ERROR = "";

      // 0) 优先同步探测 DSH connection 服务（immediately:true 时同步就绪），绝不阻塞无该服务的最小宿主
      try {
        const directConn = (ctx && ctx.connection)
          || (ctx && typeof ctx.get === "function" ? ctx.get("connection") : null);
        if (directConn && ((directConn.rpc && typeof directConn.rpc.call === "function") || typeof directConn.fetch === "function")) {
          setConnection(directConn);
          diag.connectionVia = "ctx.direct";
        }
      } catch { /* cordis 对未在本地 inject 声明的属性读取抛异常时静默跳过 */ }

      // 1) 可选设置左栏矢量图标槽位
      try {
        ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
          name: "settings.section.icon",
          id: "research-dispatch",
          order: 40,
        }, () => h(SettingsNavIcon, null)));
      } catch { /* 最小宿主不支持图标槽位时静默跳过 */ }

      // 2) 可选会话顶栏「科研拓扑」全屏交互视图槽位
      try {
        ctx.slots.inject("conversation.view", () => ctx.slots.register({
          name: "conversation.view",
          id: "research-swarm",
          order: 20,
          label: () => "科研拓扑",
        }, (p) => h(ConversationSwarmView, { ...p, ctx })));
      } catch { /* 静默跳过 */ }

      // 3) 可选会话右上角实时状态胶囊槽位
      try {
        ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "research-dispatch-pill",
          order: 50,
          label: () => "科研派工",
        }, (p) => h(SessionHeaderSwarmPill, { ...p, ctx })));
      } catch { /* 静默跳过 */ }

      // 4) 核心设置分区槽位（保持最后注册，兼容单变量 mock 捕获最后一个注册槽位）
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
          ctx.inject(["connection"], (child) => {
            try {
              const c = (child && child.connection)
                || (child && typeof child.get === "function" ? child.get("connection") : null);
              if (!c) return;
              setConnection(c);
              diag.connectionVia = "ctx.inject";
              const clearConn = () => { if (CONNECTION === c) setConnection(null); };
              if (child && typeof child.on === "function") child.on("dispose", clearConn);
              else if (child && typeof child.effect === "function") child.effect(() => clearConn);
            } catch (e) {
              diag.connectionInjectError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) {
        diag.connectionInjectError = String((e && e.message) || e);
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
        CONNECTION = null;
        EXTRA_MODELS = null;
        BRIDGE_SNAPSHOT = null;
        SWARM_SNAPSHOT = null;
        SWARM_ROUTE_MISSING = false;
        SWARM_LAST_ERROR = "";
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
        statusOf,
        effectiveStatusOf,
        mergeCatalog,
        mergeCatalogRows,
        readModelDirectories,
        groupsToCatalog,
        panelCatalog,
        buildExecOptions,
        resolveDirectoryPicker,
        setPrimitives,
        getPrimitives,
        setConnection,
        setLiveGroups,
        setBridgeSnapshot,
        fetchBridgeSnapshot,
        setSwarmSnapshot,
        fetchSwarmSnapshot,
        postDispatchAction,
        isBackendOutdated,
        isDshProfilePath,
        cubicEdgePath,
        clampZoom,
        ZOOM_MIN,
        ZOOM_MAX,
        ZOOM_STEP,
        groupedModels,
        flattenGroups,
        modelMatch,
        filteredGroups,
        buildMenuView,
        messagePlaceholder: null,
        UiIcon,
        UiStateDot,
        UiTag,
        UiSwitch,
        UiButton,
        ExecPicker,
        execPickerNode,
        EffortPicker,
        effortPickerNode,
        ModelPicker,
        embeddedModelEffort,
        normalizeEffort,
        parseVoteRows,
        voteString,
        SwarmStudio,
        ConversationSwarmView,
        SessionHeaderSwarmPill,
        SettingsNavIcon,
        menuProps,
        liveGroups: () => LIVE_GROUPS,
        bridgeSnapshot: () => BRIDGE_SNAPSHOT,
        swarmSnapshot: () => SWARM_SNAPSHOT,
        swarmLastError: () => SWARM_LAST_ERROR,
        swarmRouteMissing: () => SWARM_ROUTE_MISSING,
        resetLiveCatalog: () => { LIVE_GROUPS = null; LIVE_CATALOG = null; },
        resetBridgeSnapshot: () => { BRIDGE_SNAPSHOT = null; },
        resetSwarmSnapshot: () => { SWARM_SNAPSHOT = null; SWARM_ROUTE_MISSING = false; SWARM_LAST_ERROR = ""; SWARM_ACTIVE_CTX = null; },
        resetModelDirs: () => { EXTRA_MODELS = null; },
        RPC_CHANNEL,
        RPC_EXEC_METHOD,
        RPC_SWARM_METHOD,
        RPC_ACTION_METHOD,
        BRIDGE_EXEC_PATH,
        BRIDGE_SWARM_PATH,
        BRIDGE_ACTION_PATH,
        STAGE_SEATS,
        REVIEW_SEATS,
        DIVERGE_SEATS,
        SEAT_LABELS,
        SEATS_HINT,
        CSS: () => CSS,
      },
      default: { name, inject, apply },
    };
    return module.exports;
  },
});
