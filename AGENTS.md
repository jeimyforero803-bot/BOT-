# Flows Scan (zelva-agent) — guía de arranque para agentes de IA

> Lee este archivo completo antes de tocar nada. Está escrito para que un agente
> nuevo (Claude Code, Codex, cualquiera) sepa qué es esto, cómo se conecta con
> ZALVAJE, cómo correrlo y **cómo replicarlo** sin repetir los errores que ya
> costaron tiempo.
>
> Última verificación contra el código: **2026-11-03**.
> Proyecto hermano: `../zalvaje` — ver su `AGENTS.md`.

---

## 0. Lee esto antes que nada

**Hay ~33 cambios sin commitear, incluyendo 9 archivos nuevos que nunca
entraron a git.** El último commit es del **2026-07-28** (`d64363f`); desde
entonces se construyeron, sin guardar:

```
src/influencerProfileAI.ts      src/semanticRelevance.ts
src/sources/linkedinProfile.ts  src/twitterHistory.ts
audit-x-history.mjs             check-service.mjs
diagnose-sessions.mjs           renew-facebook.mjs
verify-*.mjs / verify-*.ts      (varios)
```
más modificaciones en `server.ts` y en los 14 scrapers.

**Esto es trabajo de meses viviendo solo en el disco de una máquina.** Antes de
cualquier refactor, commitea. Si vas a replicar el proyecto, parte del disco, no
de `git clone`: el repo remoto está tres meses atrasado.

**La clave `AGENT_KEY` quedó en git con un valor real** dentro de
`.env.example` (`zelva-agent-secret-2025`). Está en el historial del repo, así
que borrarla del archivo no la borra de git. **Hay que rotarla**: cambiar el
valor en el `.env` local y en la variable `AGENT_KEY` del backend de Render.
Mientras no se rote, cualquiera con acceso al repo puede depositar scans falsos
en ZALVAJE.

---

## 1. Qué es

Agente **local** de social listening. Scrapea redes sociales y noticias con
Chrome real vía Playwright, usando **sesiones autenticadas** en vez de APIs
oficiales. Corre en la máquina de Diego, no en la nube.

Nombre del módulo en ZALVAJE: **Flows Scan**. Antes se llamó "Social Agent" y
"ZELVA" — si ves esos nombres en código viejo, es lo mismo.

**Por qué es local y no un servicio:** las APIs oficiales de estas plataformas o
no dan este dato, o lo cobran, o lo limitan. El agente entra como entraría una
persona, con cookies de sesión guardadas en `auth/`. Eso tiene un precio: no se
puede desplegar en la nube sin resolver el login, y las sesiones caducan y hay
que renovarlas a mano.

| | |
|---|---|
| Repo | `jeimyforero803-bot/BOT-` (17 commits, atrasado — ver §0) |
| Stack | Node + TypeScript (`tsx`, sin build) + Playwright |
| Puerto | **3002** |
| Proceso | PM2, nombre `zelva-agent` |
| Túnel | Cloudflare Quick Tunnel (`*.trycloudflare.com`) |

---

## 2. Cómo se conecta con ZALVAJE

El problema de fondo: **el agente vive detrás del router de una casa** y ZALVAJE
vive en Render. Render no puede llamar a una IP doméstica. La solución es que el
agente se exponga por un túnel y le diga a ZALVAJE dónde está.

```
         ZALVAJE (Render)                    Flows Scan (local, :3002)
                │                                      │
                │  ①  POST /api/agent/register-url  ◄──┤  al arrancar
                │     { url: https://xxx.trycloudflare.com }
                │                                      │
                │  ②  GET  /api/agent/current-url      │
                │     → el navegador lee la URL del túnel
                │                                      │
    el navegador ─────── POST <tunel>/scan ───────────►│  ③ arranca el scan
                │                                      │
                │  ④  POST /api/agent/scan-result   ◄──┤  resultados
                │  ⑤  POST /api/agent/ads-deposit   ◄──┤  creatividades
                ▼                                      │
          Supabase                                     └─► WhatsApp (CallMeBot)
      agent_scans · ad_creatives
```

### El túnel cambia de URL en cada reinicio

