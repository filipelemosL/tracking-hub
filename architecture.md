# Arquitetura · Tracking Hub

## Padrão de design
- Monólito modular em Node.js + TypeScript. Express é a camada HTTP exigida pelo enunciado.
- Use cases concentram as regras. Rotas validam entradas e chamam os casos de uso.
- Prisma acessa o PostgreSQL. Um contrato `ConversionProvider` define o envio por adaptadores.
- Docker Compose sobe PostgreSQL, migrator, API e worker. API e worker usam a mesma imagem com comandos distintos; o migrator conclui antes de ambos. O profile `test` oferece um banco isolado.
- O banco é a fila persistente. Vitest testa os casos de uso e a integração com PostgreSQL.
- Os oito cenários exigidos no enunciado estão reunidos em `tests/integration/casos-obrigatorios.spec.ts`. `npm run test:obrigatorios` executa só essa suíte no banco `tracking_hub_test`; `npm run test:integration` inclui essa suíte e as regressões detalhadas.

## Fluxo e consistência
1. `POST /tracking/sessions` valida, normaliza e persiste a captura.
   A captura é imutável: reenvio equivalente retorna 200; dados diferentes no mesmo
   `sessionId` retornam 409. Enriquecimento posterior exige uma evolução explícita
   do contrato.
   Limites HTTP: corpo JSON de 64 KiB; `sessionId` e `visitorId` até 128 caracteres,
   URL até 2048, cada identificador até 512, `customFields` até 16 KiB,
   e-mail até 254 e telefone até 32. `capturedAt` é opcional e exige ISO 8601
   com fuso; `receivedAt` é observado no backend. E-mail e telefone são
   normalizados e persistidos somente como hashes SHA-256.
2. `POST /webhooks/orders` valida e grava o payload original e a forma normalizada. Responde `202` somente após o commit; mesmo `eventId` equivalente é repetição, diferente é `409`.
3. O worker sequencial usa `runOnce` sobre a fila PostgreSQL. Pedido, snapshot, cinco envios `PENDING` e conclusão do evento são gravados na mesma transação. Um advisory lock por `orderId` serializa eventos concorrentes do mesmo pedido; não há estado `PROCESSING` sem recuperação.
   Eventos posteriores do mesmo pedido aguardam um evento anterior ainda elegível, preservando a primeira decisão mesmo durante `WAITING_TRACKING`.
4. O mesmo worker executa um ciclo de pedidos e um ciclo do dispatcher, em sequência. O dispatcher reivindica um envio com token e lease, grava `STARTED`, chama o transporte simulado fora da transação e grava o resultado. Retoma `PENDING` e `RETRY_PENDING` após reinício. Lease vencido com tentativa aberta vira `UNKNOWN`, sem retry automático.
5. `GET /support/orders/:orderId/tracking` expõe o processamento pendente (`202`) ou pedido concluído (`200`), decisão, origem por campo, estados dos envios e tentativas em ordem. Requests e respostas na visão de suporte mostram apenas hashes SHA-256 válidos para e-mail e telefone; texto puro e credenciais são mascarados. O payload original não é retornado.

## Banco de dados
| Modelo | Chaves e conteúdo |
| --- | --- |
| `TrackingSession` | `sessionId` único, `visitorId` opcional, URL, `customFields`, identificadores, hashes de cliente, `capturedAt` opcional do cliente e `receivedAt` do backend. |
| `WebhookEvent` | `eventId` único, payload original e normalizado, status, recebimento, prazo de tracking, retry e FK opcional do pedido. |
| `Order` | `orderId` único, centavos em `BIGINT`, moeda, horário e origem, FK opcional da sessão e snapshot da atribuição. |
| `ConversionDelivery` | FK do pedido, único por pedido/tipo/provedor, `conversionId` estável, cenário, estado, motivo, request congelado, digest, token e lease. |
| `ConversionAttempt` | Único por envio/número; início, fim, estado, HTTP opcional, erro, request e resposta protegidos e digest. |
- Sessão 1:N pedidos. Pedido 1:N eventos e envios. Envio 1:N tentativas.
- Indexar consultas de trabalho por estado e elegibilidade. Indexar os campos usados nos fallbacks.

