"use strict";

// Currency code -> [symbol, name, default rate per 1 USD (approximate, editable)]
const CURRENCIES = {
  INR: ["₹", "Indian Rupee", 88.5],
  USD: ["$", "US Dollar", 1],
  EUR: ["€", "Euro", 0.86],
  GBP: ["£", "British Pound", 0.76],
  JPY: ["¥", "Japanese Yen", 154],
  AUD: ["A$", "Australian Dollar", 1.53],
  CAD: ["C$", "Canadian Dollar", 1.4],
  AED: ["AED ", "UAE Dirham", 3.6725],
  SGD: ["S$", "Singapore Dollar", 1.3],
  CNY: ["CN¥", "Chinese Yuan", 7.12],
};

// Groups of [key, label, default (INR for money fields), isMoney]
const FIELDS = [
  ["Material", [
    ["filament_price", "Filament price (per kg)", 1200, true],
    ["weight_g", "Model weight (grams)", 50, false],
  ]],
  ["Printing", [
    ["print_hours", "Print time (hours)", 3, false],
    ["power_w", "Printer power (watts)", 150, false],
    ["elec_rate", "Electricity rate (per kWh)", 8, true],
    ["printer_cost", "Printer purchase cost", 25000, true],
    ["printer_life_h", "Printer lifetime (hours)", 5000, false],
  ]],
  ["Labour & extras", [
    ["labour_hours", "Labour time (hours)", 0.5, false],
    ["labour_rate", "Labour rate (per hour)", 200, true],
    ["extra_cost", "Design / post-processing / packaging", 0, true],
  ]],
  ["Pricing", [
    ["failure_pct", "Failure allowance (%)", 10, false],
    ["profit_pct", "Profit margin (%)", 30, false],
    ["tax_pct", "GST / Tax (%)", 18, false],
    ["quantity", "Quantity", 1, false],
  ]],
];
const ALL_FIELDS = FIELDS.flatMap(([, group]) => group);
const STORAGE_KEY = "3d-print-price-calculator";

const state = {
  currency: "INR",
  convertTo: "USD",
  rates: Object.fromEntries(Object.entries(CURRENCIES).map(([c, v]) => [c, v[2]])),
};
let lastQuote = "";

const $ = (id) => document.getElementById(id);

// ---------- formatting ----------
function fmt(amount, code) {
  const sym = CURRENCIES[code][0];
  const digits = code === "JPY" ? 0 : 2;
  const locale = code === "INR" ? "en-IN" : "en-US"; // en-IN gives 12,34,567.89 grouping
  return sym + amount.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function trimNum(n) {
  return String(Math.round(n * 100) / 100);
}

// ---------- build UI ----------
function buildInputs() {
  const form = $("inputs");
  for (const [title, group] of FIELDS) {
    const fs = document.createElement("fieldset");
    fs.className = "card";
    fs.innerHTML = `<legend>${title}</legend><div class="fields"></div>`;
    const grid = fs.querySelector(".fields");
    for (const [key, label, def] of group) {
      const wrap = document.createElement("div");
      wrap.className = "field";
      wrap.innerHTML =
        `<label for="${key}" data-base="${label}">${label}</label>` +
        `<input id="${key}" type="number" inputmode="decimal" min="0" step="any" value="${def}">`;
      grid.appendChild(wrap);
    }
    form.appendChild(fs);
  }
  form.addEventListener("input", () => { calculate(); save(); });
}

function buildSelects() {
  const cur = $("currency");
  const conv = $("convertTo");
  for (const [code, [, name]] of Object.entries(CURRENCIES)) {
    cur.add(new Option(`${code} – ${name}`, code));
    conv.add(new Option(code, code));
  }
  cur.value = state.currency;
  conv.value = state.convertTo;
  cur.addEventListener("change", () => changeCurrency(cur.value));
  conv.addEventListener("change", () => { state.convertTo = conv.value; calculate(); save(); });
}

function refreshMoneyLabels() {
  const sym = CURRENCIES[state.currency][0].trim();
  for (const [key, label, , money] of ALL_FIELDS) {
    if (money) document.querySelector(`label[for="${key}"]`).textContent = `${label} [${sym}]`;
  }
}

// ---------- logic ----------
function readValues() {
  const v = {};
  let ok = true;
  for (const [key] of ALL_FIELDS) {
    const el = $(key);
    const raw = el.value.trim();
    const n = raw === "" ? 0 : Number(raw);
    const bad = !Number.isFinite(n) || n < 0;
    el.classList.toggle("invalid", bad);
    if (bad) ok = false;
    v[key] = n;
  }
  return ok ? v : null;
}

function calculate() {
  const v = readValues();
  $("error").hidden = !!v;
  if (!v) return;
  const c = state.currency;

  const material = (v.filament_price / 1000) * v.weight_g;
  const electricity = (v.power_w / 1000) * v.print_hours * v.elec_rate;
  const depreciation = v.printer_life_h > 0 ? (v.printer_cost / v.printer_life_h) * v.print_hours : 0;
  const labour = v.labour_hours * v.labour_rate;
  const extra = v.extra_cost;
  const failure = ((material + electricity + depreciation) * v.failure_pct) / 100;
  const base = material + electricity + depreciation + labour + extra + failure;
  const profit = (base * v.profit_pct) / 100;
  const pretax = base + profit;
  const tax = (pretax * v.tax_pct) / 100;
  const unit = pretax + tax;
  const qty = Math.max(1, Math.round(v.quantity));
  const total = unit * qty;

  const rows = [
    ["Material cost", material],
    ["Electricity cost", electricity],
    ["Printer wear / depreciation", depreciation],
    ["Labour cost", labour],
    ["Design / post-processing", extra],
    [`Failure allowance (${v.failure_pct}%)`, failure],
    null,
    ["Production cost", base, true],
    [`Profit (${v.profit_pct}%)`, profit],
    ["Price before tax", pretax],
    [`GST / Tax (${v.tax_pct}%)`, tax],
    null,
    ["Price per piece", unit, true],
  ];

  $("breakdown").innerHTML = rows
    .map((r) => {
      if (!r) return `<div class="sep"></div>`;
      const cls = r[2] ? ' class="strong"' : "";
      return `<dt${cls}>${r[0]}</dt><dd${cls}>${fmt(r[1], c)}</dd>`;
    })
    .join("");

  $("totalLabel").textContent = `Total (${qty} pc${qty > 1 ? "s" : ""})`;
  $("total").textContent = fmt(total, c);

  const tgt = state.convertTo;
  const converted = (total / state.rates[c]) * state.rates[tgt];
  $("converted").textContent = fmt(converted, tgt);

  const pad = (label, val) => label.padEnd(30) + val.padStart(14);
  lastQuote = [
    "3D Print Price Calculator",
    "=".repeat(44),
    `Model weight: ${v.weight_g} g   Print time: ${v.print_hours} h`,
    "",
    ...rows.filter(Boolean).map((r) => pad(r[0], fmt(r[1], c))),
    "-".repeat(44),
    pad(`TOTAL x ${qty}`, fmt(total, c)),
    pad(`(approx. in ${tgt})`, fmt(converted, tgt)),
  ].join("\n");
}

function changeCurrency(next) {
  const prev = state.currency;
  if (next === prev) return;
  const factor = state.rates[next] / state.rates[prev];
  for (const [key, , , money] of ALL_FIELDS) {
    if (!money) continue;
    const el = $(key);
    const n = Number(el.value);
    if (el.value.trim() !== "" && Number.isFinite(n)) el.value = trimNum(n * factor);
  }
  state.currency = next;
  refreshMoneyLabels();
  calculate();
  save();
}

// ---------- persistence (per browser) ----------
function save() {
  try {
    const inputs = Object.fromEntries(ALL_FIELDS.map(([k]) => [k, $(k).value]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, inputs }));
  } catch (_) { /* storage unavailable - ignore */ }
}

