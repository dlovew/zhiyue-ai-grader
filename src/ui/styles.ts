  // src/ui/styles.ts
  // 全部样式都活在 shadow root 里：页面原有样式进不来，这里的类名也不会污染页面。
  var STYLES = `
:host {
  --z-accent: #0071e3;
  --z-accent-soft: rgba(0, 113, 227, .10);
  --z-ring: rgba(0, 113, 227, .30);
  --z-green: #34c759;
  --z-green-ink: #1c7c3c;
  --z-green-soft: rgba(52, 199, 89, .14);
  --z-orange: #ff9500;
  --z-orange-ink: #a25800;
  --z-orange-soft: rgba(255, 149, 0, .16);
  --z-red: #ff3b30;
  --z-red-ink: #c0362c;
  --z-red-soft: rgba(255, 59, 48, .12);
  --z-ink: #1d1d1f;
  --z-ink2: #6e6e73;
  --z-ink3: #8e8e93;
  --z-hairline: rgba(60, 60, 67, .10);
  --z-fill: rgba(120, 120, 128, .10);
  --z-fill-2: rgba(120, 120, 128, .18);
  --z-panel: rgba(250, 250, 252, .84);
  --z-bg-solid: #f5f5f7;
  --z-card: #ffffff;
  --z-card-t: rgba(255, 255, 255, .72);
  --z-foot: rgba(255, 255, 255, .34);
  --z-shadow-lg: 0 24px 64px -18px rgba(15, 23, 42, .32), 0 2px 10px rgba(15, 23, 42, .06);
  --z-shadow-sm: 0 1px 2px rgba(0, 0, 0, .10);
  --z-ease: cubic-bezier(.32, .72, 0, 1);
  color-scheme: light;
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--z-ink);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
@media (prefers-color-scheme: dark) {
  :host {
    --z-accent: #0a84ff;
    --z-accent-soft: rgba(10, 132, 255, .20);
    --z-ring: rgba(10, 132, 255, .38);
    --z-green: #30d158;
    --z-green-ink: #5ee07a;
    --z-green-soft: rgba(48, 209, 88, .18);
    --z-orange: #ff9f0a;
    --z-orange-ink: #ffb84d;
    --z-orange-soft: rgba(255, 159, 10, .18);
    --z-red: #ff453a;
    --z-red-ink: #ff7b72;
    --z-red-soft: rgba(255, 69, 58, .18);
    --z-ink: #f5f5f7;
    --z-ink2: #a1a1a6;
    --z-ink3: #8e8e93;
    --z-hairline: rgba(255, 255, 255, .10);
    --z-fill: rgba(120, 120, 128, .24);
    --z-fill-2: rgba(120, 120, 128, .36);
    --z-panel: rgba(28, 28, 30, .84);
    --z-bg-solid: #1c1c1e;
    --z-card: #2c2c2e;
    --z-card-t: rgba(44, 44, 46, .68);
    --z-foot: rgba(255, 255, 255, .03);
    --z-shadow-lg: 0 30px 80px -20px rgba(0, 0, 0, .75), 0 2px 12px rgba(0, 0, 0, .35);
    --z-shadow-sm: 0 1px 2px rgba(0, 0, 0, .4);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; cursor: pointer; appearance: none; -webkit-appearance: none; }
button:disabled { cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--z-accent); outline-offset: 2px; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--z-fill-2); border: 2px solid transparent; border-radius: 8px; background-clip: padding-box; }
::-webkit-scrollbar-track { background: transparent; }

/* ---------- 主面板 ---------- */
.zp-panel {
  position: fixed; right: 20px; bottom: 20px; width: 388px; max-height: calc(100vh - 40px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--z-panel); border: 1px solid var(--z-hairline); border-radius: 20px;
  box-shadow: var(--z-shadow-lg);
  -webkit-backdrop-filter: blur(32px) saturate(180%); backdrop-filter: blur(32px) saturate(180%);
  animation: zp-in .38s var(--z-ease);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .zp-panel { background: var(--z-card); }
}
@keyframes zp-in { from { opacity: 0; transform: translateY(14px) scale(.985); } to { opacity: 1; transform: none; } }

.zp-head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; }
.zp-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.zp-logo {
  width: 30px; height: 30px; flex: none; display: grid; place-items: center;
  border-radius: 9px; color: #fff; font-size: 14px; font-weight: 700;
  background: linear-gradient(160deg, #3d9bff, #0067d6);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35), 0 2px 6px rgba(0, 113, 227, .22);
}
.zp-titles { min-width: 0; }
.zp-titleline { display: flex; align-items: center; gap: 6px; }
.zp-titleline strong { font-size: 13.5px; font-weight: 600; letter-spacing: .1px; }
.zp-ver { padding: 1px 6px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink3); font-size: 9.5px; font-weight: 500; }
.zp-sub { display: block; max-width: 236px; margin-top: 1px; font-size: 11px; color: var(--z-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zp-header-actions { display: flex; flex: none; gap: 2px; margin-left: auto; }
.zp-iconbtn { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--z-ink2); transition: background .18s, color .18s; }
.zp-iconbtn:hover { background: var(--z-fill); color: var(--z-ink); }
.zp-iconbtn svg { width: 15px; height: 15px; }
.zp-chev { transition: transform .28s var(--z-ease); }
.zp-panel.is-collapsed .zp-body,
.zp-panel.is-collapsed .zp-foot { display: none; }
.zp-panel.is-collapsed .zp-chev { transform: rotate(180deg); }

.zp-body { flex: 1; min-height: 0; display: grid; align-content: start; gap: 10px; padding: 0 14px 12px; overflow: auto; overscroll-behavior: contain; }
.zp-status { display: flex; align-items: center; gap: 8px; padding: 0 2px; font-size: 11px; }
.zp-stage { display: inline-flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; color: var(--z-ink); }
.zp-stage > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zp-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--z-accent); box-shadow: 0 0 0 3px var(--z-accent-soft); }
.zp-dot.ok { background: var(--z-green); box-shadow: 0 0 0 3px var(--z-green-soft); }
.zp-dot.warn { background: var(--z-orange); box-shadow: 0 0 0 3px var(--z-orange-soft); }
.zp-count { margin-left: auto; color: var(--z-ink3); font-size: 10.5px; white-space: nowrap; }
.zp-chip { padding: 4px 7px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink2); font-size: 10px; line-height: 1; white-space: nowrap; }
.zp-chip.ok { background: var(--z-green-soft); color: var(--z-green-ink); }
.zp-chip.warn { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zp-chip.new { background: var(--z-accent-soft); color: var(--z-accent); font-weight: 600; }
.zp-track { height: 3px; border-radius: 999px; background: var(--z-fill); overflow: hidden; }
.zp-track i { display: block; width: 0; height: 100%; border-radius: inherit; background: var(--z-accent); transition: width .45s var(--z-ease); }

.zp-card { padding: 12px; border: 1px solid var(--z-hairline); border-radius: 14px; background: var(--z-card-t); }
.zp-result:empty { display: none; }
.zp-kicker { display: block; margin-bottom: 2px; font-size: 9.5px; font-weight: 600; letter-spacing: .3px; color: var(--z-ink3); }
.zp-qhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.zp-qmain { min-width: 0; }
.zp-qtitle { font-size: 15px; font-weight: 600; letter-spacing: -.2px; }
.zp-qmeta { margin-top: 2px; font-size: 10.5px; line-height: 1.55; color: var(--z-ink3); }
.zp-thumbs { display: flex; gap: 6px; margin-top: 9px; overflow-x: auto; padding-bottom: 1px; }
.zp-thumbs:empty { display: none; }
.zp-thumbs img {
  width: 52px; height: 52px; flex: none; object-fit: cover; border-radius: 9px;
  border: 1px solid var(--z-hairline); background: var(--z-card); cursor: zoom-in;
  transition: transform .2s var(--z-ease), box-shadow .2s;
}
.zp-thumbs img:hover { transform: translateY(-2px); box-shadow: 0 6px 14px rgba(15, 23, 42, .16); }

.zp-scorehead { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.zp-score { display: flex; align-items: baseline; gap: 4px; margin-top: 1px; }
.zp-score input {
  width: 108px; height: 46px; padding: 0 2px; border: 0; border-radius: 8px; background: transparent;
  color: var(--z-ink); font-size: 38px; font-weight: 600; letter-spacing: -1.6px; text-align: left;
  -moz-appearance: textfield; transition: background .18s, box-shadow .18s;
}
.zp-score input::-webkit-outer-spin-button,
.zp-score input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-score input:hover { background: var(--z-fill); }
.zp-score input:focus { outline: none; background: var(--z-card); box-shadow: 0 0 0 3px var(--z-ring); }
.zp-score > span { font-size: 12px; color: var(--z-ink3); white-space: nowrap; }
.zp-badges { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; padding-top: 16px; }
.zp-pill { padding: 3px 8px; border-radius: 999px; background: var(--z-fill); color: var(--z-ink2); font-size: 10.5px; font-weight: 500; white-space: nowrap; }
.zp-pill.ok { background: var(--z-green-soft); color: var(--z-green-ink); }
.zp-pill.warn { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zp-pill.bad { background: var(--z-red-soft); color: var(--z-red-ink); }
.zp-reason { margin: 9px 0 0; font-size: 12px; line-height: 1.68; color: var(--z-ink2); text-wrap: pretty; }
.zp-sublist { margin-top: 10px; border-top: 1px solid var(--z-hairline); }
.zp-subrow { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--z-hairline); }
.zp-subrow:last-child { border-bottom: 0; padding-bottom: 2px; }
.zp-submain { flex: 1; min-width: 0; }
.zp-sublabel { display: block; font-size: 11.5px; font-weight: 600; }
.zp-subreason { display: block; margin-top: 1px; font-size: 10.5px; line-height: 1.5; color: var(--z-ink3); text-wrap: pretty; }
.zp-subscore { display: flex; align-items: baseline; gap: 2px; flex: none; }
.zp-subscore input {
  width: 44px; height: 25px; padding: 0; border: 0; border-radius: 7px; background: var(--z-fill);
  color: var(--z-ink); font-size: 11.5px; font-weight: 600; text-align: center;
  -moz-appearance: textfield; transition: background .18s, box-shadow .18s;
}
.zp-subscore input::-webkit-outer-spin-button,
.zp-subscore input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-subscore input:focus { outline: none; background: var(--z-card); box-shadow: 0 0 0 3px var(--z-ring); }
.zp-subscore em { font-style: normal; font-size: 9.5px; color: var(--z-ink3); }
.zp-meta { margin-top: 8px; font-size: 11.5px; line-height: 1.6; color: var(--z-ink2); }
.zp-metaline + .zp-metaline { margin-top: 1px; }
.zp-reviews { margin-top: 8px; font-size: 10.5px; line-height: 1.6; color: var(--z-orange-ink); }
.zp-notice {
  display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;
  margin-top: 8px; padding: 7px 9px; border: 1px solid rgba(255, 149, 0, .28); border-radius: 9px;
  background: var(--z-orange-soft); color: var(--z-orange-ink); font-size: 10.5px; line-height: 1.5; text-align: left;
}
.zp-notice:hover { filter: brightness(1.03); }
.zp-notice svg { width: 12px; height: 12px; flex: none; }
.zp-empty { padding: 22px 12px; text-align: center; }
.zp-empty-icon { width: 36px; height: 36px; margin: 0 auto; display: grid; place-items: center; border-radius: 11px; background: var(--z-accent-soft); color: var(--z-accent); }
.zp-empty-icon svg { width: 18px; height: 18px; }
.zp-empty strong { display: block; margin-top: 10px; font-size: 12.5px; font-weight: 600; }
.zp-empty p { margin: 4px 0 0; font-size: 11px; line-height: 1.6; color: var(--z-ink3); }
.zp-error { padding: 9px 11px; border-radius: 10px; background: var(--z-red-soft); color: var(--z-red-ink); font-size: 11px; line-height: 1.6; }

.zp-foot { flex: none; padding: 10px 12px 12px; border-top: 1px solid var(--z-hairline); background: var(--z-foot); }
.zp-actions { display: flex; gap: 8px; }
.zp-btn {
  height: 34px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 0 14px; border-radius: 10px; background: var(--z-fill); color: var(--z-ink);
  font-size: 12.5px; font-weight: 500; transition: background .18s, filter .18s, transform .12s;
}
.zp-btn:hover { background: var(--z-fill-2); }
.zp-btn:active { transform: scale(.985); }
.zp-btn.primary { flex: 1; background: var(--z-accent); color: #fff; font-weight: 600; box-shadow: 0 4px 12px -4px rgba(0, 113, 227, .5); }
.zp-btn.primary:hover { filter: brightness(1.06); }
.zp-btn.running { background: var(--z-red); color: #fff; font-weight: 600; }
.zp-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.zp-submit { width: 96px; flex: none; }
.zp-options { display: flex; align-items: center; gap: 6px; margin-top: 8px; }
.zp-mini {
  height: 26px; display: inline-flex; align-items: center; gap: 4px; padding: 0 9px;
  border-radius: 8px; background: var(--z-fill); font-size: 11px; color: var(--z-ink); white-space: nowrap;
  transition: background .18s, color .18s;
}
.zp-mini:hover { background: var(--z-fill-2); }
.zp-mini svg { width: 11px; height: 11px; }
.zp-mini.running { background: var(--z-red-soft); color: var(--z-red-ink); }
.zp-optlabel { font-size: 10px; color: var(--z-ink3); white-space: nowrap; }
.zp-stepper { display: inline-flex; align-items: center; height: 26px; padding: 0 2px; border-radius: 8px; background: var(--z-fill); gap: 1px; }
.zp-stepper button { width: 19px; height: 22px; display: grid; place-items: center; border-radius: 6px; color: var(--z-ink2); font-size: 13px; line-height: 1; }
.zp-stepper button:hover { background: var(--z-fill-2); }
.zp-stepper button:disabled { opacity: .4; }
.zp-stepper input {
  width: 30px; height: 22px; padding: 0; border: 0; background: transparent; text-align: center;
  font-size: 11px; font-weight: 600; -moz-appearance: textfield;
}
.zp-stepper input::-webkit-outer-spin-button,
.zp-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.zp-stepper input:focus { outline: none; }
.zp-stepper input:disabled { opacity: .5; }
.zp-seg { display: inline-flex; gap: 1px; margin-left: auto; padding: 2px; border-radius: 8px; background: var(--z-fill); }
.zp-seg button { height: 22px; padding: 0 7px; border-radius: 6px; font-size: 10.5px; color: var(--z-ink2); white-space: nowrap; }
.zp-seg button[aria-pressed="true"] { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: var(--z-shadow-sm); }
.zp-seg button:disabled { opacity: .5; }
.zp-footbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--z-hairline); }
.zp-skip { position: relative; display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; color: var(--z-ink2); cursor: pointer; user-select: none; }
.zp-skip input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.zp-switch { position: relative; width: 32px; height: 19px; flex: none; border-radius: 999px; background: var(--z-fill-2); transition: background .22s var(--z-ease); }
.zp-switch::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .28); transition: transform .22s var(--z-ease);
}
.zp-skip input:checked + .zp-switch { background: var(--z-green); }
.zp-skip input:checked + .zp-switch::after { transform: translateX(13px); }
.zp-skip input:focus-visible + .zp-switch { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zp-tools { display: flex; align-items: center; gap: 2px; }
.zp-quiet { display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border-radius: 7px; font-size: 11px; color: var(--z-ink2); }
.zp-quiet:hover { background: var(--z-fill); color: var(--z-ink); }
.zp-quiet svg { width: 12px; height: 12px; }

/* ---------- 弹层骨架 ---------- */
.zygr-overlay {
  position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; padding: 24px;
  background: rgba(0, 0, 0, .24);
  -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  animation: zo-in .24s ease;
}
@keyframes zo-in { from { opacity: 0; } to { opacity: 1; } }
.zygr-dialog {
  position: relative; width: min(880px, 100%); height: min(760px, calc(100vh - 48px));
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--z-bg-solid); border: 1px solid var(--z-hairline); border-radius: 22px;
  box-shadow: var(--z-shadow-lg); animation: zd-in .32s var(--z-ease);
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .zygr-overlay { background: rgba(0, 0, 0, .38); }
}
@keyframes zd-in { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: none; } }
.zygr-dialog.zygr-help { width: min(560px, 100%); height: auto; max-height: min(82vh, 700px); }
.zg-head { flex: none; display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 18px 20px 14px 22px; }
.zg-head h2 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.3px; }
.zg-head p { margin: 3px 0 0; font-size: 11.5px; color: var(--z-ink3); }
.zg-head .zp-iconbtn { margin-top: 2px; }

/* ---------- 设置 ---------- */
.zg-shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 192px minmax(0, 1fr); }
.zg-nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 10px 12px; border-right: 1px solid var(--z-hairline); background: rgba(120, 120, 128, .045); overflow: auto; }
.zg-navitem { display: flex; align-items: center; gap: 9px; height: 34px; padding: 0 9px; border-radius: 9px; font-size: 12.5px; color: var(--z-ink2); text-align: left; transition: background .18s, color .18s; }
.zg-navitem:hover { background: var(--z-fill); }
.zg-navitem.is-active { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .07); }
.zg-tile { width: 22px; height: 22px; flex: none; display: grid; place-items: center; border-radius: 6px; color: #fff; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25); }
.zg-tile svg { width: 13px; height: 13px; }
.zg-tile.blue { background: #0a84ff; }
.zg-tile.purple { background: #5e5ce6; }
.zg-tile.pink { background: #ff375f; }
.zg-tile.gray { background: #8e8e93; }
.zg-navfoot { margin-top: auto; padding: 14px 9px 0; font-size: 10px; line-height: 1.6; color: var(--z-ink3); }
.zg-pane { overflow: auto; padding: 8px 22px 28px; }

.zg-page { display: none; align-content: start; gap: 18px; }
.zg-page.is-active { display: grid; }
.zg-pagehead h2 { margin: 6px 0 0; font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
.zg-pagehead p { margin: 4px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--z-ink3); }
.zg-section { display: grid; gap: 0; }
.zg-grouptitle { margin: 0 0 7px 2px; font-size: 11.5px; font-weight: 600; color: var(--z-ink2); }
.zg-note { margin: 7px 2px 0; font-size: 10.5px; line-height: 1.6; color: var(--z-ink3); text-wrap: pretty; }
.zg-group { overflow: hidden; background: var(--z-card); border-radius: 12px; box-shadow: 0 0 0 1px var(--z-hairline); }
.zg-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 9px 14px; }
.zg-row + .zg-row { border-top: 1px solid var(--z-hairline); }
.zg-rowmain { flex: 1; min-width: 0; }
.zg-rowlabel { display: block; font-size: 12.5px; }
.zg-rowdesc { display: block; margin-top: 1px; font-size: 10.5px; line-height: 1.5; color: var(--z-ink3); text-wrap: pretty; }
.zg-rowactions { display: flex; flex: none; gap: 6px; }
.zg-rowvalue { flex: none; font-size: 12px; color: var(--z-ink2); }
.zg-statsline { margin: 0; padding: 10px 14px; font-size: 11px; line-height: 1.65; color: var(--z-ink2); }

.zg-field { display: block; padding: 12px 14px; }
.zg-field + .zg-field { border-top: 1px solid var(--z-hairline); }
.zg-field > label:not(.zg-drop) { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; font-size: 12px; font-weight: 600; }
.zg-opt, .zg-req { padding: 1px 6px; border-radius: 999px; font-size: 9.5px; font-weight: 400; }
.zg-opt { background: var(--z-fill); color: var(--z-ink3); }
.zg-req { background: var(--z-orange-soft); color: var(--z-orange-ink); }

.zg-input, .zg-field textarea, .zg-select select {
  width: 100%; border: 1px solid transparent; border-radius: 9px; background: var(--z-fill);
  font-size: 12.5px; transition: background .18s, box-shadow .18s, border-color .18s;
}
.zg-input { height: 30px; padding: 0 10px; }
.zg-field textarea { display: block; min-height: 62px; padding: 9px 11px; line-height: 1.65; resize: vertical; }
.zg-input:hover, .zg-field textarea:hover, .zg-select select:hover { background: var(--z-fill-2); }
.zg-input:focus, .zg-field textarea:focus, .zg-select select:focus {
  outline: none; background: var(--z-card); border-color: var(--z-accent); box-shadow: 0 0 0 3px var(--z-ring);
}
.zg-input::placeholder, .zg-field textarea::placeholder { color: var(--z-ink3); }
.zg-num { width: 88px; flex: none; text-align: right; }
.zg-inputwrap { position: relative; flex: 1; min-width: 0; max-width: 340px; }
.zg-inputwrap .zg-input { padding-right: 50px; }
.zg-inputwrap button { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); height: 24px; padding: 0 8px; border-radius: 6px; font-size: 10.5px; color: var(--z-ink2); }
.zg-inputwrap button:hover { background: var(--z-fill); }
.zg-select { position: relative; flex: none; width: 168px; }
.zg-select::after {
  content: ""; position: absolute; right: 11px; top: 50%; width: 6px; height: 6px; pointer-events: none;
  border-right: 1.5px solid var(--z-ink3); border-bottom: 1.5px solid var(--z-ink3);
  transform: translateY(-70%) rotate(45deg);
}
.zg-select select { height: 30px; padding: 0 26px 0 10px; appearance: none; -webkit-appearance: none; }
.zg-select.wide { width: 210px; }

.zg-switch { position: relative; display: inline-flex; flex: none; cursor: pointer; }
.zg-switch input { position: absolute; width: 1px; height: 1px; margin: 0; opacity: 0; pointer-events: none; }
.zg-switch-track { position: relative; width: 42px; height: 25px; border-radius: 999px; background: var(--z-fill-2); transition: background .22s var(--z-ease); }
.zg-switch-track::after {
  content: ""; position: absolute; top: 2px; left: 2px; width: 21px; height: 21px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .28); transition: transform .22s var(--z-ease);
}
.zg-switch input:checked + .zg-switch-track { background: var(--z-green); }
.zg-switch input:checked + .zg-switch-track::after { transform: translateX(17px); }
.zg-switch input:focus-visible + .zg-switch-track { outline: 2px solid var(--z-accent); outline-offset: 2px; }

.zg-seg { display: inline-flex; gap: 1px; padding: 2px; border-radius: 8px; background: var(--z-fill); }
.zg-seg button { height: 26px; padding: 0 11px; border-radius: 6px; font-size: 11.5px; color: var(--z-ink2); white-space: nowrap; }
.zg-seg button[aria-pressed="true"] { background: var(--z-card); color: var(--z-ink); font-weight: 600; box-shadow: var(--z-shadow-sm); }

.zg-btn {
  height: 32px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 14px;
  border-radius: 9px; background: var(--z-fill); color: var(--z-ink); font-size: 12.5px; font-weight: 500;
  transition: background .18s, filter .18s, transform .12s;
}
.zg-btn:hover { background: var(--z-fill-2); }
.zg-btn:active { transform: scale(.985); }
.zg-btn.primary { background: var(--z-accent); color: #fff; font-weight: 600; }
.zg-btn.primary:hover { filter: brightness(1.06); }
.zg-btn.ghost { background: transparent; color: var(--z-ink2); }
.zg-btn.ghost:hover { background: var(--z-fill); color: var(--z-ink); }
.zg-btn.danger { background: transparent; color: var(--z-red-ink); }
.zg-btn.danger:hover { background: var(--z-red-soft); }
.zg-btn.small { height: 28px; padding: 0 10px; font-size: 11.5px; }
.zg-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }

.zg-status { font-size: 11px; line-height: 1.5; color: var(--z-ink3); }
.zg-status.ok { color: var(--z-green-ink); }
.zg-status.bad { color: var(--z-red-ink); }
.zg-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.zg-inline .zg-status { margin-left: 2px; }

.zg-drop {
  position: relative;
  display: grid; place-items: center; gap: 5px; padding: 16px; text-align: center;
  border: 1px dashed var(--z-hairline); border-radius: 10px; background: var(--z-fill);
  font-size: 11.5px; color: var(--z-ink2); cursor: pointer; transition: background .18s, border-color .18s;
}
.zg-drop:hover { background: var(--z-fill-2); border-color: var(--z-ink3); }
.zg-drop:focus-within { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zg-drop svg { width: 18px; height: 18px; color: var(--z-ink3); }
.zg-drop small { font-size: 10px; color: var(--z-ink3); }
.zg-drop input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

.zg-lead { margin: 0; font-size: 12px; line-height: 1.7; color: var(--z-ink2); }
.zg-bullets { padding: 4px 14px; }
.zg-bullets ul { margin: 7px 0 8px; padding-left: 17px; display: grid; gap: 5px; }
.zg-bullets li { font-size: 11.5px; line-height: 1.65; color: var(--z-ink2); }
.zg-stats { display: grid; grid-template-columns: 1fr 1fr; }
.zg-stat { padding: 11px 14px; }
.zg-stat:nth-child(odd) { border-right: 1px solid var(--z-hairline); }
.zg-stat:nth-child(n+3) { border-top: 1px solid var(--z-hairline); }
.zg-stat b { display: block; font-size: 17px; font-weight: 600; letter-spacing: -.3px; }
.zg-stat span { display: block; margin-top: 2px; font-size: 10.5px; color: var(--z-ink3); }

.zg-foot { flex: none; display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--z-hairline); background: var(--z-card-t); }
.zg-foot-left, .zg-foot-right { display: flex; align-items: center; gap: 6px; }
.zg-foot-left { flex: 1; }

/* ---------- 历史 ---------- */
.zh-toolbar { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 20px 10px; }
.zh-search { position: relative; width: 236px; margin-left: auto; }
.zh-search input {
  width: 100%; height: 30px; padding: 0 10px 0 28px; border: 1px solid transparent; border-radius: 8px;
  background: var(--z-fill); font-size: 12px; transition: background .18s, box-shadow .18s, border-color .18s;
}
.zh-search input:focus { outline: none; background: var(--z-card); border-color: var(--z-accent); box-shadow: 0 0 0 3px var(--z-ring); }
.zh-search svg { position: absolute; left: 9px; top: 50%; width: 13px; height: 13px; color: var(--z-ink3); transform: translateY(-50%); pointer-events: none; }
.zh-summary { flex: none; padding: 0 22px 9px; font-size: 10.5px; color: var(--z-ink3); }
.zh-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 318px minmax(0, 1fr); gap: 14px; padding: 0 20px 16px; }
.zh-list { display: grid; align-content: start; gap: 6px; overflow-y: auto; overflow-x: hidden; padding-right: 2px; }
.zh-row {
  display: flex; align-items: center; min-width: 0; padding: 0; border-radius: 11px;
  background: var(--z-card); box-shadow: 0 0 0 1px var(--z-hairline);
  transition: box-shadow .18s, transform .18s;
}
.zh-row:hover { transform: translateY(-1px); box-shadow: 0 0 0 1px var(--z-hairline), 0 6px 16px -8px rgba(15, 23, 42, .35); }
.zh-row.is-selected { box-shadow: 0 0 0 1.5px var(--z-accent); }
.zh-row:focus-within { outline: 2px solid var(--z-accent); outline-offset: 2px; }
.zh-select { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 9px 4px 9px 11px; border-radius: 11px 0 0 11px; text-align: left; }
.zh-score { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 10px; background: var(--z-fill); font-size: 13px; font-weight: 600; }
.zh-row.needs .zh-score { background: var(--z-orange-soft); color: var(--z-orange-ink); }
.zh-main { flex: 1; min-width: 0; }
.zh-l1 { display: block; font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zh-l2 { display: block; margin-top: 2px; font-size: 10.5px; color: var(--z-ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.zh-arrow { width: 13px; height: 13px; flex: none; color: var(--z-ink3); }
.zh-jump { flex: none; margin-right: 9px; padding: 3px 7px; border-radius: 6px; background: var(--z-accent-soft); color: var(--z-accent); font-size: 10px; }
.zh-jump:hover { filter: brightness(.97); }
.zh-detail { overflow: auto; padding: 16px; background: var(--z-card); border-radius: 14px; box-shadow: 0 0 0 1px var(--z-hairline); }
.zh-detailhead { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.zh-bigscore { margin-top: 1px; font-size: 32px; font-weight: 600; letter-spacing: -1.2px; line-height: 1.1; }
.zh-bigscore span { margin-left: 3px; font-size: 12px; font-weight: 400; letter-spacing: 0; color: var(--z-ink3); }
.zh-stats { margin: 12px 0 0; border-top: 1px solid var(--z-hairline); }
.zh-statrow { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; font-size: 11.5px; }
.zh-statrow + .zh-statrow { border-top: 1px solid var(--z-hairline); }
.zh-statrow dt { flex: none; width: 74px; color: var(--z-ink3); font-size: 10.5px; }
.zh-statrow dd { margin: 0; flex: 1; min-width: 0; color: var(--z-ink2); line-height: 1.6; text-wrap: pretty; }
.zh-h4 { margin: 14px 0 2px; font-size: 11px; font-weight: 600; color: var(--z-ink3); }
.zh-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.zh-empty { padding: 40px 12px; text-align: center; font-size: 11.5px; color: var(--z-ink3); }

/* ---------- 提示条 ---------- */
.zygr-toast {
  position: absolute; left: 50%; bottom: 86px; z-index: 6; transform: translateX(-50%);
  max-width: calc(100% - 28px); padding: 8px 14px; border-radius: 999px;
  background: rgba(29, 29, 31, .9); color: #fff; font-size: 11.5px; line-height: 1.4;
  text-align: center; pointer-events: none; box-shadow: 0 10px 28px rgba(0, 0, 0, .22);
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);
  animation: zt-in .22s var(--z-ease);
}
.zp-panel > .zygr-toast { bottom: 122px; }
.zygr-dialog > .zygr-toast { bottom: 70px; }
@keyframes zt-in { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

/* ---------- 缓存说明（showCacheHelp 生成的内容） ---------- */
.zygr-cache-help-body { display: grid; gap: 12px; overflow: auto; padding: 4px 20px 20px; }
.zygr-cache-help-summary { margin: 0; font-size: 12px; line-height: 1.7; color: var(--z-ink); }
.zygr-cache-help-impact {
  margin: 0; padding: 9px 11px; border-radius: 9px; font-size: 11.5px; line-height: 1.6;
  background: var(--z-green-soft); color: var(--z-green-ink);
}
.zygr-cache-help-section { display: grid; gap: 5px; }
.zygr-cache-help-section h3 { margin: 0; font-size: 12px; font-weight: 600; color: var(--z-ink2); }
.zygr-cache-help-section ul { margin: 0; padding-left: 17px; display: grid; gap: 4px; }
.zygr-cache-help-section li { font-size: 11.5px; line-height: 1.65; color: var(--z-ink2); }
.zygr-hint { margin: 0; font-size: 10.5px; line-height: 1.6; color: var(--z-ink3); }

@media (max-width: 860px) {
  .zygr-dialog { height: min(820px, calc(100vh - 32px)); }
  .zg-shell { grid-template-columns: 1fr; }
  .zg-nav { flex-direction: row; overflow-x: auto; padding: 0 12px 8px; border-right: 0; border-bottom: 1px solid var(--z-hairline); }
  .zg-navitem { height: 32px; white-space: nowrap; }
  .zg-navfoot { display: none; }
  .zg-pane { padding: 14px 16px 22px; }
  .zh-body { grid-template-columns: 1fr; }
  .zh-list { max-height: 34vh; }
  .zh-detail { min-height: 240px; }
}
@media (max-width: 640px) {
  .zygr-overlay { padding: 0; place-items: end center; }
  .zygr-dialog { width: 100%; height: calc(100vh - 24px); border-radius: 20px 20px 0 0; }
  .zh-toolbar { flex-wrap: wrap; }
  .zh-search { width: 100%; margin-left: 0; }
  .zg-row { flex-wrap: wrap; }
  .zg-select, .zg-select.wide { width: 100%; }
  .zg-inputwrap { max-width: none; }
  .zg-foot { flex-wrap: wrap; }
  .zg-seg { flex-wrap: wrap; }
}
@media (max-width: 520px) {
  .zp-panel { left: 10px; right: 10px; bottom: 10px; width: auto; max-height: 78vh; border-radius: 18px; }
  .zp-options { flex-wrap: wrap; }
  .zp-seg { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;