## Políticas
- Ordem de atribuição: sessão válida → ID próprio da plataforma → click ID → cliente e janela.
- A entrada atual de venda contém apenas `sessionId` e e-mail. Fallback por `visitorId` ou click ID dependerá de uma evolução do contrato de vendas.
- A sessão explícita deve ter captura anterior ou igual à compra (`capturedAt`, senão `receivedAt`). Sessão posterior produz `SESSION_AFTER_ORDER`. Sem `sessionId`, o hash do e-mail só atribui quando há exatamente uma sessão elegível nos 30 minutos anteriores. A comparação de e-mail reduz maiúsculas e espaços laterais, sem remover pontos.
- Um `sessionId` desconhecido espera até `TRACKING_WAIT_MS=10000` a partir do recebimento. O worker verifica no máximo a cada 1000 ms; após o prazo, tenta fallback por cliente e registra `SESSION_NOT_FOUND` se não houver candidato. `occurredAt` ISO 8601 com fuso pode estar até cinco minutos no futuro; ausente, usa o primeiro `receivedAt` e registra `RECEIVED_AT`. A moeda exige três letras maiúsculas; esta validação sintática não consulta uma lista de moedas.
- Falha de processamento reverte toda a transação e agenda retry persistido, limitado a três tentativas, com erro público protegido. Mesmo pedido em novo evento conserva snapshot e envios; valor, moeda ou sessão explicitamente contraditória produzem `ORDER_DATA_CONFLICT` no evento.
- Fallback só com candidato inequívoco. Ambiguidade sem evidência mais forte deixa a venda sem atribuição.
- Campanha e afiliado vêm de `customFields`. Priorizar os campos de campanha do webhook como grupo. Usar o grupo da sessão quando ausente e registrar conflitos.
- Meta, Google, TikTok, UTMify e RedTrack têm payloads próprios e compartilham o transporte simulado.
- Falha temporária conhecida agenda retry limitado. Erro permanente encerra. Envio concluído é preservado.
- Tentativa iniciada sem confirmação vira resultado incerto para revisão. Restrições locais não garantem deduplicação externa.
- Plano C: executar o mesmo worker no processo da API em instância única, preservando fila, transações e histórico.

## Conversões simuladas

`CONVERSION_MODE=simulated` é o único modo implementado. O transporte compartilhado não abre conexões externas; os endereços `.invalid` indicam formatos de demonstração. Cada adaptador monta seu request e classifica a resposta HTTP **e** o resultado do item. O request lógico é congelado na primeira tentativa e seu SHA-256 canônico é persistido antes do mascaramento. A atribuição não é recalculada. O contexto de conversão (URL e hashes do cliente da sessão originalmente escolhida, com fallback para o hash de e-mail do webhook) é gravado com o pedido e inclui a origem desses campos. Para pedidos anteriores a esta migração, o dispatcher o deriva uma vez da FK original; campos indisponíveis permanecem ausentes. Os hashes de e-mail e telefone foram normalizados e calculados na captura da sessão ou no webhook; os adaptadores os reutilizam sem aplicar um segundo hash. Os valores continuam em centavos no banco.

| Destino | Request representado | Elegibilidade simulada |
| --- | --- | --- |
| Meta | `data[0]` Purchase com `event_id`, Unix seconds, URL, `value` em unidades, moeda e `user_data` (`fbc`, `fbp`, hashes `em`/`ph`). | URL e ao menos um sinal de matching; senão `MISSING_MATCHING_DATA`. `fbclid` não vira `fbc` automaticamente. |
| Google | Upload de click conversions com `partialFailure`, ação fictícia, horário UTC com offset, valor em unidades, moeda, `orderId` e IDs de clique disponíveis. | `gclid`, `gbraid` ou `wbraid`; senão `MISSING_CLICK_ID`. Erro em `partialFailureError` encerra mesmo com HTTP 200. |
| TikTok | Evento web Purchase com ID estável, Unix seconds, URL, valor em unidades, moeda, `ttclid`, `ttp` e hashes quando disponíveis. | URL e ao menos um sinal de matching; senão `MISSING_MATCHING_DATA`. Código da aplicação é verificado. |
| UTMify | `utmify-demo-v1`: pedido pago, data UTC, centavos, moeda, parâmetros `utm_*` vindos de `customFields`, `utmifyId` e `affiliateCode` em metadata da simulação. | Aceita venda sem tracking. Contrato simplificado; não representa API oficial completa nem inventa produtos, taxas ou comissão. |
| RedTrack | GET com `query.clickid` exclusivamente de `redtrackClickId`; IDs do pedido e conversão ficam na correlação interna. | Sem click ID, `MISSING_REDTRACK_CLICK_ID`. Não envia `sum`/`payout`. |

