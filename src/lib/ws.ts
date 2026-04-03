import { Server as SocketServer } from "socket.io";
import type { Server as HttpServer } from "node:http";

const NEXUS_BROADCAST_CHANNEL = "nexus:event";

let io: SocketServer | null = null;

export function initNexusWs(httpServer: HttpServer): void {
  io = new SocketServer(httpServer, {
    cors: { origin: "*" },
    transports: ["websocket", "polling"],
    path: "/api/nexus/ws",
  });

  io.on("connection", (socket) => {
    const tenantId = socket.handshake.query["tenant_id"];
    if (typeof tenantId === "string" && tenantId) {
      void socket.join(`tenant:${tenantId}`);
    }
  });
}

export function broadcastEvent(tenantId: string, event: unknown): void {
  if (!io) return;
  io.to(`tenant:${tenantId}`).emit(NEXUS_BROADCAST_CHANNEL, event);
}
