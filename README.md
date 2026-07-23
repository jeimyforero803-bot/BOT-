# zelva-agent

Agente local de social listening — scraper sin APIs oficiales, usando Chrome/Playwright autenticado.

- **Qué hace**: escanea redes sociales (Twitter, Instagram, YouTube, TikTok, Facebook, LinkedIn, Threads, Reddit) y noticias, y envía notificaciones por WhatsApp (CallMeBot).
- **Stack**: Node.js + TypeScript (`tsx`), Playwright.
- **Puerto**: 3002
- **Corre como servicio permanente en PM2** bajo el nombre `zelva-agent` (`pm2 start server.ts --name zelva-agent --interpreter node --node-args="--import tsx"`). Ver estado con `pm2 list`, logs con `pm2 logs zelva-agent`.

## Cómo correrlo manualmente (sin PM2)
```
npm install
npx tsx server.ts
```

## Notas
- `auth/`, `sessions/`, `sessions.json` — sesiones guardadas de login en redes sociales, no borrar.
- El proceso venía con miles de reinicios acumulados en PM2 antes de esta reorganización — vale la pena revisar `agent-startup.log` si sigue reiniciándose seguido.