Os estados de envio são `PENDING`, `PROCESSING`, `RETRY_PENDING`, `DELIVERED`, `FAILED_PERMANENT`, `FAILED_EXHAUSTED`, `UNKNOWN` e `SKIPPED`. `SKIPPED` não cria tentativa. Falha temporária conhecida usa até três tentativas, com backoff de 1 e 3 segundos e `Retry-After` válido em 429. Timeout ou falha após o transporte sem confirmação levam a `UNKNOWN`; a chave local estável não prova deduplicação externa. `DELIVERED` significa aceitação pelo transporte simulado, não presença em painel real.

Em desenvolvimento ou teste, defina `ENABLE_TEST_SCENARIOS=true` para usar `X-Test-Conversion-Scenario` no webhook: `SUCCESS`, `META_RETRY_ONCE`, `GOOGLE_RATE_LIMIT_ONCE`, `TIKTOK_PERMANENT`, `META_ALWAYS_503`, `META_TIMEOUT` e `GOOGLE_APPLICATION_ERROR`. No Compose, defina a variável antes de `docker compose up` e mantenha `NODE_ENV=development` ou `test` na API. O padrão é `false`; produção rejeita o header. O primeiro evento fixa o cenário. Reenvio explícito com outro cenário recebe 409; novo evento do mesmo pedido conserva os envios existentes. `TRANSPORT_TIMEOUT_MS=2000`, `DELIVERY_LEASE_MS=10000` e `DELIVERY_MAX_ATTEMPTS=3` são os padrões configuráveis. O corpo comercial do webhook não muda.

