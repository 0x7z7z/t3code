import * as NodeNet from "node:net";

export async function availablePort(preferred) {
  const port = Number(preferred);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Choose a port between 1024 and 65535.");
  for (let offset = 0; offset < 100; offset++) {
    const candidate = 1024 + ((port - 1024 + offset) % (65536 - 1024));
    const free = await new Promise((resolve, reject) => {
      const server = NodeNet.createServer();
      server.once("error", (error) => {
        if (["EADDRINUSE", "EACCES"].includes(error.code)) resolve(false);
        else reject(error);
      });
      server.listen({ host: "127.0.0.1", port: candidate, exclusive: true }, () =>
        server.close(() => resolve(true)),
      );
    });
    if (free) return String(candidate);
  }
  throw new Error("Axis could not find a free local port. Close unused local servers and retry.");
}
