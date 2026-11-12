/**
 * The widget's stylesheet. It lives inside a shadow root, so the host page's CSS cannot reach
 * it and it cannot reach the host page. Colors come from two custom properties set from the
 * business's settings: --p (the color) and --op (text on the color).
 */
export const STYLES = `
:host{all:initial}
*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.root{position:fixed;bottom:20px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;gap:12px;color:#111827;font-size:15px;font-weight:400;font-style:normal;line-height:1.4;letter-spacing:normal;word-spacing:normal;text-align:left;text-transform:none;text-indent:0;white-space:normal;direction:ltr;visibility:visible}
.root.left{left:20px;align-items:flex-start}
.root:not(.left){right:20px}
button{font:inherit;cursor:pointer}
.bubble{width:60px;height:60px;border-radius:50%;border:0;background:var(--p);color:var(--op);display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25);position:relative;transition:transform .15s}
.bubble:hover{transform:scale(1.05)}
.bubble:focus-visible,.send:focus-visible,.icon:focus-visible,.chip:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
.bubble svg{width:28px;height:28px}
.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#dc2626;color:#fff;font-size:12px;font-weight:600;display:grid;place-items:center;padding:0 5px}
.teaser{max-width:240px;background:#fff;border-radius:12px;padding:10px 32px 10px 14px;box-shadow:0 4px 16px rgba(0,0,0,.18);position:relative;cursor:pointer}
.teaser .x{position:absolute;top:4px;right:4px;border:0;background:none;color:#6b7280;font-size:16px;width:24px;height:24px}
.panel{width:380px;height:min(640px,calc(100vh - 110px));background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden}
[hidden]{display:none!important}
.head{background:var(--p);color:var(--op);padding:14px 12px 14px 16px;display:flex;align-items:center;gap:12px}
.avatar{width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.2);display:grid;place-items:center;font-weight:700;font-size:18px;flex:none;overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover}
.titles{flex:1;min-width:0}
.title{font-weight:650;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.subtitle{font-size:13px;opacity:.85}
.icon{border:0;background:transparent;color:inherit;width:36px;height:36px;border-radius:8px;display:grid;place-items:center}
.icon:hover{background:rgba(127,127,127,.15)}
.icon svg{width:22px;height:22px}
.notice{background:#fef3c7;color:#78350f;font-size:13px;padding:8px 16px;border-bottom:1px solid #fde68a}
.log{flex:1;overflow-y:auto;padding:16px 12px;display:flex;flex-direction:column;gap:8px;background:#f9fafb;overscroll-behavior:contain}
.msg{max-width:82%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.msg.bot{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-bottom-left-radius:4px}
.msg.visitor{align-self:flex-end;background:var(--p);color:var(--op);border-bottom-right-radius:4px}
.msg.photo{padding:4px}
.msg.pending{opacity:.6}
.msg.failed{outline:2px solid #dc2626}
.msg a{color:inherit;text-decoration:underline}
.msg img{display:block;max-width:100%;max-height:240px;border-radius:10px;margin:2px 0}
.who{font-size:11px;color:#6b7280;margin:0 4px -4px}
.typing{align-self:flex-start;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:12px 14px;display:flex;gap:4px}
.typing i{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:b 1.2s infinite}
.typing i:nth-child(2){animation-delay:.2s}.typing i:nth-child(3){animation-delay:.4s}
@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}
.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 12px 8px;background:#f9fafb}
.chip{border:1px solid var(--p);color:var(--p);background:#fff;border-radius:16px;padding:6px 12px;font-size:14px}
.error{color:#b91c1c;font-size:13px;padding:6px 16px;background:#fef2f2}
.form{padding:16px;display:flex;flex-direction:column;gap:10px;border-top:1px solid #e5e7eb}
.form p{margin:0;font-size:14px;color:#374151}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#374151}
input,textarea{font:inherit;font-size:16px;border:1px solid #d1d5db;border-radius:10px;padding:9px 11px;color:#111827;background:#fff;width:100%}
input:focus,textarea:focus{outline:2px solid var(--p);border-color:transparent}
.primary{border:0;border-radius:10px;padding:11px;background:var(--p);color:var(--op);font-weight:600}
.compose{display:flex;align-items:flex-end;gap:6px;padding:10px;border-top:1px solid #e5e7eb}
.compose textarea{resize:none;max-height:120px;min-height:42px;line-height:1.35}
.compose .icon{color:#4b5563;flex:none;width:42px;height:42px}
.send{border:0;background:var(--p);color:var(--op);width:42px;height:42px;border-radius:50%;display:grid;place-items:center;flex:none}
.send svg{width:20px;height:20px}
.send:disabled{opacity:.5;cursor:default}
.privacy{font-size:11px;color:#6b7280;padding:0 12px 10px;text-align:center}
.privacy a{color:inherit}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:640px){
.root.open{inset:0;bottom:0}
.root.open .bubble,.root.open .teaser{display:none}
.root.open .panel{width:100%;height:100%;border-radius:0;box-shadow:none;padding-bottom:env(safe-area-inset-bottom)}
.root.open{gap:0}
}
@media (prefers-reduced-motion:reduce){.typing i{animation:none}.bubble{transition:none}}
`;