Os formatos foram orientados pela [documentação de conversões offline do Google](https://developers.google.com/google-ads/api/docs/conversions/upload-offline), pelos [eventos padrão](https://ads.tiktok.com/resources/help/article/standard-events-parameters) e pela [deduplicação do TikTok](https://ads.tiktok.com/help/article/event-deduplication?lang=en), e pelos [parâmetros dinâmicos do RedTrack](https://help.redtrack.io/knowledgebase/kb/conversion-tracking/supported-dynamic-parameters/). A documentação Meta apresentou limitação de acesso e o contrato HTTP da UTMify não foi verificado nesta etapa. Todos os formatos aqui são modelos simulados; uma integração real precisa validar versão, autenticação, campos e política de deduplicação com cada provedor.

## Diagnóstico de suporte

`GET /support/orders/:orderId/tracking` é somente leitura e responde com `Cache-Control: no-store`. Um pedido inexistente, sem webhook, retorna `404 ORDER_NOT_FOUND`. Webhook durável ainda sem pedido retorna `202` com `processingStatus`, eventos, motivo e prazo; falha terminal antes do pedido retorna `200` com `processingStatus: FAILED`. Pedido existente retorna `200`, mesmo enquanto há envios ou outros eventos pendentes. Indisponibilidade do banco retorna `503 SUPPORT_LOOKUP_FAILED`, nunca 404. O `orderId` segue a mesma regra de escrita: texto não vazio, até 128 caracteres, sem formato imposto.

O repositório carrega pedido, snapshot, deliveries, tentativas e eventos com `select` explícito em uma transação PostgreSQL `RepeatableRead`. Assim, um commit do worker durante as consultas não mistura versões de momentos distintos. As relações são carregadas em lote; deliveries saem em ordem alfabética de provedor, tentativas por número e eventos por `receivedAt` e `eventId`. O GET não executa `runOnce`, não envia conversões e não altera o banco.

`attribution.provenance` mantém as strings antigas. Pedidos novos também persistem `attribution.evidence` no mesmo snapshot da compra, por campo usado, com `source`, `sourceId` e `path`. Por exemplo, `identifiers.gclid` pode apontar para `{ "source": "TRACKING_SESSION", "sourceId": "sessao-demo", "path": "identifiers.gclid" }`, enquanto `customFields.affiliateCode` aponta para o `eventId` do webhook se o grupo comercial veio dele. Dados de sessão que chegam depois não mudam a decisão. Para snapshots antigos sem evidência persistida, cada campo não vazio recebe `{ "source": "UNKNOWN", "sourceId": null, "path": null }`; `provenance` legado não é tratado como prova retroativa.

Exemplo resumido com dados fictícios: `order: { orderId: "pedido-demo", amount: 25500, currency: "USD", timeSource: "OCCURRED_AT" }`, `attribution: { method: "SESSION_ID", sessionId: "sessao-demo", customFields: { campaign: "lancamento" }, identifiers: { gclid: "click-demo" }, evidence: { "identifiers.gclid": { source: "TRACKING_SESSION", sourceId: "sessao-demo", path: "identifiers.gclid" } } }`. Uma delivery `GOOGLE` pode estar `DELIVERED` com tentativa `SUCCEEDED`, HTTP 200 e `requestDigest`; outra `META` pode estar `RETRY_PENDING` com HTTP 503. São fatos independentes da campanha e da atribuição.

| Código ou estado | Interpretação no diagnóstico |
| --- | --- |
| `NO_MATCH` | Nenhuma evidência suficiente ligou a venda a uma sessão. |
| `SESSION_NOT_FOUND` | O `sessionId` informado não apareceu até o prazo de espera. |
| `AMBIGUOUS_CUSTOMER_MATCH` | Mais de uma sessão elegível tinha o mesmo cliente; nenhuma foi escolhida. |
| `SESSION_AFTER_ORDER` | A sessão informada foi capturada depois da compra. |
| `MISSING_CLICK_ID` | Google simulado foi ignorado sem gclid, gbraid ou wbraid. |
| `MISSING_REDTRACK_CLICK_ID` | RedTrack simulado foi ignorado sem seu click ID próprio. |
| `MISSING_MATCHING_DATA` | Meta ou TikTok simulados não tinham URL e sinal mínimo de matching. |
| `FAILED_PERMANENT` | O destino rejeitou; consulte HTTP e erro da tentativa. |
| `FAILED_EXHAUSTED` | Falhas temporárias conhecidas consumiram as três tentativas. |
| `UNKNOWN` | A aceitação pode ter ocorrido; timeout ou perda de posse não autorizam retry automático. HTTP pode ser nulo. |
| `PENDING`, `PROCESSING`, `RETRY_PENDING` | Ainda não há entrega confirmada. |
| `DELIVERED` com `SIMULATED` | O transporte simulado aceitou; isso não prova aparição em painel externo. |

O request exibido vem do registro lógico congelado e o digest identifica sua versão anterior à proteção. O sanitizador permite hashes SHA-256 apenas nos caminhos conhecidos de matching da Meta e do TikTok; credenciais com a mesma aparência são ocultadas. URLs, query strings, campos livres e respostas são protegidos e limitados para a saída, sem alterar o payload enviado ou armazenado. Este endpoint é uma ferramenta local de demonstração: a aplicação ainda não tem autenticação e precisa de controle de acesso antes de uso em produção, pois hashes e IDs de tracking são dados sensíveis.

### Consulta pelo terminal

Com a API em execução, `npm run support:order -- pedido-demo` consulta o mesmo GET e organiza o atendimento por situação do pedido, vínculo com a visita, andamento, resultado dos envios e pontos para investigar. Exibe o valor em centavos e entre parênteses na unidade da moeda registrada (por exemplo, `25500 centavos (US$ 255,00)` para USD), sem fazer câmbio. Mostra a origem dos campos e o histórico de tentativas. Use `--show-payload` para incluir requests e respostas já protegidos pela API, ou `--json` para ver a resposta JSON completa. Para outra instância, use `--base-url http://localhost:3000` ou defina `TRACKING_HUB_BASE_URL`. O comando é somente leitura, não conecta diretamente ao banco e encerra com código 1 em erro HTTP ou de conexão. O script usa `tsx` do ambiente de desenvolvimento; requer `npm install`/`npm ci` local.

O relatório de terminal agrupa pedido e atribuição, campos usados com suas evidências, webhook e conversões por provedor. Estados têm destaque de cor em terminais que suportam ANSI; `NO_COLOR` desliga as cores. Os IDs de conversão e digests permanecem completos para investigação.

### Logs no console

A API registra uma linha JSON para cada request e outra para a resposta, ligadas por `requestId`, com método, caminho, status, duração, headers e body. O worker registra as requisições e respostas do transporte simulado por provedor, conversão e número da tentativa; `SKIPPED` também é registrado com o motivo. O conteúdo é sanitizado antes do log: credenciais, cookies de autenticação e contatos em texto puro são ocultados, e campos livres extensos são limitados. Um JSON inválido não tem body parseado para registrar. Veja os dois processos com `docker compose logs -f api worker`; durante desenvolvimento local, os logs aparecem nos terminais de `npm run dev` e `npm run dev:worker`. Esses logs não substituem o histórico persistido de tentativas.
