// Compact x402 payment-readiness probe — the paid resource this server sells.
// Same verdict taxonomy as the SolTools audit: payable / payable-conditional /
// documented / free / broken / unreachable, plus defect codes.
const TIMEOUT = 8000;

async function fetchOnce(url, method = "GET") {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method, redirect: "manual", signal: ctl.signal });
    const text = await r.text();
    return { status: r.status, headers: r.headers, body: text.slice(0, 65536) };
  } finally {
    clearTimeout(t);
  }
}

function parseRequirements(body, headers) {
  // accept JSON body or PAYMENT-REQUIRED header
  let obj = null;
  try { obj = JSON.parse(body); } catch {}
  const hdr = headers.get("payment-required") || headers.get("x-payment-required");
  if (!obj && hdr) { try { obj = JSON.parse(hdr); } catch {} }
  if (!obj) return { found: false, defects: ["descriptor_missing"] };
  const acc = obj.accepts?.[0] || obj.requirements?.[0] || obj;
  const defects = [];
  if (!acc.network) defects.push("no_network");
  else if (!/^eip155:\d+$|^solana:|^base$|^base-sepolia$/.test(String(acc.network))) defects.push("network_not_caip2");
  else if (String(acc.network) === "base") defects.push("network_not_caip2");
  if (!acc.payTo && !acc.payToAddress && !acc.payGate) defects.push("no_payto");
  if (!acc.asset && !acc.assetAddress) defects.push("no_asset");
  const amt = acc.maxAmountRequired ?? acc.amount ?? acc.price;
  if (amt == null || !/^\d+$/.test(String(amt))) defects.push("unpriced");
  return { found: true, requirements: acc, defects };
}

export async function readinessProbe(target) {
  let url = target;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const out = { target: url, probedAt: new Date().toISOString(), probes: [] };
  let r;
  try { r = await fetchOnce(url, "GET"); }
  catch (e) { return { ...out, verdict: "unreachable", defects: ["unreachable"], error: String(e).slice(0, 120) }; }
  out.probes.push({ method: "GET", status: r.status });

  if (r.status === 402) {
    const req = parseRequirements(r.body, r.headers);
    if (!req.found) return { ...out, verdict: "broken", defects: ["malformed_402"] };
    if (req.defects.length) return { ...out, verdict: "broken", defects: req.defects, requirements: req.requirements };
    return { ...out, verdict: "payable", defects: [], requirements: req.requirements };
  }
  if ([400, 422].includes(r.status) && /field|param|required|invalid|missing/i.test(r.body)) {
    return { ...out, verdict: "payable-conditional", defects: ["input_gated"], note: "validation error before payment challenge" };
  }
  if (r.status === 405) {
    const allow = r.headers.get("allow") || "";
    const next = ["POST", "PUT", "PATCH", "DELETE"].find((m) => allow.toUpperCase().includes(m));
    if (!next) return { ...out, verdict: "broken", defects: ["verb_mismatch", "allow_missing"] };
    try {
      const r2 = await fetchOnce(url, next);
      out.probes.push({ method: next, status: r2.status });
      if (r2.status === 402) {
        const req = parseRequirements(r2.body, r2.headers);
        return req.found && !req.defects.length
          ? { ...out, verdict: "payable", defects: [], requirements: req.requirements }
          : { ...out, verdict: "broken", defects: req.defects.length ? req.defects : ["malformed_402"] };
      }
      return { ...out, verdict: "broken", defects: ["verb_mismatch"] };
    } catch (e) { return { ...out, verdict: "unreachable", defects: ["unreachable"] }; }
  }
  if (r.status >= 200 && r.status < 300) {
    const well = url.replace(/\/$/, "") + "/.well-known/x402";
    try {
      const rd = await fetchOnce(well, "GET");
      out.probes.push({ method: "GET", status: rd.status, url: well });
      if (rd.status === 200 && rd.body.includes("{")) return { ...out, verdict: "documented", defects: ["descriptor_doc"], note: "x402 descriptor found" };
    } catch {}
    return { ...out, verdict: "free", defects: ["no_paywall"] };
  }
  return { ...out, verdict: "broken", defects: ["unexpected_status"], note: `HTTP ${r.status}` };
}