Quick Tunnel da una URL aleatoria. Por eso **no hay hostname fijo**: el agente
lanza `cloudflared`, lee la URL del output con una regex
(`server.ts:1470`) y la re-registra en cada arranque. ZALVAJE la guarda en caché
(`agent-meta` / `agent-url`) y el frontend la consulta con `GET /api/agent/current-url`.

Si la interfaz dice que el agente no responde, lo primero a revisar es si el
túnel está vivo y si la URL registrada es la actual.

**Auto-sanación** (`server.ts:1515-1536`): el fallo real observado en producción
es que `cloudflared` sigue corriendo pero su túnel ya no enruta. Un auto-chequeo
golpea la URL registrada y, si no responde, **mata `cloudflared`** — el handler
`exit` que ya existía lo relanza a los 5 s y el arranque re-registra la URL
nueva. No se arregla el túnel: se reinicia.

### La credencial es `x-agent-key`, no `X-Zelva-Key`

`/api/agent` está en `PUBLIC_PATHS` del backend de ZALVAJE, así que **está
exento del guard `X-Zelva-Key`** y valida con su propio header `x-agent-key`
contra `process.env.AGENT_KEY`. Los dos valores tienen que coincidir: el `.env`
del agente y la variable de Render.

> **La trampa que ya costó un día.** Las creatividades se posteaban a
> `/api/atl/creatives`, que **sí** exige `X-Zelva-Key` — credencial que el agente
> no tiene. Recibía **401 en silencio** y la interfaz mostraba "18 guardadas"
> porque contaba el largo del array enviado, no lo insertado. La tabla quedaba
> vacía. Por eso existe `/api/agent/ads-deposit`: vive bajo `/api/agent` para
> entrar por la puerta que el agente puede abrir, y **devuelve el conteo del
> `select()` de Supabase, no el optimista**. Está comentado en
> `zalvaje/backend/src/routes/agent.ts:134-139`.
>
> Lección para replicar: **nunca reportes "guardado" desde el largo de lo que
> mandaste.** Reporta lo que la base confirmó.

### Los 9 endpoints del lado ZALVAJE

En `zalvaje/backend/src/routes/agent.ts`:

| Dirección | Endpoint | Para qué |
|---|---|---|
| agente → ZALVAJE | `POST /api/agent/scan-result` | deposita un scan terminado |
| agente → ZALVAJE | `POST /api/agent/ads-deposit` | deposita creatividades |
| agente → ZALVAJE | `POST /api/agent/register-url` | anuncia la URL del túnel |
| navegador | `GET /api/agent/current-url` | dónde está el agente ahora |
| navegador | `POST /api/agent/trigger-scan` | pide un scan |
| navegador | `GET /api/agent/results` | último resultado |
| navegador | `GET /api/agent/accumulated` | acumulado por marca |
| navegador | `GET /api/agent/latest-alerts` | alertas recientes |
| navegador | `GET /api/agent/history` | histórico |

### La interfaz, del lado de ZALVAJE

- `views/SocialAgent.tsx` — **137 KB**, la pantalla principal del módulo.
- `src/components/features/social-listening/AgentResultsPanel.tsx` — 19 KB.
- También consumen al agente: `InfluencerCalculator.tsx` (7 refs),
  `StrategyLab.tsx` (4), `CompetenciaInteligente.tsx`, `ETBDashboard.tsx`,
  `CCBDashboard.tsx`.

El frontend **sondea** `/results` cada 3 s con 30 s de timeout. El agente
devuelve el payload completo —capturas incluidas— en cada sondeo; `/status`
devuelve solo `completedPlatforms[]`. Timeout del scan: **2 h** a los dos lados.

> Nota: un `AgentDashboard.tsx` que guardaba una URL de **ngrok** en
> `localStorage` pertenece a **MUSE**, otro proyecto. Acá el túnel es Cloudflare
> y la URL se registra en el backend, no en el navegador. No confundas los dos.

---

## 3. Correr

```bash
npm install
npx playwright install chromium     # npm run install-browsers
npm start                           # tsx server.ts → :3002
```

En la máquina de Diego **corre como servicio de PM2**, no a mano:

```bash
pm2 start server.ts --name zelva-agent --interpreter node --node-args="--import tsx"
pm2 list                 # estado
pm2 logs zelva-agent     # logs
```

