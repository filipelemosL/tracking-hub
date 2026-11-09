# Tracking Hub

Backend de demonstração para capturar visitas, registrar vendas, decidir sua atribuição e preparar conversões para Meta, Google, TikTok, UTMify e RedTrack. Usa Node.js 22+, TypeScript, Express, Prisma, PostgreSQL, Docker Compose e Vitest. **Os cinco destinos são simulados:** nenhum postback é enviado a uma plataforma real.

## 1. Executar o projeto

### Tudo pelo Docker Compose

Pré-requisito: Docker Desktop com Compose. Na raiz do projeto:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d --build
docker compose ps
docker compose logs -f api worker
```

O Compose inicia PostgreSQL com volume e healthcheck, aplica as migrations pelo serviço `migrate` e então inicia API e worker. API e worker usam a mesma imagem com comandos separados. A API responde em `http://localhost:3000`. O banco publica a porta `5432` no Windows; os serviços do Compose usam `db:5432`. Verifique `GET http://localhost:3000/health`. Para encerrar sem apagar o volume, execute `docker compose down`.

### Banco no Compose, API e worker no terminal

Requer Node.js 22+, npm e Docker Desktop:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm ci
docker compose up -d db
npm run prisma:generate
npm run prisma:migrate:deploy
```

Em dois terminais, execute `npm run dev` e `npm run dev:worker`. O primeiro recebe HTTP; o segundo processa eventos e conversões. O `DATABASE_URL` de `.env` usa `localhost:5432` porque esses processos rodam no Windows. A geração do Prisma e as migrations são necessárias na instalação ou após mudanças no schema; não precisam ser repetidas a cada inicialização. Para esta demonstração, mantenha um worker ativo.

### Testes e checagens

```powershell
if (!(Test-Path .env.test)) { Copy-Item .env.test.example .env.test }
docker compose --profile test up -d db-test
npm run test:obrigatorios
npm run test:integration
npm test
npm run typecheck
npm run build
```

Os testes de integração aplicam migrations no banco isolado `tracking_hub_test`, publicado em `localhost:5433`, e limpam suas fixtures. `test:obrigatorios` executa os oito casos do enunciado em um spec; `test:integration` inclui esse spec e as regressões. `npm test` não precisa do banco. Os exemplos de `.env` têm credenciais locais de demonstração; altere-as fora desse ambiente.

## 2. Fluxo e endpoints

Fluxo: **captura da sessão → webhook persistido → worker atribui e grava o pedido → worker prepara e simula os envios → suporte consulta a decisão**. Envie JSON com `Content-Type: application/json`; o corpo tem limite de 64 KiB (`413 BODY_TOO_LARGE`). Os exemplos usam dados fictícios.

### `POST /tracking/sessions` — guardar evidência antes da compra

```json
{
  "sessionId": "session_demo_1",
  "capturedAt": "2026-11-07T19:00:00Z",
  "pageUrl": "https://checkout.example.test/produto",
  "customFields": { "source": "facebook", "campaign": "lancamento", "affiliateCode": "AFF-DEMO" },
  "identifiers": {
    "fbclid": "fb-click-demo", "fbc": "fb.1.123.demo", "fbp": "fb.1.456.demo",
    "gclid": "google-click-demo", "ttclid": "tiktok-click-demo",
    "ttp": "tiktok-cookie-demo", "redtrackClickId": "redtrack-demo", "utmifyId": "utmify-demo"
  },
  "customer": { "email": "cliente@example.test" }
}
```

`sessionId` e `pageUrl` são obrigatórios; `visitorId`, `capturedAt`, `customFields`, `identifiers` e `customer` são opcionais. O backend preserva a hora informada pelo cliente e a hora de recebimento separadamente. Identificadores ausentes continuam ausentes; e-mail e telefone são normalizados e armazenados como hashes SHA-256. `customFields` é a fonte de campanha e afiliado fornecida pelo checkout: um click ID não vira nome de campanha.

Retorna `201` para nova sessão e `200` para reenvio equivalente, sem alterar a captura inicial. Mesmo `sessionId` com dados diferentes retorna `409 SESSION_CAPTURE_CONFLICT`; entrada inválida retorna `400 VALIDATION_ERROR`. A captura é imutável. `capturedAt` exige ISO 8601 com fuso e não pode estar mais de cinco minutos no futuro. Há limites por campo, inclusive 512 caracteres por identificador.

**Pixel no navegador e evento de servidor têm papéis distintos.** Um pixel executado no navegador pode observar a chegada pela campanha, URL e cookies; o webhook `ORDER_PAID` vem do checkout ao backend e confirma a venda. Esta API **não implementa um pixel nem dispara um evento de navegador**: recebe e preserva a evidência capturada pelo cliente. Bloqueadores, restrições de cookies, redirecionamentos que removem parâmetros e troca de dispositivo podem separar a visita da compra. A falta de click ID no webhook não apaga o valor salvo na sessão, mas o vínculo com essa sessão exige prova suficiente.

| Identificador | Uso na investigação |
| --- | --- |
| `fbclid` | ID do clique Meta na URL; o serviço não o converte automaticamente em `fbc`. |
| `fbc` | Valor de cookie de clique Meta usado como sinal de matching. |
| `fbp` | Valor de cookie do navegador Meta; ajuda no matching, sem identificar sozinho a campanha. |
| `gclid` | ID de clique Google Ads usado na conversão simulada. |
| `gbraid`, `wbraid` | Identificadores alternativos de clique Google em fluxos com restrições de privacidade. |
| `ttclid` | ID do clique TikTok associado à chegada pelo anúncio. |
| `ttp` | Cookie de primeira parte TikTok usado como sinal de matching. |
| `redtrackClickId`, `utmifyId` | Identificadores próprios desses destinos; não são substituídos por IDs de outra rede. |

### `POST /webhooks/orders` — aceitar a venda sem esperar os postbacks

```json
{
  "eventId": "event_demo_1",
  "event": "ORDER_PAID",
  "orderId": "order_demo_1",
  "sessionId": "session_demo_1",
  "amount": 25500,
  "currency": "USD",
  "occurredAt": "2026-11-07T19:30:00Z",
  "customer": { "email": "cliente@example.test" }
}
```

`eventId`, `event: "ORDER_PAID"`, `orderId`, `amount` e `currency` são obrigatórios. `amount` é inteiro positivo **em centavos** (`25500` = US$ 255,00); `currency` tem três letras maiúsculas. `sessionId`, `occurredAt`, `customer.email` e `customFields` são opcionais. Se os `customFields` do webhook estiverem ausentes ou vazios, o worker usa o grupo da sessão atribuída. Um grupo parcial do webhook **não** é completado com campos da sessão: isso evita misturar campanhas ou afiliados de origens distintas. Sem as duas fontes, não inventa campanha.

O endpoint grava payload original e forma normalizada **antes** de responder `202 { "eventId": "event_demo_1", "accepted": true, "duplicate": false }`. O worker processa depois. Um `eventId` repetido com o mesmo conteúdo recebe `202` com `duplicate: true`; conteúdo divergente recebe `409 WEBHOOK_EVENT_CONFLICT`. Falha de persistência recebe `503 WEBHOOK_PERSISTENCE_FAILED`; entrada inválida recebe `400 VALIDATION_ERROR`. `202` confirma persistência, não entrega da conversão.

O banco impõe unicidade para `eventId`, `orderId` e pedido/tipo/provedor. Pedido, snapshot de atribuição, cinco envios pendentes e conclusão do evento são gravados na mesma transação. Eventos concorrentes do mesmo pedido são serializados. Reprocessar não substitui pedido ou envio concluído. Não existe um modelo separado de comissão nesta implementação.

**Atribuição.** O worker prioriza `sessionId` existente e anterior à compra. Se o ID ainda não existe, aguarda até 10 segundos pela captura; depois tenta e-mail normalizado em uma janela de 30 minutos. O fallback exige **uma única** sessão elegível. Duas sessões do mesmo cliente produzem `AMBIGUOUS_CUSTOMER_MATCH`; ausência de evidência produz `NO_MATCH` ou `SESSION_NOT_FOUND`. A venda continua registrada como não atribuída. O webhook atual não recebe `visitorId` nem click IDs; portanto, não usa esses sinais como fallback na venda. Os IDs da sessão escolhida são usados nos postbacks. O snapshot guarda a origem de cada campo e não é recalculado por tracking tardio.

### Envios de conversão — cinco destinos simulados

O worker executa um dispatcher sequencial. Cada destino prepara seu próprio request. O transporte simulado é chamado **fora da transação**; cada tentativa registra número, início/fim, status, HTTP, erro, request protegido, resposta e digest do request original. Falha de um destino não bloqueia os outros.

| Destino | O que prepara | Quando não envia |
| --- | --- | --- |
| Meta | `Purchase`, `event_id` estável, valor, moeda, URL e `fbc`/`fbp` ou hashes de cliente. | Sem URL ou sinal mínimo de matching. |
| Google | Conversão de clique com `orderId`, horário, valor e `gclid`, `gbraid` ou `wbraid`. | Sem um desses IDs de clique. |
| TikTok | Evento web `Purchase`, `event_id`, URL, valor e `ttclid`/`ttp` ou hashes de cliente. | Sem URL ou sinal mínimo de matching. |
| UTMify | Pedido pago com valor em centavos e `utm_*` derivados de `customFields`. | A simulação aceita até venda sem tracking. |
| RedTrack | Postback com `clickid` vindo exclusivamente de `redtrackClickId`. | Sem o ID próprio RedTrack. |

`SKIPPED` registra o motivo sem tentativa. Falha temporária conhecida entra em `RETRY_PENDING`, com até três tentativas e espera controlada; falha permanente termina. Timeout ou perda da confirmação de um envio em andamento produz `UNKNOWN`, sem reenvio automático porque o destino pode ter aceitado a chamada. `DELIVERED` significa **aceitação simulada**, não presença no painel externo. Não há credenciais nem envio de rede para os provedores.

Para reproduzir falhas, defina `ENABLE_TEST_SCENARIOS=true` em `.env` com `NODE_ENV=development`, reinicie a API e envie no webhook o header `X-Test-Conversion-Scenario`. Os cenários são `SUCCESS`, `META_RETRY_ONCE`, `GOOGLE_RATE_LIMIT_ONCE`, `TIKTOK_PERMANENT`, `META_ALWAYS_503`, `META_TIMEOUT` e `GOOGLE_APPLICATION_ERROR`. O header é rejeitado por padrão e não é habilitado em produção. O primeiro evento fixa o cenário; não o altere no reenvio do mesmo `eventId`.

**Deduplicação do navegador versus servidor.** A unicidade local impede repetir a mesma conversão para o mesmo destino; ela não substitui a deduplicação da plataforma. Em integração real, Meta relaciona cópias do Pixel e da Conversions API pelo mesmo nome e ID de evento; TikTok exige o mesmo `event_id` no Pixel e na Events API quando ambos reportam a mesma ação; Google Ads usa o `order_id` da conversão importada para ajudar a impedir duplicatas da mesma ação. Aqui, Meta e TikTok recebem um `conversionId` local estável e Google recebe `orderId`, mas **não existe um Pixel de compra neste projeto para compartilhar o ID com o navegador**. Uma integração real precisa coordenar esses IDs e confirmar o contrato vigente de cada plataforma.

### `GET /support/orders/:orderId/tracking` — Auditar a decisão

Consulta somente leitura com `Cache-Control: no-store`. Retorna pedido, sessão escolhida, motivo e método de atribuição, `customFields`, identificadores, origem por campo, eventos do webhook, destinos e histórico de tentativas. `attribution.evidence` indica fonte (`WEBHOOK` ou `TRACKING_SESSION`), ID e caminho do valor; `attribution.customFieldConflicts` mostra divergências sem misturar fontes.

Retorna `202` quando o webhook existe, mas ainda não há pedido; `200` quando há pedido, mesmo com envios pendentes. Uma falha terminal antes do pedido também aparece em `200` com `processingStatus: FAILED`. `404 ORDER_NOT_FOUND` significa que não existe pedido nem webhook conhecido com esse `orderId`; erro de banco retorna `503 SUPPORT_LOOKUP_FAILED`. O GET não aciona o worker nem altera o banco. O payload original permanece armazenado para auditoria, mas **não é exposto** nessa resposta.

**Investigação de divergências.** Comece pelo `orderId` e compare valor em centavos, data e `timeSource` com o checkout. Confira sessão, `customFields` e `evidence` antes de atribuir campanha ou afiliado. Compare cada destino: RedTrack precisa do `redtrackClickId` daquela sessão; UTMify usa os `customFields` escolhidos; Google precisa de um ID de clique compatível. Verifique `status`, `reason`, HTTP, tentativa e request protegido. Um `DELIVERED` simulado não valida o painel externo. Para evitar crédito ao afiliado errado, não use campo de outra sessão nem complete um grupo comercial parcial com valores conflitantes.

### `GET /health` e `GET /diagnostics/database`

`/health` testa a conexão PostgreSQL: `200 { "status": "ok", "database": "up" }` ou `503` se indisponível. `/diagnostics/database` consulta o banco via Prisma e retorna estado e contagem de sessões; também retorna `503` se a consulta falhar. São verificações de infraestrutura, não de entrega de conversões.

## 3. Diagnóstico pelo terminal e logs

Com a API em execução, consulte o `orderId` usado no webhook:

```powershell
npm run support:order -- order_demo_1
npm run support:order -- order_demo_1 --show-payload
npm run support:order -- order_demo_1 --json
```

A CLI usa o endpoint de suporte e organiza a resposta como roteiro de atendimento: situação do pedido, vínculo com a visita, andamento, resultado dos envios e pontos para investigar. Mostra centavos e valor formatado na moeda registrada, com origem por campo. `--show-payload` inclui requests e respostas protegidos pela API; `--json` mostra o JSON. `--base-url` ou `TRACKING_HUB_BASE_URL` escolhem outra API. `ORDER_NOT_FOUND` indica que o ID consultado não está nesse banco; os IDs de exemplo precisam ser criados antes.

Os processos registram linhas JSON no console. A API gera `http.request` e `http.response` com o mesmo `requestId`; o worker registra `conversion.request`, `conversion.response` e conversões `SKIPPED` com provedor, ID e tentativa. Credenciais e contatos em texto puro são mascarados; campos livres extensos são limitados. Acompanhe com `docker compose logs -f api worker` ou, na execução local, nos terminais de `npm run dev` e `npm run dev:worker`. Logs ajudam a correlacionar chamadas, mas o histórico persistido de tentativas é a fonte de auditoria. A API de suporte ainda não tem autenticação; antes de exposição pública precisa de controle de acesso, mesmo com mascaramento.

## 4. Decisões técnicas

O projeto é um **monólito modular**: `src/http` valida e expõe rotas; `src/application` concentra captura, atribuição e conversões; `src/infra/database` implementa persistência e processamento com Prisma; `src/cli` apresenta o diagnóstico. API e worker são processos separados da mesma base de código.

Para o tamanho do desafio, essa divisão mantém um único contrato de domínio, migrations e transações para a idempotência. Separar agora cada destino em um microsserviço exigiria coordenar gravações e falhas entre serviços, dificultando a decisão de atribuição e a auditoria. O worker continua independente do ciclo HTTP, e os adaptadores isolam formatos e classificações por provedor para futura substituição do transporte.

PostgreSQL funciona como fila persistente: o webhook confirma o commit antes do `202`; o worker busca eventos e envios elegíveis; locks, índices únicos, transações e leases controlam concorrência e retomada. O modelo guarda payload original, centavos, snapshot de atribuição e tentativas. Precedência, estados e limites detalhados estão em [architecture.md](architecture.md).

## 5. Entregáveis

| Entregável | Onde encontrar |
| --- | --- |
| Código da API, casos de uso, worker e adaptadores | [`src/`](src/), especialmente [`src/http/app.ts`](src/http/app.ts), [`src/worker.ts`](src/worker.ts) e [`src/application/conversions/providers.ts`](src/application/conversions/providers.ts) |
| Modelagem e migrations Prisma | [`prisma/schema.prisma`](prisma/schema.prisma) e [`prisma/migrations/`](prisma/migrations/) |
| Execução local e configuração | [`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml), [`.env.example`](.env.example) e [`.env.test.example`](.env.test.example) |
| Testes automatizados | [`tests/`](tests/), com os oito obrigatórios em [`tests/integration/casos-obrigatorios.spec.ts`](tests/integration/casos-obrigatorios.spec.ts) |
| Documentação de execução e decisões | Este README e [`architecture.md`](architecture.md) |
| Coleção Postman ou especificação OpenAPI | Importe [`postman/tracking-hub-complete.postman_collection.json`](postman/tracking-hub-complete.postman_collection.json) no Postman. A coleção usa `baseUrl=http://localhost:3000` por padrão. |


