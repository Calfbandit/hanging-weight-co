/* Hanging Weight Co. shared site script.
   Each page sets its CONFIG constants (HW_API, SESSION_URL, PACKAGE_URL, MIXPANEL_TOKEN, CAPTURE_URL) in an inline script
   BEFORE this file loads. No secrets here or there.
   - HW.collect(type, data): POST {type, vid, src, page, data} to HW_API + "/collect" (Allen's board). Never throws.
   - HW.track(name, props): Mixpanel, tagged site=hanging_weight. Never throws.
   - Package interest dialog (#pkgDialog), copy-email buttons ([data-copy]). */
(function(){
  "use strict";
  // Page-level config constants (top-level const in the page's inline script is visible here by name).
  const API = typeof HW_API !== "undefined" ? HW_API : "";
  const MP = typeof MIXPANEL_TOKEN !== "undefined" ? MIXPANEL_TOKEN : "";
  const CAPTURE = typeof CAPTURE_URL !== "undefined" ? CAPTURE_URL : "";
  const PKG = typeof PACKAGE_URL !== "undefined" ? PACKAGE_URL : "";
  const OWNER_EMAIL = "theherd@herddirect.net";

  const store = {
    get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    set(k, v){ try{ localStorage.setItem(k, v); }catch(e){} },
    getJSON(k){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }catch(e){ return null; } },
    setJSON(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
  };
  const rid = () => {
    try{ if(window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 20); }catch(e){}
    return (Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  };
  let memVid = null, memSrc = null;
  function vid(){
    let v = store.get("hw_vid");
    if(!v){ v = memVid || rid(); store.set("hw_vid", v); }
    memVid = v; return v;
  }
  function src(){
    let s = store.get("hw_src") || memSrc;
    if(s) return s;
    let utm = "", ref = "";
    try{ utm = (new URLSearchParams(location.search).get("utm_source") || "").trim().slice(0, 80); }catch(e){}
    try{ if(document.referrer){ const h = new URL(document.referrer).host; if(h && h !== location.host) ref = h; } }catch(e){}
    s = utm || ref || "direct";
    store.set("hw_src", s); memSrc = s; return s;
  }

  // POST one event to the board's collector. Resolves to the parsed response ({ok, id}) or null. Never rejects.
  function collect(type, data, timeoutMs){
    if(!API) return Promise.resolve(null);
    const body = JSON.stringify({ type, vid: vid(), src: src(), page: location.pathname, data: data || {} });
    let p;
    try{
      p = fetch(API.replace(/\/$/, "") + "/collect", {
        method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true, mode: "cors", credentials: "omit"
      }).then(r => r.ok ? r.json().catch(() => ({ok:true})) : null).then(j => (j && j.ok !== false) ? j : null).catch(() => null);
    }catch(e){ return Promise.resolve(null); }
    if(!timeoutMs) return p;
    return Promise.race([p, new Promise(res => setTimeout(() => res(null), timeoutMs))]);
  }

  // Mixpanel (same project and settings as before; every event carries site=hanging_weight)
  if(MP){
    try{
      (function(f,b){if(!b.__SV){var e,g,i,h;window.mixpanel=b;b._i=[];b.init=function(e,f,c){function g(a,d){var b=d.split(".");2==b.length&&(a=a[b[0]],d=b[1]);a[d]=function(){a.push([d].concat(Array.prototype.slice.call(arguments,0)))}}var a=b;"undefined"!==typeof c?a=b[c]=[]:c="mixpanel";a.people=a.people||[];a.toString=function(a){var d="mixpanel";"mixpanel"!==c&&(d+="."+c);a||(d+=" (stub)");return d};a.people.toString=function(){return a.toString(1)+".people (stub)"};i="disable time_event track track_pageview track_links track_forms track_with_groups add_group set_group remove_group register register_once alias unregister identify name_tag set_config reset opt_in_tracking opt_out_tracking has_opted_in_tracking has_opted_out_tracking clear_opt_in_out_tracking start_batch_senders people.set people.set_once people.unset people.increment people.append people.union people.track_charge people.clear_charges people.delete_user people.remove".split(" ");for(h=0;h<i.length;h++)g(a,i[h]);var j="set set_once union unset remove delete".split(" ");a.get_group=function(){function b(c){d[c]=function(){var call2_args=arguments;var call2=[c].concat(Array.prototype.slice.call(call2_args,0));a.push([e,call2])}}for(var d={},e=["get_group"].concat(Array.prototype.slice.call(arguments,0)),c=0;c<j.length;c++)b(j[c]);return d};b._i.push([e,f,c])};b.__SV=1.2;e=f.createElement("script");e.type="text/javascript";e.async=!0;e.src="https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js";g=f.getElementsByTagName("script")[0];g.parentNode.insertBefore(e,g)}})(document,window.mixpanel||[]);
      mixpanel.init(MP, {track_pageview: "url-with-path", persistence: "localStorage", autocapture: false, record_sessions_percent: 0});
      mixpanel.register({ site: "hanging_weight" });
    }catch(e){}
  }
  function track(name, props){ try{ if(window.mixpanel && MP) mixpanel.track(name, props || {}); }catch(e){} }

  const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const mailto = (subject, body) => { location.href = "mailto:" + OWNER_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body); };

  window.HW = { store, collect, track, vid, src, rid, emailOk, mailto, OWNER_EMAIL };

  // One visit per page load, on every page.
  vid(); src();
  collect("visit", {});

  document.addEventListener("DOMContentLoaded", function(){
    const $ = id => document.getElementById(id);

    // Copy-email buttons: <button data-copy="addr-element-id">
    document.querySelectorAll("[data-copy]").forEach(btn => {
      btn.addEventListener("click", () => {
        const el = $(btn.getAttribute("data-copy")); const msg = $(btn.getAttribute("data-copy-msg"));
        const text = (el && el.textContent.trim()) || OWNER_EMAIL;
        const say = t => { if(msg) msg.textContent = t; };
        const fallback = () => {
          try{ const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }catch(e){}
          say("Selected. Copy it with your phone's copy command.");
        };
        try{
          if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => say("Copied."), fallback);
          else fallback();
        }catch(e){ fallback(); }
      });
    });

    // Links to the free calculator
    document.querySelectorAll('a[data-cta="calculator"]').forEach(a => a.addEventListener("click", () => track("calculator_link_clicked", {from: a.getAttribute("data-from") || location.pathname})));
    // Links to the $197 booking page
    document.querySelectorAll('a[data-cta="book"]').forEach(a => a.addEventListener("click", () => track("session_cta_clicked", {from: a.getAttribute("data-from") || location.pathname})));

    // $2,000 package: checkout link if set, otherwise the "Tell Allen you're interested" form. Never a fake checkout.
    const dlg = $("pkgDialog");
    const openPkg = (from) => {
      track("upgrade_cta_clicked", {from, has_link: !!PKG});
      if(PKG){ track("package_checkout_opened", {from}); window.open(PKG, "_blank", "noopener"); return; }
      if(!dlg) return;
      if(typeof window.HW_PKG_PREFILL === "function"){ try{ window.HW_PKG_PREFILL(); }catch(e){} }
      $("pkgStatus").textContent = ""; $("pkgStatus").className = "status";
      if(typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
      $("pkgName").focus();
    };
    document.querySelectorAll("[data-cta='package']").forEach(b => b.addEventListener("click", e => { e.preventDefault(); openPkg(b.getAttribute("data-from") || location.pathname); }));
    if(dlg){
      const close = () => { if(dlg.close) dlg.close(); else dlg.removeAttribute("open"); };
      $("pkgClose").addEventListener("click", close);
      dlg.addEventListener("click", e => { if(e.target === dlg) close(); });
      $("pkgForm").addEventListener("submit", async e => {
        e.preventDefault();
        const st = $("pkgStatus");
        const name = $("pkgName").value.trim(), phone = $("pkgPhone").value.trim(), email = $("pkgEmail").value.trim();
        const heads = $("pkgHeads").value.trim(), message = ($("pkgMsg") ? $("pkgMsg").value.trim() : "");
        $("pkgName").removeAttribute("aria-invalid"); $("pkgPhone").removeAttribute("aria-invalid"); $("pkgEmail").removeAttribute("aria-invalid");
        st.className = "status err";
        if(!name){ st.textContent = "Please add your name."; $("pkgName").setAttribute("aria-invalid","true"); $("pkgName").focus(); return; }
        if(phone.replace(/\D/g, "").length < 10){ st.textContent = "Please add a phone number with area code so Allen can call or text."; $("pkgPhone").setAttribute("aria-invalid","true"); $("pkgPhone").focus(); return; }
        if(email && !emailOk(email)){ st.textContent = "That email doesn't look right. Fix it or leave it blank."; $("pkgEmail").setAttribute("aria-invalid","true"); $("pkgEmail").focus(); return; }
        if($("pkgWebsite").value){ st.className = "status ok"; st.textContent = "Got it."; return; }
        const from = location.pathname;
        $("pkgSend").disabled = true; st.className = "status"; st.textContent = "Sending…";
        const done = via => { st.className = "status ok"; st.textContent = "Got it. Allen will call or text you within one business day. No payment now."; track("package_interest_sent", {via, from}); $("pkgForm").reset(); };
        try{
          const r = await collect("package_interest", { name, email, phone, heads, message }, 8000);
          if(r){ done("api"); return; }
          if(CAPTURE){
            const resp = await fetch(CAPTURE, { method: "POST", headers: {"Content-Type": "application/json"},
              body: JSON.stringify({ type: "package_interest", source: "package_interest", name, phone, email, heads, website: "", page: location.href }) });
            if(resp.ok){ done("capture"); return; }
          }
          throw new Error("no endpoint");
        }catch(err){
          mailto("Ranch Store in a Box - interested", "I'm interested in Ranch Store in a Box ($2,000).\n\nName: " + name + "\nPhone: " + phone + "\nEmail: " + email + "\nHead count: " + heads + (message ? "\n\n" + message : "") + "\n\nPlease call or text me.");
          st.className = "status"; st.textContent = "Your email app should open with this filled in. Hit send and Allen will reach out.";
          track("package_interest_sent", {via: "mailto", from});
        }finally{ $("pkgSend").disabled = false; }
      });
    }
  });
})();
