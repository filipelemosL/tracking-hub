# Arquitetura · Tracking Hub

## Padrão de design
- Monólito modular em Node.js + TypeScript. Express é a camada HTTP exigida pelo enunciado.
- Use cases concentram as regras. Rotas validam entradas e chamam os casos de uso.
- Prisma acessa o PostgreSQL. Um contrato `ConversionProvider` define o envio por adaptadores.
- Docker Compose sobe Postgres, API e um worker sequencial com a mesma imagem da aplicação.
- O banco é a fila persistente. Vitest testa os casos de uso e a integração com PostgreSQL.

## Fluxo e consistência
1. `POST /tracking/sessions` valida, normaliza e persiste a captura.
2. `POST /webhooks/orders` grava o evento original e responde `202` após o commit.
3. O worker resolve a atribuição e grava pedido, snapshot, envios e conclusão do evento em uma transação.
4. Um segundo ciclo envia conversões fora da transação, com transporte simulado e histórico por provedor.
5. `GET /support/orders/:orderId/tracking` expõe decisão, origem por campo e tentativas com dados pessoais protegidos.

## Banco de dados
| Modelo | Chaves e conteúdo |
| --- | --- |
| `TrackingSession` | `sessionId` único, URL, `customFields`, identificadores, referência de cliente e data da captura. |
| `WebhookEvent` | `eventId` único, payload original, estado, recebimento e FK opcional do pedido. |
| `Order` | `orderId` único, centavos inteiros, moeda, FK opcional da sessão e snapshot da atribuição. |
| `ConversionDelivery` | FK do pedido, único por pedido/tipo/provedor, chave estável, status e próxima tentativa. |
| `ConversionAttempt` | FK do envio, único por envio/número, início, status, HTTP, erro e payload protegido. |
- Sessão 1:N pedidos. Pedido 1:N eventos e envios. Envio 1:N tentativas.
- Indexar consultas de trabalho por estado e elegibilidade. Indexar os campos usados nos fallbacks.

## Políticas
- Ordem de atribuição: sessão válida → ID próprio da plataforma → click ID → cliente e janela.
- Fallback só com candidato inequívoco. Ambiguidade sem evidência mais forte deixa a venda sem atribuição.
- Campanha e afiliado vêm de `customFields`. Priorizar os campos de campanha do webhook como grupo. Usar o grupo da sessão quando ausente e registrar conflitos.
- Meta, Google, TikTok, UTMify e RedTrack têm payloads próprios e compartilham o transporte simulado.
- Falha temporária conhecida agenda retry limitado. Erro permanente encerra. Envio concluído é preservado.
- Tentativa iniciada sem confirmação vira resultado incerto para revisão. Restrições locais não garantem deduplicação externa.
- Plano C: executar o mesmo worker no processo da API em instância única, preservando fila, transações e histórico.
