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
4. O envio dos provedores e suas tentativas serão implementados na próxima etapa. Nesta etapa, nenhum envio externo ocorre.
5. `GET /support/orders/:orderId/tracking` expõe o processamento pendente (`202`) ou pedido concluído (`200`), decisão, origem por campo e cinco envios com `attempts: []`. O payload original e dados pessoais não são retornados.

## Banco de dados
| Modelo | Chaves e conteúdo |
| --- | --- |
| `TrackingSession` | `sessionId` único, `visitorId` opcional, URL, `customFields`, identificadores, hashes de cliente, `capturedAt` opcional do cliente e `receivedAt` do backend. |
| `WebhookEvent` | `eventId` único, payload original e normalizado, status, recebimento, prazo de tracking, retry e FK opcional do pedido. |
| `Order` | `orderId` único, centavos em `BIGINT`, moeda, horário e origem, FK opcional da sessão e snapshot da atribuição. |
| `ConversionDelivery` | FK do pedido, único por pedido/tipo/provedor, `conversionId` estável e status `PENDING`. |
| `ConversionAttempt` | Modelo futuro da próxima etapa para histórico de envio. |
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
