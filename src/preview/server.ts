import { watch, type FSWatcher } from "node:fs";

type BunServer = ReturnType<typeof Bun.serve>;

export interface WatchServerOptions {
  port: number;
  /** 当前 preview.html 内容（可变引用，重新渲染后替换） */
  getHtml: () => string;
  /** 文件变化回调，返回新的 html */
  onFileChange?: () => Promise<void>;
  /** 需要监听的文件路径（md / theme.zip / 图片） */
  watchFiles?: string[];
}

export interface WatchServer {
  server: BunServer;
  url: string;
  stop: () => void;
}

/**
 * 启动本地预览服务：静态输出 + GET /__events (SSE) + 文件监听热刷新。
 */
export function startPreviewServer(opts: WatchServerOptions): WatchServer {
  const sseClients = new Set<{ req: Request; controller: ReadableStreamDefaultController }>();

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/__events") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add({ req, controller });
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel() {
            for (const c of sseClients) if (c.req === req) sseClients.delete(c);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response(opts.getHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    },
  });

  const url = `http://127.0.0.1:${server.port}`;

  // 文件监听：node:fs watch
  const watchers: FSWatcher[] = [];
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const trigger = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (opts.onFileChange) {
        try {
          await opts.onFileChange();
        } catch (err) {
          console.error("[watch] 重新渲染失败：", err);
        }
      }
      for (const client of sseClients) {
        try {
          client.controller.enqueue(new TextEncoder().encode("event: reload\ndata: {}\n\n"));
        } catch {
          sseClients.delete(client);
        }
      }
    }, 120);
  };

  for (const file of opts.watchFiles ?? []) {
    try {
      const w = watch(file, { persistent: true }, trigger);
      watchers.push(w);
    } catch {
      // 文件不存在等，忽略
    }
  }

  return {
    server,
    url,
    stop: () => {
      if (debounce) clearTimeout(debounce);
      for (const w of watchers) w.close();
      server.stop();
    },
  };
}
