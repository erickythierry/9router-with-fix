# Fork do 9router com fixes

Fork de [`decolua/9router`](https://github.com/decolua/9router). Os fixes que antes eram
scripts Python aplicados por regex no bundle minificado do npm (repo `9router-docker`) agora
vivem no fonte, um commit por fix na branch `patches`, rebaseada em cima do upstream.

A instância de produção roda no mini PC (`192.168.1.2`, `/opt/9router-docker`, dados em
`/opt/9router-data`). Não subir uma segunda instância com as mesmas contas OAuth: dois
routers disputam o refresh token.

## Branches

- `master`: espelho do upstream, sem commit próprio.
- `patches`: o que vai para produção. Cada fix é um commit isolado, para virar PR com
  `git cherry-pick` numa branch saída de `upstream/master`.

## Atualizar do upstream

```bash
git fetch upstream --tags
git switch master && git merge --ff-only upstream/master && git push origin master
git switch patches && git rebase master
# conflito = upstream mexeu nas mesmas linhas; resolver, `git rebase --continue`
git push --force-with-lease origin patches
```

`git config rerere.enabled true` guarda a resolução de conflito e reaplica no próximo rebase.
Se o upstream corrigiu o mesmo bug, o commit do fix fica vazio ou conflita inteiro: testar o
sintoma e descartar o commit (`git rebase --skip`).

Testes (a suíte do upstream já tem falhas próprias; comparar contagem antes/depois):

```bash
cd tests && npm install --legacy-peer-deps --no-package-lock
node_modules/.bin/vitest run unit/claude-client-fork-fixes.test.js
```

## Build e deploy

Build aqui no desktop (o `next build` não cabe na RAM do mini PC), deploy por `docker save`:

```bash
docker compose -f fork/docker-compose.yml build
ssh root@192.168.1.2 'docker tag 9router:local 9router:rollback-<versao-antiga>'
docker save 9router:local | ssh root@192.168.1.2 'docker load'
ssh root@192.168.1.2 'cd /opt/9router-docker && docker compose up -d --force-recreate'
```

O compose de produção no mini PC precisa espelhar `fork/docker-compose.yml`: o volume monta
em `/app/data` (antes era `/data`).

Rollback: `docker tag 9router:rollback-<versao> 9router:local && docker compose up -d --force-recreate`
no mini PC. Backups do db em `/opt/9router-data/db/backups/`.

## Decisões de deploy

- **Dockerfile do upstream**, com `NODE_IMAGE=node:24-alpine`. O upstream usa Node 22; o 24
  deixa o `node:sqlite` estável para o `/v1/systemone`.
- **`network_mode: host`**: o middleware só dispensa API key para socket em
  `{localhost, 127.0.0.1, ::1}`. Com bridge, todo cliente local vira `172.17.0.1`.
- **`custom-server.js` direto, sem `cli.js`**: o CMD do upstream já faz isso. O compose só
  acrescenta `--dns-result-order=ipv4first` e `--max-old-space-size=6144`.

## Fixes

### 1. `/v1/messages` non-stream devolve `chat.completion` em vez de `Message`

- Arquivos: `open-sse/handlers/chatCore/nonStreamingHandler.js`, `sseToJsonHandler.js`
- Sintoma: Claude Code corta com *"empty or malformed response … JSON but not a Message"*.
- Causa: dois caminhos param no formato OpenAI quando o cliente fala Claude:
  - Upstream Gemini/Antigravity: o tradutor faz só gemini→openai.
  - Provider com `forceStream` (`oc/*`, `cmc/*`, `cx/*`…) e cliente pedindo JSON: o
    conversor SSE→JSON só sabe montar `chat.completion`, `response` e Gemini.
- Fix: `openAICompletionToClaudeMessage` (já existia no upstream) foi movido para
  `sseToJsonHandler.js` e aplicado nos dois caminhos quando `sourceFormat === CLAUDE`.

### 2. Keepalive SSE para o Claude Code (`cx/*` e modelos que raciocinam calados)

- Arquivos: `open-sse/utils/streamHelpers.js` (`withClaudePing`),
  `handlers/chatCore/streamingHandler.js`, `executors/codex.js`
- Sintoma: *"Waiting for API response · will retry in 1m 55s · check your network"*; o
  Claude Code aborta e refaz a request do zero.
- Causa: o Claude Code tem watchdog por byte no corpo do stream (banner em 20s, aborta no idle
  timeout). A API da Anthropic manda `event: ping` para isso; o 9router fica mudo em dois
  pontos:
  1. O peek do codex (`_peekSseTransientError`) segura a resposta até o primeiro delta, para
     trocar de conta em "model at capacity". Enquanto o GPT raciocina, nem os headers saem.
  2. Com o stream aberto, o tradutor descarta os eventos de reasoning e o `message_start` só
     sai junto com o primeiro delta.
- Fix:
  1. Cliente Claude em stream recebe `event: ping` na abertura e a cada 5s sem chunk.
  2. O peek do codex tem teto de 5s (`CODEX_SSE_PEEK_MS`). A leitura pendente é reaproveitada
     no stream de saída, sem perder chunk. Capacity depois de 5s vira erro no stream, sem
     fallback de conta.
- O stall timeout do 9router (`STREAM_STALL_TIMEOUT_MS`) continua valendo para upstream
  travado de verdade.

### 3. Jev (`jev-1.13-free`) em `POST /v1/systemone` (alias `/v1/decisions`)

- Arquivo: `custom-server.js`
- Sintoma: `oc/jev-1.13-free` responde `500` em `/v1/chat/completions`.
- Causa: o Jev não é LLM. Recebe `{model, state, questions}` e devolve `{answers}`, e o Zen só
  atende em `/zen/v1/systemone`. A rota nativa `/api/v1/systemone` do upstream faz `fetch`
  direto, sem proxy, e o IP do mini PC leva `429` do Zen.
- Fix: o wrapper HTTP intercepta a rota antes do Next. Valida a key em `apiKeys` (cache de
  30s; loopback dispensa), tira `oc/` do `model` e repassa ao Zen com `Bearer public`, saindo
  pelos `proxyPools` conforme `settings.providerStrategies.opencode` (até 3 tentativas
  trocando de proxy). Modelo de outro provider (`openrouter/...`) vai em loopback para a rota
  nativa.
- Não registra uso no dashboard; só uma linha `[systemone] ... via=<proxy>` no log.

```bash
curl -s http://192.168.1.2:20128/v1/systemone -H "Authorization: Bearer $(cat ~/.9router/lan-api-key)" \
  -d '{"model":"oc/jev-1.13-free","state":{"msg":"Domingo vote 22"},
       "questions":{"politica":{"type":"noul","instructions":"Propaganda eleitoral?",
                    "criteria":{"true":"sim","false":"nao"}}}}'
```

## Fixes do repo antigo que não vieram

- `prefixItems` no schema de tool Gemini: upstream corrigiu em `f6c59d30` (v0.5.91).
- Peek do `commandcode` (`cmc/*`) cortando resposta: upstream corrigiu em 0.5.91.
- Session ID / `forceStream` do `opencode` free tier: sintoma sumiu em 0.5.95.
- System prompt do Cursor (`cu/*`): fora de uso.

Os scripts continuam no histórico do repo `9router-docker`, caso o sintoma volte.
