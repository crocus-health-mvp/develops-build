// Develops — приём заявок и метрик с лендингов (Катар, Дубай).
// Привязки в Cloudflare: KV namespace LEADS; секреты TG_TOKEN, TG_CHAT, ADMIN_KEY.
// Маршруты: POST /lead — заявка; POST /event — событие воронки; GET /stats?key=ADMIN_KEY — воронка и заявки.

const ALLOWED = ["https://develops.build", "https://www.develops.build", "https://crocus-health-mvp.github.io"];
const EVENTS = ["view", "cta_header", "cta_hero", "cta_how", "cta_sticky", "form_start", "lead"];

function cors(req) {
  const o = req.headers.get("Origin") || "";
  const ok = ALLOWED.includes(o) || o.endsWith(".github.io");
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED[0],
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
const json = (obj, status, h) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });
const day = () => new Date().toISOString().slice(0, 10);
const clip = (s, n = 200) => String(s ?? "").slice(0, n);

async function bump(env, key) {
  const v = parseInt((await env.LEADS.get(key)) || "0", 10);
  await env.LEADS.put(key, String(v + 1));
}

export default {
  async fetch(req, env) {
    const h = cors(req);
    if (req.method === "OPTIONS") return new Response(null, { headers: h });
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/event") {
      let b = {};
      try { b = JSON.parse(await req.text()); } catch (e) { return json({ ok: false }, 400, h); }
      if (!EVENTS.includes(b.ev)) return json({ ok: false }, 400, h);
      const market = clip(b.market, 20) || "unknown", src = clip(b.src, 40) || "direct";
      await bump(env, `ev:${market}:${day()}:${src}:${b.ev}`);
      return json({ ok: true }, 200, h);
    }

    if (req.method === "POST" && url.pathname === "/lead") {
      let b;
      try { b = await req.json(); } catch (e) { return json({ ok: false }, 400, h); }
      const lead = {
        name: clip(b.name), company: clip(b.company), role: clip(b.role, 60), sites: clip(b.sites, 20),
        phone: clip(b.phone, 40), email: clip(b.email, 120), market: clip(b.market, 20),
        utm: b.utm && typeof b.utm === "object" ? Object.fromEntries(Object.entries(b.utm).map(([k, v]) => [clip(k, 30), clip(v, 120)])) : {},
        ts: new Date().toISOString(),
      };
      if (!lead.name || !lead.company || !lead.phone || !lead.email) return json({ ok: false }, 400, h);
      await env.LEADS.put(`lead:${lead.market}:${lead.ts}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(lead));

      if (env.TG_TOKEN && env.TG_CHAT) {
        const text = [
          `🏗 Новая заявка — ${lead.market.toUpperCase()}`,
          `${lead.name} · ${lead.role}`,
          `Компания: ${lead.company} · объектов: ${lead.sites}`,
          `Тел: ${lead.phone}`, `Почта: ${lead.email}`,
          `Источник: ${lead.utm.utm_source || "direct"} ${lead.utm.utm_campaign || ""}`,
        ].join("\n");
        try {
          await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: env.TG_CHAT, text }),
          });
        } catch (e) { /* заявка уже сохранена — уведомление не критично */ }
      }
      return json({ ok: true }, 200, h);
    }

    // Найти ID чатов, куда добавлен бот (для настройки TG_CHAT)
    if (req.method === "GET" && url.pathname === "/tg-chats") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ ok: false }, 403, h);
      if (!env.TG_TOKEN) return json({ ok: false, error: "TG_TOKEN не задан" }, 400, h);
      const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/getUpdates`);
      const d = await r.json();
      if (!d.ok) return json({ ok: false, error: "Telegram: " + (d.description || "ошибка") }, 400, h);
      const chats = {};
      for (const u of d.result || []) {
        const c = (u.message || u.my_chat_member || u.channel_post || u.edited_message || {}).chat;
        if (c) chats[c.id] = { id: c.id, title: c.title || c.first_name || "", type: c.type };
      }
      return json({ ok: true, chats: Object.values(chats), hint: "Пусто — напишите сообщение в группе и обновите страницу" }, 200, h);
    }

    if (req.method === "GET" && url.pathname === "/stats") {
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY) return json({ ok: false }, 403, h);
      const funnel = {};
      let cursor;
      do {
        const page = await env.LEADS.list({ prefix: "ev:", cursor });
        for (const k of page.keys) {
          const [, market, , src, ev] = k.name.split(":");
          const v = parseInt((await env.LEADS.get(k.name)) || "0", 10);
          funnel[market] ??= {}; funnel[market][src] ??= {};
          funnel[market][src][ev] = (funnel[market][src][ev] || 0) + v;
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      const leads = [];
      cursor = undefined;
      do {
        const page = await env.LEADS.list({ prefix: "lead:", cursor });
        for (const k of page.keys) leads.push(JSON.parse(await env.LEADS.get(k.name)));
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
      return json({ funnel, leads_total: leads.length, leads }, 200, h);
    }

    return json({ ok: false, error: "not found" }, 404, h);
  },
};