Otros scripts: `npm run scan` (un scan suelto por CLI, `scan.ts`) y
`npm run setup` (login interactivo para rellenar `auth/`, `src/setup-auth.ts`).

### Variables de entorno

Las 9 que el código lee. **El `.env.example` viejo solo documentaba 3** — por eso
replicar esto era adivinar.

| Variable | Default | Para qué |
|---|---|---|
| `AGENT_PORT` | `3002` | puerto local |
| `ZALVAJE_BACKEND` | `http://localhost:3001` | a dónde deposita |
| `AGENT_KEY` | — | **debe coincidir con `AGENT_KEY` de Render** |
| `GEMINI_API_KEY` | — | el resumen con IA |
| `WHATSAPP_PHONE` | — | CallMeBot: número destino |
| `WHATSAPP_APIKEY` | — | CallMeBot: llave |
| `HEADLESS` | `true` | `false` abre Chrome visible, para depurar |
| `CLOUDFLARED_PATH` | `C:\Program Files (x86)\cloudflared\cloudflared.exe` | binario del túnel |
| `AGENT_DISABLE_TUNNEL` | — | `1` arranca sin túnel (desarrollo local) |

### API HTTP propia del agente

| Método | Ruta | |
|---|---|---|
| POST | `/scan` | arranca un scan |
| POST | `/stop` | lo corta (se respeta a mitad de bloque) |
| POST | `/scan-partial` | scan parcial |
| POST | `/scan-profile` | perfil de influencer |
| POST | `/ads-capture` | captura de bibliotecas de anuncios |
| GET | `/status` | `completedPlatforms[]` |
| GET | `/results` | payload completo, con capturas |
| GET | `/profile-status`, `/profile-results` | del scan de perfil |
| GET | `/ads-status` | de la captura de anuncios |
| GET | `/local-history`, `/local-results` | lo guardado en disco |
| GET | `/screenshots/…` | sirve las capturas |

Prueba rápida:
```bash
curl -X POST http://localhost:3002/scan -d '{"keyword":"WOM Colombia"}'
```

---

## 4. Las fuentes

`src/sources/` — 14 scrapers. Los tamaños dicen dónde está la dificultad real:

| Archivo | KB | Nota |
|---|---|---|
| `twitter.ts` | 41 | 18 pasadas de scroll, tope 150 tweets, 20 hilos top, 40 respuestas/hilo; segunda pasada con filtro `since:`. Rangos largos **en trozos mensuales**, no truncando al mes más reciente |
| `instagram.ts` | 32 | |
| `tiktok.ts` | 30 | |
| `linkedin.ts` | 29 | `waitForSelector` antes de extraer — `networkidle` no alcanza. 16 pasadas, 25 posts, 60 comentarios |
| `adsMeta.ts` | 22 | **anclaje por `page_id`** es el estándar (`d64363f`) |
| `youtube.ts` | 18 | |
| `threads.ts` | 17 | hay que **escribir en el buscador y dar Enter**: la URL sola no dispara la búsqueda. 20 pasadas |
| `news.ts` | 14 | Google News RSS primario (sin navegador) + 6 sitios colombianos secundarios |
| `facebook.ts` | 14 | |
| `adsGoogle.ts` | 12 | |
| `adsTikTok.ts` | 9 | |
| `reddit.ts` | 8 | |
| `linkedinProfile.ts` | 14 | ⚠ sin commitear |

URL del RSS de noticias:
`https://news.google.com/rss/search?q={kw}&hl=es-419&gl=CO&ceid=CO:es`

**Exclusiones**: se filtra por autor **y** por texto. Un término con `@` filtra
solo autor; un término plano filtra autor y texto.

**Capturas**: van en base64 dentro de los objetos de mención y comentario, y se
sirven completas en cada sondeo. Hay **3.840** en `screenshots/` y 61 resultados
en `results/` — ambos ignorados por git, y pesan.

### Servicios de apoyo

| Archivo | |
|---|---|
| `src/browser.ts` | el navegador Playwright y las sesiones |
| `src/aiSummary.ts` | Gemini 2.5 Flash por REST → `resumen`, `hitos`, `alertas`, `sentimiento`, `recomendacion`, `temas` |
| `src/whatsapp.ts` | CallMeBot |
| `src/adsLibrary.ts` | orquesta las tres bibliotecas de anuncios |
| `src/semanticRelevance.ts` | ⚠ sin commitear |
| `src/influencerProfileAI.ts` | ⚠ sin commitear |
| `src/setup-auth.ts` | login interactivo |

