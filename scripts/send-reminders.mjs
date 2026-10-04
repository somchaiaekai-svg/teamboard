// Daily reminder: emails each assignee the tasks and phases that are due
// within `remindDays` (settings/main, default 3) or already overdue.
// Run by .github/workflows/reminders.yml. Needs env vars listed in README.md.
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const env = (k, d) => process.env[k] || d;
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing env: " + missing.join(", "));
  process.exit(1);
}
const DRY_RUN = env("DRY_RUN", "") === "1";
const APP_URL = env("APP_URL", "");
const TZ = "Asia/Bangkok";

const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

async function all(table) {
  const { data, error } = await sb.from(table).select("id,data");
  if (error) throw error;
  return Object.fromEntries(data.map((r) => [r.id, r.data]));
}

// Today's date in Bangkok as YYYY-MM-DD
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const dayDiff = (iso) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(todayIso + "T00:00:00Z")) / 864e5);
const thDate = (iso) => new Date(iso + "T00:00:00Z").toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const when = (n) => (n < 0 ? `เกินกำหนด ${-n} วัน` : n === 0 ? "ครบกำหนดวันนี้" : `อีก ${n} วัน`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const [members, tasks, reports, settings] = await Promise.all(["members", "tasks", "reports", "settings"].map(all));
const remindDays = Number(settings.main?.remindDays) || 3;

function latestPct(taskId, phaseId) {
  const r = Object.values(reports)
    .filter((r) => r.taskId === taskId && (r.phaseId || "") === (phaseId || ""))
    .sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0))[0];
  return r ? Math.max(0, Math.min(100, Math.round(Number(r.percent) || 0))) : 0;
}

const byMember = {};
for (const [id, t] of Object.entries(tasks)) {
  if (t.status === "done") continue;
  const m = members[t.assignee];
  if (!m?.email) continue;
  const items = [];
  if (t.due && dayDiff(t.due) <= remindDays) items.push({ label: t.title, due: t.due, n: dayDiff(t.due) });
  for (const p of Array.isArray(t.phases) ? t.phases : []) {
    if (p.due && !p.done && latestPct(id, p.id) < 100 && dayDiff(p.due) <= remindDays)
      items.push({ label: `${t.title} › ${p.name}`, due: p.due, n: dayDiff(p.due) });
  }
  if (items.length) (byMember[t.assignee] ||= { m, items: [] }).items.push(...items);
}

const transport = nodemailer.createTransport({
  host: env("SMTP_HOST"),
  port: Number(env("SMTP_PORT", "465")),
  secure: Number(env("SMTP_PORT", "465")) === 465,
  auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") },
});
const from = env("MAIL_FROM", env("SMTP_USER"));

let sent = 0;
for (const { m, items } of Object.values(byMember)) {
  items.sort((a, b) => a.n - b.n);
  const lines = items.map((it) => `• ${it.label} — กำหนดแล้วเสร็จ ${thDate(it.due)} (${when(it.n)})`);
  const text = `เรียน คุณ${m.name}\n\nงานที่ใกล้ถึงกำหนดแล้วเสร็จหรือเกินกำหนด:\n${lines.join("\n")}\n\nกรุณาอัปเดตรายงานความก้าวหน้าในระบบ${APP_URL ? "\n" + APP_URL : ""}\n`;
  const html =
    `<p>เรียน คุณ${esc(m.name)}</p><p>งานที่ใกล้ถึงกำหนดแล้วเสร็จหรือเกินกำหนด:</p><ul>` +
    items.map((it) => `<li><b>${esc(it.label)}</b> — กำหนดแล้วเสร็จ ${esc(thDate(it.due))} <span style="color:${it.n < 0 ? "#b83a2c" : "#a86d12"}">(${esc(when(it.n))})</span></li>`).join("") +
    `</ul><p>กรุณาอัปเดตรายงานความก้าวหน้าในระบบ${APP_URL ? ` <a href="${esc(APP_URL)}">${esc(APP_URL)}</a>` : ""}</p>`;
  const subject = `แจ้งเตือน: งานใกล้ถึงกำหนด ${items.length} รายการ`;
  if (DRY_RUN) {
    console.log(`[dry run] to ${m.email}: ${subject}\n${text}`);
  } else {
    await transport.sendMail({ from, to: m.email, subject, text, html });
    console.log(`sent to ${m.email} (${items.length} items)`);
  }
  sent++;
}
console.log(`done: ${sent} email(s), remindDays=${remindDays}, today=${todayIso}`);
