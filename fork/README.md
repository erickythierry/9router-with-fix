# Fork do 9router com fixes

Fork de [`decolua/9router`](https://github.com/decolua/9router). Os fixes que antes eram
scripts aplicados via patch no bundle do npm agora
vivem no fonte, um commit por fix na branch `patches`, rebaseada em cima do upstream.

A instância de produção roda em um servidor dedicado (`<server-ip>`). Não subir uma segunda
instância com as mesmas contas OAuth: dois routers disputam o refresh token.

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

Build no host de desenvolvimento e deploy remoto via Docker:

```bash
docker compose -f fork/docker-compose.yml build
ssh <user>@<server-ip> 'docker tag 9router:local 9router:rollback-<versao-antiga>'
docker save 9router:local | ssh <user>@<server-ip> 'docker load'
ssh <user>@<server-ip> 'cd <deploy-dir> && docker compose up -d --force-recreate'
```

O `docker-compose.yml` de produção no servidor remoto espelha `fork/docker-compose.yml`
(o `build:` lá não roda, a imagem já existe). Mudou o compose, `scp` de novo.

Rollback: `docker tag 9router:rollback-<versao> 9router:local && docker compose up -d --force-recreate`
no servidor remoto. Backups do db em `<data-dir>/db/backups/`.

## Decisões de deploy

- **Dockerfile do upstream**, com `NODE_IMAGE=node:24-alpine`. O upstream usa Node 22; o 24
  deixa o `node:sqlite` estável para o `/v1/systemone`.
- **`network_mode: host`**: o middleware só dispensa API key para socket em
  `{localhost, 127.0.0.1, ::1}`. Com bridge, todo cliente local vira `172.17.0.1`.
- **`custom-server.js` direto, sem `cli.js`**: o CMD do upstream já faz isso. O compose só
  acrescenta `--dns-result-order=ipv4first` e heap adaptado ao ambiente (`mem_limit: 2g`).

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
  direto, sem proxy, e requisições diretas podem sofrer rate limit (`429`) do Zen.
- Fix: o wrapper HTTP intercepta a rota antes do Next. Valida a key em `apiKeys` (cache de
  30s; loopback dispensa), tira `oc/` do `model` e repassa ao Zen com `Bearer public`, saindo
  pelos `proxyPools` conforme `settings.providerStrategies.opencode` (até 3 tentativas
  trocando de proxy). Modelo de outro provider (`openrouter/...`) vai em loopback para a rota
  nativa.
- Não registra uso no dashboard; só uma linha `[systemone] ... via=<proxy>` no log.

```bash
curl -s http://localhost:20128/v1/systemone -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"oc/jev-1.13-free","state":{"msg":"Teste de mensagem"},
       "questions":{"categoria":{"type":"noul","instructions":"Classificar conteúdo",
                    "criteria":{"true":"sim","false":"nao"}}}}'
```

### 4. Estimativa de `input_tokens` no `message_start` para clientes Claude

- Arquivos: `open-sse/utils/stream.js`, `tests/unit/claude-client-fork-fixes.test.js`
- Sintoma: com `cx/gpt-6.1-sol` no Claude Code, o contador do subagente mostrava `↓ 222 tokens`
  (2–3 dígitos), sempre o mesmo valor, aparentemente travado.
- Causa: o tradutor manda `message_start` com `usage: {input_tokens: 0, output_tokens: 0}` e o
  usage real só chega no `message_delta`. O Claude Code monta o contador do subagente a partir
  do usage do `message_start`; o `task_progress` ficava em `total_tokens: 46` durante toda a
  execução.
- Fix: quando o cliente fala Claude e o `message_start` sai sem `input_tokens`, injeta
  `estimateInputTokens(body)` (≈ chars/4 do body). O usage real continua chegando no
  `message_delta`. É estimativa, não contagem exata do upstream.

## Fixes do repo antigo que não vieram

- `prefixItems` no schema de tool Gemini: upstream corrigiu em `f6c59d30` (v0.5.91).
- Peek do `commandcode` (`cmc/*`) cortando resposta: upstream corrigiu em 0.5.91.
- Session ID / `forceStream` do `opencode` free tier: sintoma sumiu em 0.5.95.
- System prompt do Cursor (`cu/*`): fora de uso.

Os scripts legados foram descontinuados, caso o sintoma volte consulte os commits de histórico.