**El mensaje de WhatsApp debe quedar bajo ~900 caracteres.** CallMeBot recibe el
texto en la URL; más largo y la petición falla por longitud. No es un límite de
estilo, es el transporte.

---

## 5. `auth/` — lo más frágil del proyecto

Nueve archivos de cookies de sesión reales: `twitter.json`, `instagram.json`,
`tiktok.json`, `facebook.json`, `linkedin.json`, `threads.json`, `google.json`,
`meta.json`.

- **Ignorados por git, y así debe ser.** Son credenciales de sesión.
- **No los borres.** Rehacerlos es volver a loguearse a mano en ocho plataformas,
  con sus 2FA y sus capturas.
- **Caducan.** Cuando un scraper empieza a devolver vacío sin error, sospecha de
  la sesión antes de tocar los selectores. `renew-facebook.mjs` y
  `verify-sessions-final.mjs` existen justo para eso (⚠ sin commitear).
- Hay un `facebook.json.before-recovery`: alguien ya pasó por una recuperación.

**Al replicar en otra máquina, `auth/` no se copia y punto** — se rehace con
`npm run setup`. Es el cuello de botella real de cualquier réplica, no el código.

---

## 6. Replicar esto en otro proyecto

En orden, y cada paso existe porque el anterior falló alguna vez:

1. **Parte del disco, no del repo remoto** (§0).
2. **Define la credencial propia del agente primero.** Si el backend tiene un
   guard global, el agente necesita una puerta propia: una ruta exenta que valide
   su propio header. Si no, recibirás 401 en silencio.
3. **No confíes en un hostname fijo.** Si el agente es doméstico, túnel + un
   endpoint de registro. Y asume que el túnel se cae: auto-chequeo que mate el
   proceso y lo deje relanzarse.
4. **Reporta lo confirmado por la base, nunca lo enviado.** El bug de las "18
   guardadas" fue exactamente esto.
5. **Sesiones antes que selectores.** Prepara `setup-auth` y scripts de
   verificación desde el día uno: la mayoría de los "el scraper se rompió" son
   sesiones vencidas.
6. **Ponle tope a lo que va por URL.** El límite de ~900 caracteres de CallMeBot
   no se descubre leyendo la documentación, se descubre con mensajes que no
   llegan.
7. **Documenta todas las variables de entorno.** Las 9 de §3 contra las 3 que
   documentaba el ejemplo: esa brecha es horas de adivinar.

---

## 7. Pendientes

- **Commitear los 33 cambios**, con los 9 archivos nuevos (§0). Lo más urgente.
- **Rotar `AGENT_KEY`**, que quedó en el historial de git (§0).
- `agent-startup.log` pesa **735 KB**; `watchdog.log`, 8,5 KB. El README viejo
  advierte de miles de reinicios acumulados en PM2 — si sigue reiniciándose
  seguido, ahí está el rastro.
- Capturas de depuración sueltas en la raíz (`debug_threads_*.png`,
  `verify-facebook.png`, `verify-tiktok.png`) — unos 870 KB que no aportan.
- El `.gitignore` cubre bien lo sensible (`.env`, `auth/`, `results/`,
  `screenshots/`, `*.log`). No lo relajes.

---

## 8. Cómo trabajar acá

- **Español** en commits, comentarios y mensajes.
- Los comentarios buenos de este repo explican **el fallo que motivó el código**,
  no lo que hace la línea. Mira la cabecera del túnel en `server.ts:1465` o la de
  `ads-deposit` en ZALVAJE: ese es el estándar.
- **No hay build.** `tsx` ejecuta el TypeScript directo. No busques `dist/`.
- Para depurar un scraper: `HEADLESS=false` y mira el navegador. Más rápido que
  leer logs.
- Antes de cambiar selectores, verifica la sesión (§5).
- `server.ts` tiene **1.572 líneas** y enruta a mano con `if (method === … && url === …)`.
  Es un servidor HTTP plano de Node, sin framework. No hay middlewares: lo que
  agregues va en la cadena de `if`.