function load() {
  let data;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (_) { data = null; }
  if (!data) return;
  if (CURRENCIES[data.currency]) state.currency = data.currency;
  if (CURRENCIES[data.convertTo]) state.convertTo = data.convertTo;
  for (const [c, r] of Object.entries(data.rates || {})) {
    if (CURRENCIES[c] && typeof r === "number" && r > 0) state.rates[c] = r;
  }
  for (const [k, val] of Object.entries(data.inputs || {})) {
    if ($(k)) $(k).value = val;
  }
}

function reset() {
  if (!confirm("Reset all inputs to default values (in INR)?")) return;
  state.currency = "INR";
  $("currency").value = "INR";
  for (const [key, , def] of ALL_FIELDS) $(key).value = def;
  refreshMoneyLabels();
  calculate();
  save();
}

// ---------- exchange rates dialog ----------
function openRates() {
  const list = $("ratesList");
  list.innerHTML = Object.entries(CURRENCIES)
    .map(([code, [, name]]) =>
      `<label class="rate-row"><span>${code} – ${name}</span>` +
      `<input type="number" step="any" min="0" data-code="${code}" value="${state.rates[code]}"` +
      `${code === "USD" ? " disabled" : ""}></label>`)
    .join("");
  $("ratesDialog").showModal();
}

function saveRates() {
  const next = {};
  for (const el of $("ratesList").querySelectorAll("input")) {
    const n = Number(el.value);
    if (!Number.isFinite(n) || n <= 0) {
      el.classList.add("invalid");
      el.focus();
      return;
    }
    next[el.dataset.code] = n;
  }
  next.USD = 1;
  state.rates = next;
  $("ratesDialog").close();
  calculate();
  save();
}

// ---------- quote actions ----------
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2500);
}

async function copyQuote() {
  try {
    await navigator.clipboard.writeText(lastQuote);
    toast("Quote copied to clipboard.");
  } catch (_) {
    toast("Copy failed — your browser blocked clipboard access.");
  }
}

function saveQuote() {
  const blob = new Blob([lastQuote], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "3d_print_quote.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- init ----------
buildInputs();
load();
buildSelects();
refreshMoneyLabels();
calculate();

$("resetBtn").addEventListener("click", reset);
$("ratesBtn").addEventListener("click", openRates);
$("ratesSave").addEventListener("click", saveRates);
$("ratesDefault").addEventListener("click", () => {
  for (const el of $("ratesList").querySelectorAll("input")) el.value = CURRENCIES[el.dataset.code][2];
});
$("copyBtn").addEventListener("click", copyQuote);
$("saveBtn").addEventListener("click", saveQuote);
