# Arquitetura · Tracking Hub

## Padrão de design
- Monólito modular em Node.js + TypeScript. Express é a camada HTTP exigida pelo enunciado.
- Use cases concentram as regras. Rotas validam entradas e chamam os casos de uso.
- Prisma acessa o PostgreSQL. Um contrato `ConversionProvider` define o envio por adaptadores.
- Docker Compose sobe PostgreSQL, migrator, API e worker. API e worker usam a mesma imagem com comandos distintos; o migrator conclui antes de ambos. O profile `test` oferece um banco isolado.
- O banco é a fila persistente. Vitest testa os casos de uso e a integração com PostgreSQL.

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
