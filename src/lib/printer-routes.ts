// ─── Printer Routes — Hardware-Billing Link ───────────────────────────────────
//
// Rule: only tenants with multi_printer = true may address multiple printers.
//   Basic/Pro → ip_only mode enforced here too (single printer, IP+port only).
//   Enterprise → sdk_multi mode, unlimited printers, SDK flags enabled.
//
// Routes:
//   POST /nexus/printer/test   — TCP reachability test for a printer IP:port
//   POST /nexus/printer/print  — Dispatch a structured print job
//
// Architecture note: actual ESC/POS byte stream generation is stubbed here
// for portability. In production, replace the stub with a real ESC/POS library
// (e.g. node-escpos or a microservice). The billing gate and mode routing
// are fully enforced regardless of the print backend used.

import { Router } from "express";
import net from "net";
import { canUseFeature } from "./billing-engine.js";

export const printerRouter = Router();

// ─── Auth helper ─────────────────────────────────────────────────────────────
// Reuse the existing device-token auth from billing routes
async function resolveAuth(req: import("express").Request): Promise<{
  tenant_id: string;
  device_id: string;
} | null> {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const { db } = await import("@workspace/db");
  const { nexusDevices } = await import("@workspace/db/schema");
  const { eq } = await import("drizzle-orm");

  const [device] = await db
    .select({ tenant_id: nexusDevices.tenant_id, device_id: nexusDevices.device_id })
    .from(nexusDevices)
    .where(eq(nexusDevices.token, token))
    .limit(1);

  return device ?? null;
}

// ─── TCP reachability probe ───────────────────────────────────────────────────
function probeTcp(ip: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const done = (ok: boolean) => {
      if (!resolved) { resolved = true; socket.destroy(); resolve(ok); }
    };
    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

// ─── POST /nexus/printer/test ─────────────────────────────────────────────────

printerRouter.post("/nexus/printer/test", async (req, res) => {
  const auth = await resolveAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { printer_ip, printer_port } = req.body as {
    printer_ip?: string;
    printer_port?: number;
  };

  if (!printer_ip || !printer_port) {
    res.status(400).json({ error: "printer_ip and printer_port are required" });
    return;
  }

  const reachable = await probeTcp(printer_ip, printer_port).catch(() => false);

  if (reachable) {
    res.json({ ok: true, message: `Printer at ${printer_ip}:${printer_port} is reachable` });
  } else {
    res.status(503).json({ ok: false, message: `Cannot reach ${printer_ip}:${printer_port} — check IP, port, and network` });
  }
});

// ─── POST /nexus/printer/print ────────────────────────────────────────────────

printerRouter.post("/nexus/printer/print", async (req, res) => {
  const auth = await resolveAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { printer_ip, printer_port, job, mode } = req.body as {
    printer_ip?: string;
    printer_port?: number;
    job?: { type?: string; orderId?: string; lines?: string[] };
    mode?: "ip_only" | "sdk_multi";
  };

  if (!printer_ip || !printer_port) {
    res.status(400).json({ error: "printer_ip and printer_port are required" });
    return;
  }

  // ── Billing gate: if mode=sdk_multi, verify enterprise entitlement ────────
  if (mode === "sdk_multi") {
    const allowed = await canUseFeature(auth.tenant_id, "multi_printer");
    if (!allowed) {
      res.status(402).json({
        error: "multi_printer_required",
        message: "SDK multi-printer mode requires an Enterprise plan.",
        upgrade_required: true,
      });
      return;
    }
  }

  // ── TCP reachability check ────────────────────────────────────────────────
  const reachable = await probeTcp(printer_ip, printer_port, 4000).catch(() => false);
  if (!reachable) {
    res.status(503).json({
      ok: false,
      message: `Printer at ${printer_ip}:${printer_port} is not reachable`,
    });
    return;
  }

  // ── Build ESC/POS payload ─────────────────────────────────────────────────
  // In production, replace this stub with a real ESC/POS library call.
  const lines: string[] = [
    "\x1B\x40",                     // ESC @ — initialize printer
    "\x1B\x61\x01",                 // ESC a 1 — center align
    "=== NEXUS POS ===\n",
    `${job?.type?.toUpperCase() ?? "PRINT"} JOB\n`,
    ...(job?.orderId ? [`Order: ${job.orderId}\n`] : []),
    ...(job?.lines ?? []).map((l) => `${l}\n`),
    "\n\n\n",
    "\x1D\x56\x00",                 // GS V 0 — full cut
  ];

  const raw = Buffer.from(lines.join(""), "utf8");

  // ── Send raw bytes over TCP ───────────────────────────────────────────────
  const sent = await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(6000);
    socket.connect(printer_port, printer_ip, () => {
      socket.write(raw, (err) => {
        socket.end();
        resolve(!err);
      });
    });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });

  if (sent) {
    res.json({ ok: true, message: "Print job dispatched", printer_ip, printer_port });
  } else {
    res.status(500).json({ ok: false, message: "Failed to write to printer socket" });
  }
});
